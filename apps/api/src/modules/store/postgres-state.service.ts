import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";

import {
  DeploymentRecord,
  UsageLedgerRecord,
  WalletRecord,
  WalletTransactionRecord,
} from "./models";

@Injectable()
export class PostgresStateService implements OnModuleDestroy {
  private readonly logger = new Logger(PostgresStateService.name);
  private pool: Pool | null = null;
  private initialized = false;

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

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS xlb_deployments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xlb_wallets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xlb_usage_ledger (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        finished_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL,
        UNIQUE (workspace_id, deployment_id, request_id)
      );

      CREATE TABLE IF NOT EXISTS xlb_wallet_transactions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS xlb_deployments_workspace_idx
        ON xlb_deployments (workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS xlb_usage_ledger_workspace_idx
        ON xlb_usage_ledger (workspace_id, finished_at DESC);
      CREATE INDEX IF NOT EXISTS xlb_wallet_transactions_workspace_idx
        ON xlb_wallet_transactions (workspace_id, created_at DESC);
    `);

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

  async upsertDeployment(record: DeploymentRecord) {
    await this.upsertJson(
      "xlb_deployments",
      record.id,
      record.workspaceId,
      record,
    );
  }

  async upsertWallet(record: WalletRecord) {
    await this.upsertJson(
      "xlb_wallets",
      record.id,
      record.workspaceId,
      record,
    );
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

  private async queryRows<T>(sql: string) {
    if (!this.pool) {
      return [];
    }

    const result = await this.pool.query<{ data: T }>(sql);
    return result.rows.map((row) => row.data);
  }

  private async upsertJson(
    tableName: "xlb_deployments" | "xlb_wallets",
    id: string,
    workspaceId: string,
    data: unknown,
  ) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `
        INSERT INTO ${tableName} (id, workspace_id, updated_at, data)
        VALUES ($1, $2, NOW(), $3::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET workspace_id = EXCLUDED.workspace_id, data = EXCLUDED.data, updated_at = NOW()
      `,
      [id, workspaceId, JSON.stringify(data)],
    );
  }
}
