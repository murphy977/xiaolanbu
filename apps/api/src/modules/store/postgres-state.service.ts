import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";

import {
  AuthUserRecord,
  DeploymentRecord,
  SessionRecord,
  UsageLedgerRecord,
  UserRecord,
  WalletRecord,
  WalletTransactionRecord,
  WorkspaceMembershipRecord,
  WorkspaceRecord,
} from "./models";

@Injectable()
export class PostgresStateService implements OnModuleDestroy {
  private readonly logger = new Logger(PostgresStateService.name);
  private pool: Pool | null = null;
  private initialized = false;
  private ensuredTables = new Set<string>();

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async ensureInitialized() {
    if (this.initialized) {
      return;
    }

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      this.logger.warn("DATABASE_URL is not configured. Falling back to in-memory store.");
      this.initialized = true;
      return;
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
    });

    await this.ensureBaseSchema();

    this.initialized = true;
  }

  isEnabled() {
    return this.pool !== null;
  }

  async listDeployments() {
    const rows = await this.queryRows<DeploymentRecord>(
      "SELECT data FROM xlb_deployments ORDER BY updated_at DESC",
    );
    return rows;
  }

  async listWallets() {
    const rows = await this.queryRows<WalletRecord>(
      "SELECT data FROM xlb_wallets ORDER BY updated_at DESC",
    );
    return rows;
  }

  async listUsageLedger() {
    const rows = await this.queryRows<UsageLedgerRecord>(
      "SELECT data FROM xlb_usage_ledger ORDER BY finished_at DESC",
    );
    return rows;
  }

  async listWalletTransactions() {
    const rows = await this.queryRows<WalletTransactionRecord>(
      "SELECT data FROM xlb_wallet_transactions ORDER BY created_at DESC",
    );
    return rows;
  }

  async listUsers() {
    return this.queryRows<AuthUserRecord>("SELECT data FROM xlb_users ORDER BY updated_at DESC");
  }

  async listWorkspacesCatalog() {
    return this.queryRows<WorkspaceRecord>(
      "SELECT data FROM xlb_workspaces_catalog ORDER BY updated_at DESC",
    );
  }

  async listWorkspaceMembers() {
    return this.queryRows<WorkspaceMembershipRecord>(
      "SELECT data FROM xlb_workspace_members ORDER BY updated_at DESC",
    );
  }

  async listSessions() {
    await this.ensureTableExists(
      "xlb_sessions",
      `
        CREATE TABLE IF NOT EXISTS xlb_sessions (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    return this.queryRows<SessionRecord>("SELECT data FROM xlb_sessions ORDER BY updated_at DESC");
  }

  async upsertDeployment(record: DeploymentRecord) {
    await this.upsertScopedJson("xlb_deployments", "workspace_id", record.id, record.workspaceId, record);
  }

  async upsertWallet(record: WalletRecord) {
    await this.upsertScopedJson("xlb_wallets", "workspace_id", record.id, record.workspaceId, record);
  }

  async insertUsageLedger(record: UsageLedgerRecord) {
    await this.pool?.query(
      `
        INSERT INTO xlb_usage_ledger (id, workspace_id, deployment_id, request_id, finished_at, updated_at, data)
        VALUES ($1, $2, $3, $4, $5::timestamptz, NOW(), $6::jsonb)
        ON CONFLICT (workspace_id, deployment_id, request_id)
        DO UPDATE SET data = EXCLUDED.data, finished_at = EXCLUDED.finished_at, updated_at = NOW()
      `,
      [
        record.id,
        record.workspaceId,
        record.deploymentId,
        record.requestId,
        record.finishedAt,
        JSON.stringify(record),
      ],
    );
  }

  async insertWalletTransaction(record: WalletTransactionRecord) {
    await this.pool?.query(
      `
        INSERT INTO xlb_wallet_transactions (id, workspace_id, created_at, updated_at, data)
        VALUES ($1, $2, $3::timestamptz, NOW(), $4::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at, updated_at = NOW()
      `,
      [record.id, record.workspaceId, record.createdAt, JSON.stringify(record)],
    );
  }

  async deleteDeployment(id: string) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(`DELETE FROM xlb_deployments WHERE id = $1`, [id]);
  }

  async getCurrentUser() {
    await this.ensureTableExists(
      "xlb_app_state",
      `
        CREATE TABLE IF NOT EXISTS xlb_app_state (
          key TEXT PRIMARY KEY,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    return this.querySingle<UserRecord>(
      "SELECT data FROM xlb_app_state WHERE key = 'current_user' LIMIT 1",
    );
  }

  async upsertCurrentUser(record: UserRecord) {
    if (!this.pool) {
      return;
    }

    await this.ensureTableExists(
      "xlb_app_state",
      `
        CREATE TABLE IF NOT EXISTS xlb_app_state (
          key TEXT PRIMARY KEY,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );

    await this.pool.query(
      `
        INSERT INTO xlb_app_state (key, updated_at, data)
        VALUES ('current_user', NOW(), $1::jsonb)
        ON CONFLICT (key)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `,
      [JSON.stringify(record)],
    );
  }

  async upsertUser(record: AuthUserRecord) {
    await this.upsertDataOnlyJson("xlb_users", record.id, record);
  }

  async upsertWorkspace(record: WorkspaceRecord) {
    await this.upsertScopedJson(
      "xlb_workspaces_catalog",
      "owner_user_id",
      record.id,
      record.ownerUserId,
      record,
    );
  }

  async upsertWorkspaceMember(record: WorkspaceMembershipRecord) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `
        INSERT INTO xlb_workspace_members (id, user_id, workspace_id, updated_at, data)
        VALUES ($1, $2, $3, NOW(), $4::jsonb)
        ON CONFLICT (user_id, workspace_id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `,
      [record.id, record.userId, record.workspaceId, JSON.stringify(record)],
    );
  }

  async deleteWorkspaceMember(userId: string, workspaceId: string) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `DELETE FROM xlb_workspace_members WHERE user_id = $1 AND workspace_id = $2`,
      [userId, workspaceId],
    );
  }

  async upsertSession(record: SessionRecord) {
    if (!this.pool) {
      return;
    }

    await this.ensureTableExists(
      "xlb_sessions",
      `
        CREATE TABLE IF NOT EXISTS xlb_sessions (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );

    await this.pool.query(
      `
        INSERT INTO xlb_sessions (id, token, user_id, updated_at, data)
        VALUES ($1, $2, $3, NOW(), $4::jsonb)
        ON CONFLICT (token)
        DO UPDATE SET data = EXCLUDED.data, user_id = EXCLUDED.user_id, updated_at = NOW()
      `,
      [record.id, record.token, record.userId, JSON.stringify(record)],
    );
  }

  async deleteSessionByToken(token: string) {
    if (!this.pool) {
      return;
    }

    await this.ensureTableExists(
      "xlb_sessions",
      `
        CREATE TABLE IF NOT EXISTS xlb_sessions (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );

    await this.pool.query(`DELETE FROM xlb_sessions WHERE token = $1`, [token]);
  }

  private async ensureTableExists(tableName: string, createSql: string) {
    if (!this.pool || this.ensuredTables.has(tableName)) {
      return;
    }

    await this.pool.query(createSql);
    this.ensuredTables.add(tableName);
  }

  private async ensureBaseSchema() {
    await this.ensureTableExists(
      "xlb_deployments",
      `
        CREATE TABLE IF NOT EXISTS xlb_deployments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_wallets",
      `
        CREATE TABLE IF NOT EXISTS xlb_wallets (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL UNIQUE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_usage_ledger",
      `
        CREATE TABLE IF NOT EXISTS xlb_usage_ledger (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          finished_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL,
          UNIQUE (workspace_id, deployment_id, request_id)
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_wallet_transactions",
      `
        CREATE TABLE IF NOT EXISTS xlb_wallet_transactions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_users",
      `
        CREATE TABLE IF NOT EXISTS xlb_users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_workspaces_catalog",
      `
        CREATE TABLE IF NOT EXISTS xlb_workspaces_catalog (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_workspace_members",
      `
        CREATE TABLE IF NOT EXISTS xlb_workspace_members (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL,
          UNIQUE (user_id, workspace_id)
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_sessions",
      `
        CREATE TABLE IF NOT EXISTS xlb_sessions (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    await this.ensureTableExists(
      "xlb_app_state",
      `
        CREATE TABLE IF NOT EXISTS xlb_app_state (
          key TEXT PRIMARY KEY,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );

    if (this.pool) {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS xlb_deployments_workspace_idx
          ON xlb_deployments (workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS xlb_usage_ledger_workspace_idx
          ON xlb_usage_ledger (workspace_id, finished_at DESC);
        CREATE INDEX IF NOT EXISTS xlb_wallet_transactions_workspace_idx
          ON xlb_wallet_transactions (workspace_id, created_at DESC);
      `);
    }
  }

  private async queryRows<T>(sql: string) {
    if (!this.pool) {
      return [];
    }

    const result = await this.pool.query<{ data: T }>(sql);
    return result.rows.map((row) => row.data);
  }

  private async querySingle<T>(sql: string) {
    if (!this.pool) {
      return null;
    }

    const result = await this.pool.query<{ data: T }>(sql);
    return result.rows[0]?.data ?? null;
  }

  private async upsertScopedJson(
    tableName: "xlb_deployments" | "xlb_wallets" | "xlb_workspaces_catalog",
    scopeColumn: "workspace_id" | "owner_user_id",
    id: string,
    scopeValue: string,
    data: unknown,
  ) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `
        INSERT INTO ${tableName} (id, ${scopeColumn}, updated_at, data)
        VALUES ($1, $2, NOW(), $3::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET ${scopeColumn} = EXCLUDED.${scopeColumn}, data = EXCLUDED.data, updated_at = NOW()
      `,
      [id, scopeValue, JSON.stringify(data)],
    );
  }

  private async upsertDataOnlyJson(
    tableName: "xlb_users",
    id: string,
    data: unknown,
  ) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `
        INSERT INTO ${tableName} (id, email, updated_at, data)
        VALUES ($1, ($2::jsonb->>'email'), NOW(), $2::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET email = EXCLUDED.email, data = EXCLUDED.data, updated_at = NOW()
      `,
      [id, JSON.stringify(data)],
    );
  }
}
