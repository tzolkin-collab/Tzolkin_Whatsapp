#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomUUID } from "crypto";
import { pathToFileURL, fileURLToPath } from "url";
import path from "path";
import express from "express";
import { z } from "zod";
import dotenv from "dotenv";
import pg from "pg";
import { EvolutionClient } from "./client.js";
import {
  StatelessClientsStore,
  WhatsAppOAuthProvider,
  createQrLinkToken,
  verifyQrLinkToken,
  escapeHtml,
  parseTenantsConfig,
  safeEqualStrings,
} from "./auth.js";
import {
  DbTenantDirectory,
  EnvTenantDirectory,
  type TenantDirectory,
} from "./tenants.js";
import { AsaasClient } from "./asaas.js";

// Load environment variables for local testing
dotenv.config();

const apiUrl = process.env.EVOLUTION_API_URL;
const globalKey = process.env.EVOLUTION_GLOBAL_KEY;
// The externally reachable base URL of THIS server (not Evolution's URL).
// Needed as the OAuth issuer/resource identifier — clients fetch
// <PUBLIC_URL>/.well-known/oauth-authorization-server during discovery, so
// it must be the exact public address, e.g. https://your-app.easypanel.host
const publicUrl = process.env.PUBLIC_URL;

if (!apiUrl || !globalKey) {
  console.error(
    "Error: EVOLUTION_API_URL and EVOLUTION_GLOBAL_KEY environment variables are required."
  );
  process.exit(1);
}

if (!publicUrl) {
  console.error(
    "Error: PUBLIC_URL environment variable is required (the externally reachable base URL of this deployment, e.g. https://your-app.easypanel.host) — used as the OAuth issuer."
  );
  process.exit(1);
}

// Initialize the Evolution API client
const client = new EvolutionClient(apiUrl, globalKey);

// The active tenant directory (null = legacy single-tenant, full access).
// Set once by createApp() before any request is served; module-level so the
// tool handlers in createServer() can reach it.
let directory: TenantDirectory | null = null;

// --- Tenant scoping helpers -------------------------------------------------
// Tool handlers receive the verified AuthInfo via `extra.authInfo` (the
// transports forward req.auth). In single-tenant mode everything is allowed;
// with a directory the AuthInfo carries the live instance allowlist
// (resolved by verifyAccessToken — DB mode reflects suspensions instantly).

function allowedInstances(extra: { authInfo?: AuthInfo }): "*" | string[] {
  if (!directory) return "*";
  const instances = extra.authInfo?.extra?.instances;
  if (instances === "*") return "*";
  if (Array.isArray(instances)) return instances as string[];
  // Multi-tenant mode but the token predates it (no tenant claim): no access.
  return [];
}

function assertInstanceAllowed(extra: { authInfo?: AuthInfo }, instanceName: string): void {
  const allowed = allowedInstances(extra);
  if (allowed === "*" || allowed.includes(instanceName)) return;
  throw new Error(
    `Acesso negado: a instância "${instanceName}" não pertence a este tenant. Instâncias permitidas: ${allowed.join(", ") || "(nenhuma)"}.`
  );
}

function assertAdmin(extra: { authInfo?: AuthInfo }, action: string): void {
  if (allowedInstances(extra) === "*") return;
  throw new Error(`Acesso negado: "${action}" requer um tenant admin (instances: "*").`);
}

// Helper for error formatting in tool responses
const wrapResult = async (fn: () => Promise<any>) => {
  try {
    const result = await fn();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text" as const, text: error.message || "Unknown error occurred" }],
      isError: true,
    };
  }
};

// A McpServer instance can only ever be connect()-ed to one transport. With
// SSE, every browser/client tab that hits GET /sse is a new connection, so
// we must build a fresh server (with its tools re-registered) per connection
// instead of reusing one module-level instance — reusing one throws
// "Already connected to a transport" on the second connection.
function createServer(): McpServer {
  const server = new McpServer({
    name: "whatsapp-evolution-mcp",
    version: "1.0.0",
  });

  // --- 1. INSTANCE MANAGEMENT TOOLS ---

  server.tool(
    "list_instances",
    "List all WhatsApp instances configured on the server and their status.",
    {},
    async (_args, extra) => {
      return wrapResult(async () => {
        const data = await client.listInstances();
        const allowed = allowedInstances(extra);
        if (allowed === "*" || !Array.isArray(data)) return data;
        return data.filter((item: any) => {
          const name = item?.name ?? item?.instance?.instanceName;
          return typeof name === "string" && allowed.includes(name);
        });
      });
    }
  );

  server.tool(
    "create_instance",
    "Create a new WhatsApp instance on the Evolution server. Two integrations: WHATSAPP-BAILEYS (default — pairs the user's existing number via QR code) and WHATSAPP-BUSINESS (official Meta Cloud API — no QR; requires the Meta permanent token, phone number ID and businessId/WABA).",
    {
      instanceName: z.string().describe("The unique name for the instance (alphanumeric, no spaces)"),
      token: z.string().optional().describe("Baileys: optional custom apikey for the instance. Business: the Meta Cloud API permanent access token (required)."),
      number: z.string().optional().describe("Baileys: optional phone number. Business: the Meta phone number ID (required)."),
      qrcode: z.boolean().optional().describe("Whether to return QR Code in the response (default: true; Baileys only)"),
      integration: z.enum(["WHATSAPP-BAILEYS", "WHATSAPP-BUSINESS"]).optional().describe("Integration type (default: WHATSAPP-BAILEYS)"),
      businessId: z.string().optional().describe("WhatsApp Business Account ID (WABA) — required for WHATSAPP-BUSINESS."),
    },
    async (args, extra) => {
      return wrapResult(() => {
        assertAdmin(extra, "create_instance");
        if (args.integration === "WHATSAPP-BUSINESS" && (!args.token || !args.number || !args.businessId)) {
          throw new Error(
            "WHATSAPP-BUSINESS (Cloud API oficial) exige token (Meta permanent token), number (phone number ID) e businessId (WABA)."
          );
        }
        return client.createInstance(args);
      });
    }
  );

  server.tool(
    "delete_instance",
    "Delete a WhatsApp instance from the server.",
    {
      instanceName: z.string().describe("The name of the instance to delete"),
    },
    async ({ instanceName }, extra) => {
      return wrapResult(() => {
        assertAdmin(extra, "delete_instance");
        return client.deleteInstance(instanceName);
      });
    }
  );

  server.tool(
    "logout_instance",
    "Logout a WhatsApp instance (disconnects WhatsApp session but keeps the instance definition).",
    {
      instanceName: z.string().describe("The name of the instance to logout"),
    },
    async ({ instanceName }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.logoutInstance(instanceName);
      });
    }
  );

  server.tool(
    "connect_instance",
    "Retrieve connection information, status, or QR Code for pairing. Returns the QR as an inline image plus qrPageUrl — a browser page that auto-refreshes the code (WhatsApp rotates it every ~20s), so point the user there to scan.",
    {
      instanceName: z.string().describe("The name of the instance to connect"),
    },
    async ({ instanceName }, extra) => {
      try {
        assertInstanceAllowed(extra, instanceName);
        const result = await client.connectInstance(instanceName);
        const qrToken = createQrLinkToken(instanceName);
        const qrPageUrl = `${publicUrl}/qr/${encodeURIComponent(instanceName)}?t=${encodeURIComponent(qrToken)}`;

        const content: Array<
          | { type: "image"; data: string; mimeType: string }
          | { type: "text"; text: string }
        > = [];

        const base64: unknown = result?.base64;
        if (typeof base64 === "string" && base64.length > 0) {
          content.push({
            type: "image",
            data: base64.replace(/^data:image\/\w+;base64,/, ""),
            mimeType: "image/png",
          });
        }

        // Strip the base64 blob from the text payload — dumped as text it
        // floods the context and no MCP client renders it as a scannable QR.
        const { base64: _omitted, ...rest } = (result ?? {}) as Record<string, unknown>;
        content.push({
          type: "text",
          text: JSON.stringify(
            {
              ...rest,
              qrPageUrl,
              hint: "Abra qrPageUrl no navegador para escanear — a página atualiza o QR sozinha a cada 20s. Link válido por 10 minutos.",
            },
            null,
            2
          ),
        });

        return { content };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: error.message || "Unknown error occurred" }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_instance_status",
    "Get the current connection status (CONNECTED, DISCONNECTED, etc.) of an instance.",
    {
      instanceName: z.string().describe("The name of the instance to check"),
    },
    async ({ instanceName }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.getInstanceStatus(instanceName);
      });
    }
  );

  server.tool(
    "get_messages",
    "Fetch message history for an instance (requires Evolution API database enabled). Filters by contact (remoteJid) and paginates (page + pageSize) server-side. Response: { messages: { total, pages, currentPage, records } }.",
    {
      instanceName: z.string().describe("The name of the instance"),
      remoteJid: z.string().optional().describe("Contact JID to scope to a single chat (e.g. 5511999999999@s.whatsapp.net). Filtered server-side via where.key.remoteJid; omit for all chats."),
      page: z.number().int().positive().optional().describe("1-based page number (default 1). Increment to walk back through history."),
      pageSize: z.number().int().positive().optional().describe("Messages per page (default 20). Maps to Evolution's `offset`."),
    },
    async ({ instanceName, remoteJid, page, pageSize }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.getMessages(instanceName, { remoteJid, page, pageSize });
      });
    }
  );

  // --- 2. MESSAGING TOOLS ---

  server.tool(
    "send_text",
    "Send a text message to a WhatsApp contact or group.",
    {
      instanceName: z.string().describe("The instance name to send from"),
      number: z.string().describe("Recipient phone number with country/area code (e.g., 5511999999999) or group JID (e.g. 12036304@g.us)"),
      text: z.string().describe("Message text content"),
      delay: z.number().optional().describe("Delay in milliseconds before sending (e.g. 1000)"),
      presence: z.enum(["composing", "recording", "paused"]).optional().describe("Simulate typing presence status while waiting to send"),
      linkPreview: z.boolean().optional().describe("Whether to enable link previews in the message (default: false)"),
    },
    async ({ instanceName, number, text, delay, presence, linkPreview }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.sendText(instanceName, {
          number,
          text,
          options: { delay, presence, linkPreview },
        });
      });
    }
  );

  server.tool(
    "send_media",
    "Send an image, video, audio file, or document via URL or base64.",
    {
      instanceName: z.string().describe("The instance name to send from"),
      number: z.string().describe("Recipient phone number (e.g., 5511999999999) or group JID"),
      mediatype: z.enum(["image", "video", "audio", "document"]).describe("The type of media being sent"),
      media: z.string().describe("Public URL of the media file or Base64 string of the file"),
      caption: z.string().optional().describe("Caption message to accompany the media (applicable for images and videos)"),
      fileName: z.string().optional().describe("Override file name (highly recommended for document type)"),
      delay: z.number().optional().describe("Delay in milliseconds before sending"),
      presence: z.enum(["composing", "recording", "paused"]).optional().describe("Simulate typing/recording presence status"),
    },
    async ({ instanceName, number, mediatype, media, caption, fileName, delay, presence }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.sendMedia(instanceName, {
          number,
          mediaMessage: {
            mediatype,
            media,
            caption,
            fileName,
          },
          options: { delay, presence },
        });
      });
    }
  );

  // --- 3. TYPEBOT INTEGRATION TOOLS ---

  server.tool(
    "configure_typebot",
    "Enable and configure Typebot chatbot integration on an instance.",
    {
      instanceName: z.string().describe("The instance name to configure"),
      enabled: z.boolean().describe("Whether to enable (true) or disable (false) Typebot on this instance"),
      url: z.string().describe("Typebot server viewer base URL (e.g., https://app.typebot.io or self-hosted URL)"),
      typebot: z.string().describe("Name/Slug or ID of the Typebot flow to associate"),
      expire: z.number().optional().describe("Session expiration time in seconds (default: 1200 / 20 mins)"),
      keywordFinish: z.string().optional().describe("Keyword message to finish the bot session (e.g., #SAIR or #EXIT)"),
      delayMessage: z.number().optional().describe("Delay in milliseconds between bot messages (default: 1000)"),
      unknownMessage: z.string().optional().describe("Response to send if the bot doesn't recognize input"),
      listeningFromMe: z.boolean().optional().describe("If true, chatbot processes messages sent by the device owner too"),
      stopBotFromMe: z.boolean().optional().describe("If true, sending a manual message from the device device stops the chatbot session"),
      keepOpen: z.boolean().optional().describe("Keep session open after finishing"),
    },
    async ({ instanceName, ...payload }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.configureTypebot(instanceName, payload);
      });
    }
  );

  server.tool(
    "get_typebot_settings",
    "Retrieve the Typebot integration settings for an instance.",
    {
      instanceName: z.string().describe("The instance name to query"),
    },
    async ({ instanceName }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.getTypebotSettings(instanceName);
      });
    }
  );

  server.tool(
    "change_typebot_status",
    "Change the Typebot session status (open, pause, or close) for a specific contact.",
    {
      instanceName: z.string().describe("The instance name"),
      remoteJid: z.string().describe("The remote contact JID (e.g., 5511999999999@s.whatsapp.net)"),
      status: z.enum(["opened", "paused", "closed"]).describe("The new status for the typebot session"),
    },
    async ({ instanceName, remoteJid, status }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.changeTypebotStatus(instanceName, { remoteJid, status });
      });
    }
  );

  server.tool(
    "start_typebot_flow",
    "Manually trigger a Typebot flow start for a specific WhatsApp contact.",
    {
      instanceName: z.string().describe("The instance name"),
      url: z.string().describe("Typebot server URL"),
      typebot: z.string().describe("Typebot flow name or ID"),
      remoteJid: z.string().describe("The remote contact JID (e.g., 5511999999999@s.whatsapp.net)"),
      startSession: z.boolean().optional().describe("Start a fresh session (default: true)"),
      variables: z.array(
        z.object({
          name: z.string(),
          value: z.string(),
        })
      ).optional().describe("Initial variables to pass to the Typebot flow"),
    },
    async ({ instanceName, ...payload }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.startTypebotFlow(instanceName, payload);
      });
    }
  );

  // --- 4. WEBHOOK TOOLS ---

  server.tool(
    "configure_webhook",
    "Configure webhooks to receive real-time events from an instance.",
    {
      instanceName: z.string().describe("The instance name"),
      enabled: z.boolean().describe("Whether to enable (true) or disable (false) webhooks"),
      url: z.string().describe("The destination URL to send POST webhooks to"),
      events: z.array(z.string()).describe("List of events to subscribe to (e.g., ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'SEND_MESSAGE'])"),
    },
    async ({ instanceName, ...payload }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.configureWebhook(instanceName, payload);
      });
    }
  );

  server.tool(
    "get_webhook_settings",
    "Retrieve the configured webhook settings for a specific instance.",
    {
      instanceName: z.string().describe("The instance name to query"),
    },
    async ({ instanceName }, extra) => {
      return wrapResult(() => {
        assertInstanceAllowed(extra, instanceName);
        return client.getWebhookSettings(instanceName);
      });
    }
  );

  return server;
}

// Builds the Express app for a given tenant directory. Exported so tests
// can wire an in-memory Postgres (pg-mem) without touching the network env.
export function createApp(dir: TenantDirectory | null): express.Express {
  directory = dir;

  // Single shared OAuth provider for the whole process — every connection
  // reuses it (only the McpServer itself needs to be per-connection, see
  // createServer() above).
  const oauthProvider = new WhatsAppOAuthProvider(new StatelessClientsStore(), dir);

  const app = express();

  // Landing page (public/): the product's sales page lives on the same
  // domain the connector runs on — GET / was unused. Static files only;
  // nothing here is auth-protected.
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
  app.use(express.static(publicDir));

  // Mounts /authorize, /token, /register, /revoke,
  // /.well-known/oauth-authorization-server and
  // /.well-known/oauth-protected-resource. Must be installed at the app
  // root per the SDK's own doc comment, and before express.json() below
  // (the auth handlers parse bodies themselves).
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(publicUrl!),
      resourceName: "WhatsApp Evolution MCP",
      scopesSupported: ["whatsapp"],
    })
  );

  // Consent screen submits here. Not part of the SDK router — this is the
  // human-in-the-loop step before authorize() hands back a code.
  app.post("/authorize/decision", express.urlencoded({ extended: false }), async (req, res) => {
    const decisionToken = req.body?.decisionToken as string | undefined;
    const allow = req.body?.decision === "allow";
    const tenantKey = req.body?.tenantKey as string | undefined;
    if (!decisionToken) {
      res.status(400).send("Missing decisionToken");
      return;
    }
    try {
      const { redirectUrl } = await oauthProvider.resolveDecision(decisionToken, allow, tenantKey);
      res.redirect(redirectUrl);
    } catch (err: any) {
      res.status(400).send(err.message || "Decisão inválida");
    }
  });


  // Browser-facing QR pairing page. connect_instance mints a signed,
  // short-lived link to this page; the page re-fetches the QR image every
  // 20s (WhatsApp rotates pairing codes), so the code on screen is always
  // scannable without opening Evolution's manager UI.
  app.get("/qr/:instanceName", (req, res) => {
    const token = (req.query.t as string) || "";
    let instanceName: string;
    try {
      instanceName = verifyQrLinkToken(token);
    } catch (err: any) {
      res.status(410).send(err.message || "Link inválido");
      return;
    }
    if (instanceName !== req.params.instanceName) {
      res.status(410).send("Link não corresponde a esta instância.");
      return;
    }

    const imageUrl = `/qr/${encodeURIComponent(instanceName)}/image?t=${encodeURIComponent(token)}`;
    res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parear WhatsApp — ${escapeHtml(instanceName)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f1efe8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 380px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #555; font-size: 14px; line-height: 1.5; }
  img { width: 264px; height: 264px; image-rendering: pixelated; }
  .status { font-size: 13px; color: #777; min-height: 1.2em; }
  .ok { color: #16a766; font-weight: 600; }
  .err { color: #c0392b; }
</style>
</head>
<body>
  <div class="card">
    <h1>Parear WhatsApp — ${escapeHtml(instanceName)}</h1>
    <p>No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho, e escaneie o código abaixo.</p>
    <img id="qr" alt="QR Code" style="display:none">
    <p class="status" id="status">Carregando QR…</p>
  </div>
<script>
  const imageUrl = ${JSON.stringify(imageUrl)};
  const img = document.getElementById("qr");
  const statusEl = document.getElementById("status");
  const timer = setInterval(refresh, 20000);
  async function refresh() {
    try {
      const r = await fetch(imageUrl, { cache: "no-store" });
      if (r.status === 200) {
        const blob = await r.blob();
        const old = img.src;
        img.src = URL.createObjectURL(blob);
        if (old) URL.revokeObjectURL(old);
        img.style.display = "";
        statusEl.textContent = "O QR atualiza sozinho a cada 20s.";
        statusEl.className = "status";
      } else if (r.status === 204) {
        clearInterval(timer);
        img.style.display = "none";
        statusEl.textContent = "✅ Conectado! Pode fechar esta página.";
        statusEl.className = "status ok";
      } else if (r.status === 410) {
        clearInterval(timer);
        statusEl.textContent = "Link expirado — rode connect_instance de novo para gerar outro.";
        statusEl.className = "status err";
      } else {
        statusEl.textContent = "Erro ao obter o QR (" + r.status + ") — tentando de novo…";
        statusEl.className = "status err";
      }
    } catch {
      statusEl.textContent = "Falha de rede — tentando de novo…";
      statusEl.className = "status err";
    }
  }
  refresh();
</script>
</body>
</html>`);
  });

  app.get("/qr/:instanceName/image", async (req, res) => {
    const token = (req.query.t as string) || "";
    let instanceName: string;
    try {
      instanceName = verifyQrLinkToken(token);
    } catch {
      res.status(410).end();
      return;
    }
    if (instanceName !== req.params.instanceName) {
      res.status(410).end();
      return;
    }
    try {
      const result = await client.connectInstance(instanceName);
      const base64: unknown = result?.base64;
      if (typeof base64 !== "string" || base64.length === 0) {
        // No QR in the response — Evolution only omits it when the instance
        // is already connected. 204 tells the page to show the success state.
        res.status(204).end();
        return;
      }
      const png = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
      res.set("Content-Type", "image/png").set("Cache-Control", "no-store").send(png);
    } catch (err: any) {
      res.status(502).send(err.message || "Erro ao consultar a Evolution API");
    }
  });

  // No requiredScopes: this server has a single purpose (WhatsApp tools),
  // there's no partial-access tier to gate behind a scope, and several MCP
  // clients don't pass `scope` in the /authorize request at all — requiring
  // one would lock them out for no real benefit. "whatsapp" in
  // scopesSupported above is informational only.
  const customAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      // POST /messages with a known sessionId: the session was authenticated
      // when /sse was opened, so inherit that connection's AuthInfo instead
      // of requiring the bearer token on every POST (some clients omit it).
      if (req.path === '/messages' && req.query.sessionId) {
        const sessionId = req.query.sessionId as string;
        const session = sseSessions.get(sessionId);
        if (session) {
          (req as any).auth = session.authInfo;
          return next();
        }
      }

      let token = req.query.token as string;
      if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
          token = authHeader.split(' ')[1];
        }
      }
      if (!token) {
        res.status(401).json({ error: "invalid_token", error_description: "Missing token" });
        return;
      }
      const authInfo = await oauthProvider.verifyAccessToken(token);
      (req as any).auth = authInfo;
      next();
    } catch (err: any) {
      res.status(401).json({ error: "invalid_token", error_description: err.message });
    }
  };

  // One transport per SSE connection, keyed by the sessionId the SDK embeds
  // in the "endpoint" event it sends on connect (/messages?sessionId=...).
  // A single shared variable here would let a second client's connection
  // silently steal routing for POST /messages away from the first. The
  // AuthInfo captured at connect time travels with the session so tenant
  // scoping applies to every message on it.
  const sseSessions = new Map<string, { transport: SSEServerTransport; authInfo?: AuthInfo }>();

  app.get("/sse", customAuth, async (req, res) => {
    console.log("New SSE connection established");
    const messagesUrl = new URL("/messages", publicUrl!).href;
    const transport = new SSEServerTransport(messagesUrl, res);
    sseSessions.set(transport.sessionId, { transport, authInfo: (req as any).auth });

    res.on("close", () => {
      sseSessions.delete(transport.sessionId);
    });

    // Fresh server per connection — see createServer() comment above.
    const server = createServer();
    await server.connect(transport);
  });

  app.post("/messages", customAuth, async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const session = sessionId ? sseSessions.get(sessionId) : undefined;
    if (!session) {
      res.status(503).send("No active SSE transport for this sessionId — open /sse first");
      return;
    }
    await session.transport.handlePostMessage(req, res);
  });

  // --- Streamable HTTP transport (current MCP spec; SSE above is legacy) ---
  // Sessions live in memory keyed by the mcp-session-id header the SDK
  // negotiates on initialize. Same single-process limitation as SSE — fine
  // for the current single-replica deploy.
  const httpSessions = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", customAuth, express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? httpSessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method === "POST" && isInitializeRequest(req.body)) {
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            httpSessions.set(sid, newTransport);
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) httpSessions.delete(newTransport.sessionId);
        };
        const server = createServer();
        await server.connect(newTransport);
        transport = newTransport;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: unknown or missing mcp-session-id — send an initialize request first" },
          id: null,
        });
        return;
      }
    }

    await transport.handleRequest(req, res, req.body);
  });

  // --- Admin API + Asaas billing (Postgres mode only) ----------------------
  if (dir instanceof DbTenantDirectory) {
    const adminKey = process.env.ADMIN_API_KEY;
    const asaas = process.env.ASAAS_API_KEY ? new AsaasClient(process.env.ASAAS_API_KEY) : null;

    if (adminKey) {
      const adminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const key = req.headers["x-admin-key"];
        if (typeof key === "string" && safeEqualStrings(key, adminKey)) return next();
        res.status(401).json({ error: "unauthorized" });
      };
      const admin = express.Router();
      admin.use(adminAuth, express.json());

      // Provision a tenant. Returns the access key ONCE (only the hash is
      // stored). With `billing`, also creates the Asaas customer +
      // subscription so the payment webhook can manage the tenant's status.
      admin.post("/tenants", async (req, res) => {
        try {
          const { id, name, instances, admin: isAdmin, billing } = req.body ?? {};
          if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(instances)) {
            res.status(400).json({ error: "Campos obrigatórios: id (slug), name, instances (array)." });
            return;
          }
          const { accessKey } = await dir.createTenant({ id, name, instances, isAdmin: isAdmin === true });

          let asaasInfo: Record<string, string> | undefined;
          if (billing) {
            if (!asaas) {
              res.status(201).json({
                id,
                accessKey,
                warning: "Tenant criado, mas ASAAS_API_KEY não está configurada — billing ignorado.",
              });
              return;
            }
            const customer = await asaas.createCustomer({
              name: billing.name ?? name,
              cpfCnpj: billing.cpfCnpj,
              email: billing.email,
              mobilePhone: billing.mobilePhone,
            });
            const subscription = await asaas.createSubscription({
              customerId: customer.id,
              value: billing.value,
              cycle: billing.cycle,
              billingType: billing.billingType,
              nextDueDate: billing.nextDueDate,
              description: billing.description,
            });
            await dir.updateTenant(id, {
              asaasCustomerId: customer.id,
              asaasSubscriptionId: subscription.id,
            });
            asaasInfo = { customerId: customer.id, subscriptionId: subscription.id };
          }

          res.status(201).json({ id, accessKey, asaas: asaasInfo });
        } catch (err: any) {
          res.status(400).json({ error: err.message });
        }
      });

      admin.get("/tenants", async (_req, res) => {
        try {
          res.json(await dir.listTenants());
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      });

      admin.patch("/tenants/:id", async (req, res) => {
        try {
          const { name, instances, admin: isAdmin, status } = req.body ?? {};
          const ok = await dir.updateTenant(req.params.id, {
            name,
            instances,
            isAdmin,
            status,
          });
          if (!ok) {
            res.status(404).json({ error: "Tenant não encontrado ou nada a atualizar." });
            return;
          }
          res.json({ updated: true });
        } catch (err: any) {
          res.status(400).json({ error: err.message });
        }
      });

      admin.post("/tenants/:id/rotate-key", async (req, res) => {
        try {
          const rotated = await dir.rotateKey(req.params.id);
          if (!rotated) {
            res.status(404).json({ error: "Tenant não encontrado." });
            return;
          }
          res.json({ id: req.params.id, accessKey: rotated.accessKey });
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      });

      admin.post("/tenants/:id/revoke-tokens", async (req, res) => {
        try {
          const revoked = await dir.revokeAllTokens(req.params.id);
          res.json({ id: req.params.id, revokedTokens: revoked });
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      });

      admin.delete("/tenants/:id", async (req, res) => {
        try {
          const ok = await dir.deleteTenant(req.params.id);
          if (!ok) {
            res.status(404).json({ error: "Tenant não encontrado." });
            return;
          }
          res.json({ deleted: true });
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      });

      app.use("/admin", admin);
    }

    // Asaas payment webhook: confirmed payment reactivates the tenant,
    // overdue payment suspends it (tokens keep failing verify until then).
    // Configure the same token in the Asaas dashboard (header
    // asaas-access-token) and in ASAAS_WEBHOOK_TOKEN.
    const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
    if (webhookToken) {
      app.post("/webhooks/asaas", express.json(), async (req, res) => {
        const got = req.headers["asaas-access-token"];
        if (typeof got !== "string" || !safeEqualStrings(got, webhookToken)) {
          res.status(401).json({ error: "invalid webhook token" });
          return;
        }
        try {
          const event = req.body?.event as string | undefined;
          const customerId =
            req.body?.payment?.customer ?? req.body?.subscription?.customer;
          let tenantId: string | null = null;
          if (typeof customerId === "string" && event) {
            if (event === "PAYMENT_CONFIRMED" || event === "PAYMENT_RECEIVED") {
              tenantId = await dir.setStatusByAsaasCustomer(customerId, "active");
            } else if (event === "PAYMENT_OVERDUE") {
              tenantId = await dir.setStatusByAsaasCustomer(customerId, "suspended");
            }
          }
          if (tenantId) console.log(`Asaas webhook: ${event} → tenant ${tenantId}`);
          res.json({ received: true });
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      });
    }
  }

  return app;
}

// Picks the tenant directory from the environment: Postgres (DATABASE_URL)
// beats static TENANTS_JSON beats legacy single-tenant.
export async function run(): Promise<void> {
  let dir: TenantDirectory | null = null;
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    dir = await DbTenantDirectory.init(pool);
    console.log("Tenant directory: Postgres (DATABASE_URL)");
  } else {
    const tenants = parseTenantsConfig(process.env.TENANTS_JSON);
    if (tenants) {
      dir = new EnvTenantDirectory(tenants);
      console.log(`Tenant directory: TENANTS_JSON (${Object.keys(tenants).length} tenant(s))`);
    } else {
      console.log("Single-tenant mode (sem DATABASE_URL nem TENANTS_JSON) — acesso total após consent.");
    }
  }

  const app = createApp(dir);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`WhatsApp Evolution API MCP Server running on port ${port} (OAuth-protected)`);
    console.log(`Streamable HTTP URL: ${publicUrl}/mcp`);
    console.log(`SSE URL (legacy): ${publicUrl}/sse`);
    console.log(`OAuth issuer: ${publicUrl}`);
  });
}

// Only auto-start when executed directly (node build/index.js) — tests
// import createApp() and provide their own directory + listener.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().catch((error) => {
    console.error("Fatal error starting server:", error);
    process.exit(1);
  });
}
