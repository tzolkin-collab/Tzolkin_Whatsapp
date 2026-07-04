import { randomBytes, randomUUID } from "crypto";
import type pg from "pg";
import { hashSecretString, safeEqualStrings, type TenantsConfig } from "./auth.js";

export type TenantScope = { tenantId: string; instances: "*" | string[] };

/**
 * Where tenants live and how tokens map back to them. Two implementations:
 *
 * - EnvTenantDirectory: static TENANTS_JSON config. Scope is baked into the
 *   signed token at mint time; no revocation, no billing status.
 * - DbTenantDirectory: Postgres-backed. Tokens carry only a jti; the scope
 *   is resolved live on every verify, so revoking a token, suspending a
 *   tenant (payment overdue via Asaas webhook) or editing its instance list
 *   takes effect immediately.
 */
export interface TenantDirectory {
  /** true → the consent page asks for a tenant access key. */
  readonly requiresKey: boolean;
  /** Validate the key typed on consent. null = wrong key. May throw with a
   *  user-facing message (e.g. tenant suspended). */
  validateKey(key: string | undefined): Promise<TenantScope | null>;
  /** Record a freshly minted access token (jti) so it can be revoked later. */
  registerToken(jti: string, tenantId: string, clientId: string, expiresAtSec: number): Promise<void>;
  /** Live scope for a verified token payload. Throws if revoked/suspended. */
  resolveTokenScope(payload: { jti?: string; tenantId?: string; instances?: "*" | string[] }): Promise<TenantScope>;
  /** Best-effort revocation (RFC 7009 semantics: unknown tokens don't error). */
  revokeToken(payload: { jti?: string }): Promise<void>;
}

// --- Static config (TENANTS_JSON) -------------------------------------------

export class EnvTenantDirectory implements TenantDirectory {
  readonly requiresKey = true;

  constructor(private readonly tenants: TenantsConfig) {}

  async validateKey(key: string | undefined): Promise<TenantScope | null> {
    const match = Object.entries(this.tenants).find(([, cfg]) =>
      safeEqualStrings(cfg.key, key ?? "")
    );
    return match ? { tenantId: match[0], instances: match[1].instances } : null;
  }

  async registerToken(): Promise<void> {
    // Scope is baked into the token itself; nothing to record.
  }

  async resolveTokenScope(payload: {
    jti?: string;
    tenantId?: string;
    instances?: "*" | string[];
  }): Promise<TenantScope> {
    if (payload.instances === "*" || Array.isArray(payload.instances)) {
      return { tenantId: payload.tenantId ?? "desconhecido", instances: payload.instances };
    }
    throw new Error("Token sem escopo de tenant — reautorize o conector.");
  }

  async revokeToken(): Promise<void> {
    // Stateless tokens can't be revoked; they expire on their own.
  }
}

// --- Postgres-backed ---------------------------------------------------------

export type TenantRecord = {
  id: string;
  name: string;
  instances: "*" | string[];
  is_admin: boolean;
  status: string;
  asaas_customer_id: string | null;
  asaas_subscription_id: string | null;
  created_at: Date;
};

export type CreateTenantInput = {
  id: string;
  name: string;
  instances: string[];
  isAdmin?: boolean;
};

export type UpdateTenantInput = Partial<{
  name: string;
  instances: string[];
  isAdmin: boolean;
  status: "active" | "suspended";
  asaasCustomerId: string | null;
  asaasSubscriptionId: string | null;
}>;

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export class DbTenantDirectory implements TenantDirectory {
  readonly requiresKey = true;

  constructor(private readonly pool: pg.Pool) {}

  /** Creates the schema (idempotent) and returns a ready directory. */
  static async init(pool: pg.Pool): Promise<DbTenantDirectory> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        access_key_hash TEXT NOT NULL,
        instances JSONB NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'active',
        asaas_customer_id TEXT,
        asaas_subscription_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_tokens (
        jti TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_id TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Créditos do chatbot: ledger append-only (saldo = SUM(delta)). `ref`
    // marca lançamentos idempotentes (id do pagamento Asaas, sessionId do
    // Typebot) — o mesmo ref nunca credita/debita duas vezes.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_credit_ledger (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    return new DbTenantDirectory(pool);
  }

  private scopeOf(row: { id: string; instances: unknown; is_admin: boolean }): TenantScope {
    return {
      tenantId: row.id,
      instances: row.is_admin ? "*" : ((row.instances as string[]) ?? []),
    };
  }

  async validateKey(key: string | undefined): Promise<TenantScope | null> {
    if (!key) return null;
    const hash = hashSecretString(key);
    const r = await this.pool.query(
      `SELECT id, instances, is_admin, status FROM wa_tenants WHERE access_key_hash = $1`,
      [hash]
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.status !== "active") {
      throw new Error(
        `Tenant "${row.id}" está suspenso — regularize o pagamento ou contate a Tzolkin.`
      );
    }
    return this.scopeOf(row);
  }

  async registerToken(jti: string, tenantId: string, clientId: string, expiresAtSec: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO wa_tokens (jti, tenant_id, client_id, expires_at) VALUES ($1, $2, $3, $4)`,
      [jti, tenantId, clientId, new Date(expiresAtSec * 1000)]
    );
  }

  async resolveTokenScope(payload: { jti?: string }): Promise<TenantScope> {
    if (!payload.jti) {
      throw new Error("Token emitido antes do modo Postgres — reautorize o conector.");
    }
    const r = await this.pool.query(
      `SELECT tok.revoked, t.id, t.instances, t.is_admin, t.status
         FROM wa_tokens tok JOIN wa_tenants t ON t.id = tok.tenant_id
        WHERE tok.jti = $1`,
      [payload.jti]
    );
    const row = r.rows[0];
    if (!row) throw new Error("Token desconhecido — reautorize o conector.");
    if (row.revoked) throw new Error("Token revogado — reautorize o conector.");
    if (row.status !== "active") {
      throw new Error("Tenant suspenso — regularize o pagamento ou contate a Tzolkin.");
    }
    return this.scopeOf(row);
  }

  async revokeToken(payload: { jti?: string }): Promise<void> {
    if (!payload.jti) return;
    await this.pool.query(`UPDATE wa_tokens SET revoked = TRUE WHERE jti = $1`, [payload.jti]);
  }

  // --- Admin operations (used by the /admin HTTP API) ------------------------

  /** Returns the plaintext access key exactly once — only the hash is stored. */
  async createTenant(input: CreateTenantInput): Promise<{ accessKey: string }> {
    if (!TENANT_ID_RE.test(input.id)) {
      throw new Error(`id inválido: use slug minúsculo (a-z, 0-9, -, _), 2-64 chars.`);
    }
    const accessKey = randomBytes(24).toString("base64url");
    await this.pool.query(
      `INSERT INTO wa_tenants (id, name, access_key_hash, instances, is_admin)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [input.id, input.name, hashSecretString(accessKey), JSON.stringify(input.instances), input.isAdmin === true]
    );
    return { accessKey };
  }

  async listTenants(): Promise<TenantRecord[]> {
    const r = await this.pool.query(
      `SELECT id, name, instances, is_admin, status, asaas_customer_id, asaas_subscription_id, created_at
         FROM wa_tenants ORDER BY id`
    );
    return r.rows.map((row) => ({ ...row, instances: row.is_admin ? "*" : row.instances }));
  }

  async updateTenant(id: string, patch: UpdateTenantInput): Promise<boolean> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (sql: string, v: unknown) => {
      values.push(v);
      sets.push(`${sql} = $${values.length}`);
    };
    if (patch.name !== undefined) push("name", patch.name);
    if (patch.instances !== undefined) push("instances", JSON.stringify(patch.instances));
    if (patch.isAdmin !== undefined) push("is_admin", patch.isAdmin);
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.asaasCustomerId !== undefined) push("asaas_customer_id", patch.asaasCustomerId);
    if (patch.asaasSubscriptionId !== undefined) push("asaas_subscription_id", patch.asaasSubscriptionId);
    if (sets.length === 0) return false;
    values.push(id);
    const r = await this.pool.query(
      `UPDATE wa_tenants SET ${sets.join(", ")} WHERE id = $${values.length}`,
      values
    );
    return (r.rowCount ?? 0) > 0;
  }

  async rotateKey(id: string): Promise<{ accessKey: string } | null> {
    const accessKey = randomBytes(24).toString("base64url");
    const r = await this.pool.query(
      `UPDATE wa_tenants SET access_key_hash = $1 WHERE id = $2`,
      [hashSecretString(accessKey), id]
    );
    return (r.rowCount ?? 0) > 0 ? { accessKey } : null;
  }

  async revokeAllTokens(tenantId: string): Promise<number> {
    const r = await this.pool.query(
      `UPDATE wa_tokens SET revoked = TRUE WHERE tenant_id = $1 AND revoked = FALSE`,
      [tenantId]
    );
    return r.rowCount ?? 0;
  }

  async deleteTenant(id: string): Promise<boolean> {
    await this.pool.query(`DELETE FROM wa_tokens WHERE tenant_id = $1`, [id]);
    const r = await this.pool.query(`DELETE FROM wa_tenants WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Asaas webhook: flip tenant status by the Asaas customer id. */
  async setStatusByAsaasCustomer(customerId: string, status: "active" | "suspended"): Promise<string | null> {
    const r = await this.pool.query(
      `UPDATE wa_tenants SET status = $1 WHERE asaas_customer_id = $2 RETURNING id`,
      [status, customerId]
    );
    return r.rows[0]?.id ?? null;
  }

  async getTenantById(id: string): Promise<TenantRecord | null> {
    const r = await this.pool.query(
      `SELECT id, name, instances, is_admin, status, asaas_customer_id, asaas_subscription_id, created_at
         FROM wa_tenants WHERE id = $1`,
      [id]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      ...row,
      instances: row.is_admin ? "*" : row.instances,
    };
  }

  async getTenantByAccessKey(accessKey: string): Promise<TenantRecord | null> {
    const hash = hashSecretString(accessKey);
    const r = await this.pool.query(
      `SELECT id, name, instances, is_admin, status, asaas_customer_id, asaas_subscription_id, created_at
         FROM wa_tenants WHERE access_key_hash = $1`,
      [hash]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      ...row,
      instances: row.is_admin ? "*" : row.instances,
    };
  }

  async getTenantTokens(tenantId: string): Promise<Array<{ jti: string; clientId: string; expiresAt: Date; revoked: boolean }>> {
    const r = await this.pool.query(
      `SELECT jti, client_id as "clientId", expires_at as "expiresAt", revoked
         FROM wa_tokens WHERE tenant_id = $1 ORDER BY expires_at DESC`,
      [tenantId]
    );
    return r.rows.map(row => ({
      jti: row.jti,
      clientId: row.clientId || "Desconhecido",
      expiresAt: new Date(row.expiresAt),
      revoked: row.revoked,
    }));
  }

  // --- Créditos do chatbot ----------------------------------------------------

  /**
   * Lança créditos (delta > 0) ou débito (delta < 0). Com `ref`, o
   * lançamento é idempotente: se o ref já existe no ledger, nada é gravado
   * e retorna false (protege contra retries de webhook do Asaas/Evolution).
   */
  async addCredits(tenantId: string, delta: number, reason: string, ref: string | null = null): Promise<boolean> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new Error("delta de créditos deve ser um inteiro diferente de zero.");
    }
    if (ref) {
      const dup = await this.pool.query(`SELECT 1 FROM wa_credit_ledger WHERE ref = $1`, [ref]);
      if (dup.rows.length > 0) return false;
    }
    await this.pool.query(
      `INSERT INTO wa_credit_ledger (id, tenant_id, delta, reason, ref) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenantId, delta, reason, ref]
    );
    return true;
  }

  async getCreditBalance(tenantId: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(delta), 0) AS balance FROM wa_credit_ledger WHERE tenant_id = $1`,
      [tenantId]
    );
    return Number(r.rows[0]?.balance ?? 0);
  }

  async getCreditHistory(tenantId: string, limit = 50): Promise<Array<{ delta: number; reason: string; ref: string | null; created_at: Date }>> {
    const r = await this.pool.query(
      `SELECT delta, reason, ref, created_at FROM wa_credit_ledger
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit]
    );
    return r.rows;
  }

  /**
   * Localiza o tenant dono de uma instância (para webhooks da Evolution,
   * que identificam apenas o instanceName). Tenants admin ("*") não contam
   * como donos. Varredura em JS — adequado à escala atual; trocar por
   * consulta JSONB quando a base crescer.
   */
  async findTenantByInstance(instanceName: string): Promise<TenantRecord | null> {
    const r = await this.pool.query(
      `SELECT id, name, instances, is_admin, status, asaas_customer_id, asaas_subscription_id, created_at
         FROM wa_tenants WHERE is_admin = FALSE`
    );
    for (const row of r.rows) {
      if (Array.isArray(row.instances) && row.instances.includes(instanceName)) {
        return { ...row, instances: row.instances };
      }
    }
    return null;
  }
}

