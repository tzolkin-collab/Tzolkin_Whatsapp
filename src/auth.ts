import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import type { TenantDirectory } from "./tenants.js";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

/**
 * Minimal, self-contained, STATELESS OAuth 2.1 authorization server for
 * this single deployment. There is no external identity provider and no
 * real user accounts — anyone who can reach the deployment's public URL
 * and click "Autorizar" on the consent page gets a token. This exists only
 * so MCP clients whose "add connector" flow requires OAuth (and won't
 * accept a bare unauthenticated URL) have something to talk to.
 *
 * Why stateless: easypanel (and PaaS deployments in general) may run
 * multiple replicas behind a load balancer, or restart the container
 * between requests. An earlier version of this file kept pending
 * decisions / authorization codes / access tokens in in-memory Maps —
 * that broke as soon as two requests in the same flow landed on different
 * processes ("Decisão expirada ou inválida" even seconds after clicking
 * Allow). Everything here is instead a signed, self-describing token:
 * client registration, the consent decision, the authorization code, and
 * the access token all encode their own state and verify themselves with
 * HMAC-SHA256, using a key derived from EVOLUTION_GLOBAL_KEY (already a
 * shared, deploy-wide secret — no new secret to keep in sync across
 * replicas). No database, no shared cache, no map that only one process
 * remembers.
 *
 * Tradeoffs accepted for a personal single-user tool: authorization codes
 * aren't tracked as single-use (a 5-minute-TTL code could in principle be
 * replayed, but doing so still requires the original PKCE code_verifier,
 * which never leaves the legitimate client) and there's no real token
 * revocation list (tokens just expire after 90 days). Don't reuse this
 * pattern for a multi-tenant service.
 */

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const AUTH_CODE_TTL_SECONDS = 5 * 60; // 5 minutes
const DECISION_TTL_SECONDS = 10 * 60; // 10 minutes

// --- Multi-tenant (optional) ----------------------------------------------
// When TENANTS_JSON is set, the consent page additionally asks for a tenant
// access key, and the resulting token is scoped to that tenant's instances.
// `instances: "*"` marks an admin tenant (full access, including
// create/delete instance). Without TENANTS_JSON everything behaves as
// before: single-tenant, every token has full access.
//
// Example TENANTS_JSON:
//   {"haylander": {"key": "s3gr3d0", "instances": ["haylander-main"]},
//    "admin":     {"key": "outra-chave", "instances": "*"}}

export type TenantConfig = { key: string; instances: "*" | string[] };
export type TenantsConfig = Record<string, TenantConfig>;

export function parseTenantsConfig(raw: string | undefined): TenantsConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TENANTS_JSON não é JSON válido.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TENANTS_JSON deve ser um objeto { tenantId: { key, instances } }.");
  }
  for (const [id, cfg] of Object.entries(parsed as Record<string, any>)) {
    if (typeof cfg?.key !== "string" || cfg.key.length < 8) {
      throw new Error(`TENANTS_JSON: tenant "${id}" precisa de uma "key" string com 8+ caracteres.`);
    }
    if (cfg.instances !== "*" && !(Array.isArray(cfg.instances) && cfg.instances.every((i: any) => typeof i === "string"))) {
      throw new Error(`TENANTS_JSON: tenant "${id}" precisa de "instances" = "*" ou array de nomes.`);
    }
  }
  return parsed as TenantsConfig;
}

/** Constant-time string comparison that doesn't leak length differences. */
export function safeEqualStrings(a: string, b: string): boolean {
  const ha = createHmac("sha256", getSecret()).update(a).digest();
  const hb = createHmac("sha256", getSecret()).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Keyed hash for secrets at rest (tenant access keys in Postgres). */
export function hashSecretString(s: string): string {
  return createHmac("sha256", getSecret()).update(s).digest("hex");
}

function getSecret(): Buffer {
  const globalKey = process.env.EVOLUTION_GLOBAL_KEY || "";
  return createHmac("sha256", "whatsapp-manager-oauth-v1").update(globalKey).digest();
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** Encodes a JSON-serializable payload as a signed, opaque token string. */
function sign(payload: Record<string, unknown>): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", getSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verifies and decodes a token produced by sign(). Throws on any tampering or malformed input. */
function unsign<T>(token: string): T {
  const dot = token.lastIndexOf(".");
  if (dot < 0) throw new Error("malformed token");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", getSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid signature");
  }
  return JSON.parse(b64urlDecode(body)) as T;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- Client registration -----------------------------------------------
// The client's full metadata (including its secret, if any) is encoded
// directly into the client_id string itself, signed. getClient() just
// decodes and verifies — no storage, so registration from one replica is
// immediately recognized by every other replica and survives restarts.

type EncodedClientPayload = Omit<OAuthClientInformationFull, "client_id">;

export class StatelessClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    try {
      const payload = unsign<EncodedClientPayload>(clientId);
      return { ...payload, client_id: clientId };
    } catch {
      return undefined;
    }
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const isPublicClient = client.token_endpoint_auth_method === "none";
    const payload: EncodedClientPayload = {
      ...client,
      client_id_issued_at: nowSeconds(),
      ...(isPublicClient ? {} : { client_secret: b64urlEncode(JSON.stringify(crypto_randomish())) }),
    };
    const client_id = sign(payload);
    return { ...payload, client_id };
  }
}

// Small helper so we don't need a second import just for a few random
// bytes when minting a client_secret for confidential clients.
function crypto_randomish(): string {
  return `${Date.now()}-${Math.random()}-${Math.random()}`;
}

// --- Provider ------------------------------------------------------------

type DecisionPayload = {
  kind: "decision";
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  state?: string;
  exp: number;
};

type CodePayload = {
  kind: "code";
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  exp: number;
  tenantId?: string;
  instances?: "*" | string[];
};

type AccessTokenPayload = {
  kind: "access";
  clientId: string;
  scopes: string[];
  resource?: string;
  exp: number;
  tenantId?: string;
  instances?: "*" | string[];
  /** Present when a TenantDirectory records tokens — enables revocation. */
  jti?: string;
};

export class WhatsAppOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly directory: TenantDirectory | null;

  constructor(clientsStore: OAuthRegisteredClientsStore, directory: TenantDirectory | null = null) {
    this.clientsStore = clientsStore;
    this.directory = directory;
  }

  // Renders a one-button consent page instead of auto-approving. There's no
  // real login here (no accounts to log into) — this is the only checkpoint
  // before a client gets a token, so it stays an explicit click rather than
  // a silent redirect. The page carries all state needed to finish the
  // flow as a signed hidden field — nothing is remembered server-side.
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const decisionToken = sign({
      kind: "decision",
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString(),
      state: params.state,
      exp: nowSeconds() + DECISION_TTL_SECONDS,
    } satisfies DecisionPayload);

    const appName = client.client_name || client.client_id;
    // In multi-tenant mode the consent page doubles as the login step: the
    // tenant access key typed here decides which instances the token can
    // touch. Without tenants configured there is nothing to type — one
    // click, full access, as before.
    const tenantField = this.directory?.requiresKey
      ? `<label for="tenantKey">Chave de acesso do tenant</label>
      <input type="password" id="tenantKey" name="tenantKey" required autocomplete="off" placeholder="Chave fornecida pela Tzolkin">`
      : "";
    res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Autorizar conector WhatsApp</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f1efe8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 420px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #555; font-size: 14px; line-height: 1.5; }
  label { display: block; font-size: 13px; color: #333; margin: 16px 0 4px; }
  input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button { flex: 1; padding: 10px 16px; border-radius: 8px; border: none; font-size: 14px; cursor: pointer; }
  .allow { background: #16a766; color: #fff; }
  .deny { background: #f1efe8; color: #333; }
</style>
</head>
<body>
  <div class="card">
    <h1>Autorizar conector WhatsApp</h1>
    <p><strong>${escapeHtml(appName)}</strong> está pedindo acesso ao servidor MCP do WhatsApp (Evolution API) — list_instances, send_text, send_media e demais ferramentas.</p>
    <form method="POST" action="/authorize/decision">
      <input type="hidden" name="decisionToken" value="${decisionToken}">
      ${tenantField}
      <div class="actions">
        <button class="deny" name="decision" value="deny" type="submit">Negar</button>
        <button class="allow" name="decision" value="allow" type="submit">Autorizar</button>
      </div>
    </form>
  </div>
</body>
</html>`);
  }

  // Called by the POST /authorize/decision route (wired up in index.ts,
  // outside the SDK's router) once the user clicks Allow/Deny.
  async resolveDecision(
    decisionToken: string,
    allow: boolean,
    tenantKey?: string
  ): Promise<{ redirectUrl: string }> {
    let decision: DecisionPayload;
    try {
      decision = unsign<DecisionPayload>(decisionToken);
    } catch {
      throw new Error(
        "Decisão inválida ou corrompida — peça pro cliente MCP iniciar a autorização de novo."
      );
    }
    if (decision.kind !== "decision" || decision.exp < nowSeconds()) {
      throw new Error("Decisão expirada — peça pro cliente MCP iniciar a autorização de novo.");
    }

    const redirect = new URL(decision.redirectUri);
    // Per OAuth 2.1, state must be echoed back on both the success and
    // error redirect when the client sent one — Claude's own callback
    // validates this and rejects the redirect otherwise ("state: Field
    // required"), so this isn't optional even though AuthorizationParams
    // types it as such.
    if (decision.state) redirect.searchParams.set("state", decision.state);

    if (!allow) {
      redirect.searchParams.set("error", "access_denied");
      return { redirectUrl: redirect.toString() };
    }

    // Multi-tenant mode: the access key typed on the consent page picks the
    // tenant. Validated here (not on authorize) so a wrong key never mints
    // a code. Denials above don't need a key.
    let tenantId: string | undefined;
    let instances: "*" | string[] | undefined;
    if (this.directory) {
      const scope = await this.directory.validateKey(tenantKey);
      if (!scope) {
        throw new Error("Chave de acesso inválida — confira a chave do seu tenant e tente de novo.");
      }
      tenantId = scope.tenantId;
      instances = scope.instances;
    }

    const code = sign({
      kind: "code",
      clientId: decision.clientId,
      redirectUri: decision.redirectUri,
      codeChallenge: decision.codeChallenge,
      scopes: decision.scopes,
      resource: decision.resource,
      exp: nowSeconds() + AUTH_CODE_TTL_SECONDS,
      tenantId,
      instances,
    } satisfies CodePayload);

    redirect.searchParams.set("code", code);
    return { redirectUrl: redirect.toString() };
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const entry = this.decodeCode(authorizationCode, client.client_id);
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const entry = this.decodeCode(authorizationCode, client.client_id);
    if (redirectUri && entry.redirectUri !== redirectUri) {
      throw new InvalidGrantError("redirect_uri não bate com o usado na autorização");
    }

    const exp = nowSeconds() + ACCESS_TOKEN_TTL_SECONDS;

    // With a directory, every token gets a jti recorded at mint time so it
    // can be revoked and so DB-backed scope stays live (suspend a tenant →
    // its tokens stop working on the next request).
    let jti: string | undefined;
    if (this.directory && entry.tenantId) {
      jti = randomUUID();
      // client_id aqui é um blob assinado gigante (StatelessClientsStore) —
      // para exibição no painel, grava o nome amigável do app.
      const clientLabel = client.client_name || "Aplicativo MCP";
      await this.directory.registerToken(jti, entry.tenantId, clientLabel, exp);
    }

    const accessToken = sign({
      kind: "access",
      clientId: client.client_id,
      scopes: entry.scopes,
      resource: (resource ?? entry.resource)?.toString(),
      exp,
      tenantId: entry.tenantId,
      instances: entry.instances,
      jti,
    } satisfies AccessTokenPayload);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: entry.scopes.join(" ") || undefined,
      // No refresh_token issued — tokens are long-lived (90 days) and the
      // user can just re-run the authorize flow when one expires.
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    // Never issued, so a well-behaved client should never call this.
    throw new InvalidGrantError("Refresh tokens não são emitidos por este servidor — reautorize.");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let entry: AccessTokenPayload;
    try {
      entry = unsign<AccessTokenPayload>(token);
    } catch {
      throw new InvalidGrantError("Access token inválido ou corrompido");
    }
    if (entry.kind !== "access" || entry.exp < nowSeconds()) {
      throw new InvalidGrantError("Access token expirado — reautorize");
    }

    // With a directory the scope is resolved live (DB mode: revocation +
    // suspension + instance edits apply immediately; env mode: echoes the
    // scope baked into the token).
    let extra: Record<string, unknown> | undefined;
    if (this.directory) {
      let scope;
      try {
        scope = await this.directory.resolveTokenScope(entry);
      } catch (err: any) {
        throw new InvalidGrantError(err.message || "Token sem tenant válido — reautorize");
      }
      extra = { tenantId: scope.tenantId, instances: scope.instances };
    }

    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.exp,
      resource: entry.resource ? new URL(entry.resource) : undefined,
      // Tool handlers read this to scope instance access per tenant.
      extra,
    };
  }

  // RFC 7009: revocation always "succeeds" — unknown/foreign tokens are
  // silently ignored. Only DB-backed directories can actually kill a token
  // (env-mode tokens are stateless and just expire).
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: { token: string }
  ): Promise<void> {
    if (!this.directory) return;
    try {
      const entry = unsign<AccessTokenPayload>(request.token);
      if (entry.kind === "access") {
        await this.directory.revokeToken(entry);
      }
    } catch {
      // Invalid/foreign token: nothing to revoke.
    }
  }

  private decodeCode(code: string, expectedClientId: string): CodePayload {
    let entry: CodePayload;
    try {
      entry = unsign<CodePayload>(code);
    } catch {
      throw new InvalidGrantError("Authorization code inválido ou corrompido");
    }
    if (entry.kind !== "code" || entry.exp < nowSeconds()) {
      throw new InvalidGrantError("Authorization code expirado");
    }
    if (entry.clientId !== expectedClientId) {
      throw new InvalidGrantError("Authorization code emitido para outro client");
    }
    return entry;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// --- QR pairing links ------------------------------------------------------
// connect_instance hands out a short-lived signed link to a browser page
// that renders (and auto-refreshes) the pairing QR. The link is its own
// bearer credential — same stateless HMAC scheme as everything above, so it
// works across replicas and restarts with no storage.

const QR_LINK_TTL_SECONDS = 10 * 60;

type QrLinkPayload = { kind: "qr"; instanceName: string; exp: number };

export function createQrLinkToken(instanceName: string): string {
  return sign({
    kind: "qr",
    instanceName,
    exp: nowSeconds() + QR_LINK_TTL_SECONDS,
  } satisfies QrLinkPayload);
}

/** Returns the instanceName the link was minted for. Throws if invalid or expired. */
export function verifyQrLinkToken(token: string): string {
  let payload: QrLinkPayload;
  try {
    payload = unsign<QrLinkPayload>(token);
  } catch {
    throw new Error("Link de QR inválido — rode connect_instance de novo para gerar outro.");
  }
  if (payload.kind !== "qr" || payload.exp < nowSeconds()) {
    throw new Error("Link de QR expirado — rode connect_instance de novo para gerar outro.");
  }
  return payload.instanceName;
}
