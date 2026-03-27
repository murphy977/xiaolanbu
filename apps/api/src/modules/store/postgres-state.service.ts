import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient } from "pg";

import {
  AuthUserRecord,
  DeploymentRecord,
  LocalGatewayCredentialRecord,
  SessionRecord,
  UsageLedgerRecord,
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
      max: this.readPositiveIntegerEnv("XLB_DB_POOL_MAX", 20),
      idleTimeoutMillis: this.readPositiveIntegerEnv("XLB_DB_POOL_IDLE_TIMEOUT_MS", 10000),
      connectionTimeoutMillis: this.readPositiveIntegerEnv("XLB_DB_POOL_CONNECT_TIMEOUT_MS", 5000),
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
      [],
    );
    return rows;
  }

  async listWallets() {
    const rows = await this.queryRows<WalletRecord>(
      "SELECT data FROM xlb_wallets ORDER BY updated_at DESC",
      [],
    );
    return rows;
  }

  async listUsageLedger() {
    const rows = await this.queryRows<UsageLedgerRecord>(
      "SELECT data FROM xlb_usage_ledger ORDER BY finished_at DESC",
      [],
    );
    return rows;
  }

  async listWalletTransactions() {
    const rows = await this.queryRows<WalletTransactionRecord>(
      "SELECT data FROM xlb_wallet_transactions ORDER BY created_at DESC",
      [],
    );
    return rows;
  }

  async listUsers() {
    return this.queryRows<AuthUserRecord>("SELECT data FROM xlb_users ORDER BY updated_at DESC", []);
  }

  async listWorkspacesCatalog() {
    return this.queryRows<WorkspaceRecord>(
      "SELECT data FROM xlb_workspaces_catalog ORDER BY updated_at DESC",
      [],
    );
  }

  async listWorkspaceMembers() {
    return this.queryRows<WorkspaceMembershipRecord>(
      "SELECT data FROM xlb_workspace_members ORDER BY updated_at DESC",
      [],
    );
  }

  async listSessions() {
    return this.queryRows<SessionRecord>("SELECT data FROM xlb_sessions ORDER BY updated_at DESC", []);
  }

  async listLocalGatewayCredentials() {
    return this.queryRows<LocalGatewayCredentialRecord>(
      "SELECT data FROM xlb_local_gateway_credentials ORDER BY updated_at DESC",
      [],
    );
  }

  async upsertDeployment(record: DeploymentRecord) {
    await this.upsertScopedJson("xlb_deployments", "workspace_id", record.id, record.workspaceId, record);
  }

  async upsertWallet(record: WalletRecord) {
    await this.upsertScopedJson("xlb_wallets", "workspace_id", record.id, record.workspaceId, record);
  }

  async insertUsageLedger(record: UsageLedgerRecord) {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(
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
      },
      undefined,
    );
  }

  async insertWalletTransaction(record: WalletTransactionRecord) {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(
          `
            INSERT INTO xlb_wallet_transactions (id, workspace_id, created_at, updated_at, data)
            VALUES ($1, $2, $3::timestamptz, NOW(), $4::jsonb)
            ON CONFLICT (id)
            DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at, updated_at = NOW()
          `,
          [record.id, record.workspaceId, record.createdAt, JSON.stringify(record)],
        );
      },
      undefined,
    );
  }

  async deleteDeployment(id: string) {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(`DELETE FROM xlb_deployments WHERE id = $1`, [id]);
      },
      undefined,
    );
  }

  async deleteLegacyCurrentUserState() {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(
          `DELETE FROM xlb_app_state WHERE key = 'current_user'`,
        );
      },
      undefined,
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
    await this.withSchemaRetry(
      async () => {
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
      },
      undefined,
    );
  }

  async deleteWorkspaceMember(userId: string, workspaceId: string) {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(
          `DELETE FROM xlb_workspace_members WHERE user_id = $1 AND workspace_id = $2`,
          [userId, workspaceId],
        );
      },
      undefined,
    );
  }

  async upsertSession(record: SessionRecord) {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(
          `
            INSERT INTO xlb_sessions (id, token, user_id, expires_at, updated_at, data)
            VALUES ($1, $2, $3, $4::timestamptz, NOW(), $5::jsonb)
            ON CONFLICT (token)
            DO UPDATE SET
              data = EXCLUDED.data,
              user_id = EXCLUDED.user_id,
              expires_at = EXCLUDED.expires_at,
              updated_at = NOW()
          `,
          [record.id, record.token, record.userId, record.expiresAt, JSON.stringify(record)],
        );
      },
      undefined,
    );
  }

  async upsertLocalGatewayCredential(record: LocalGatewayCredentialRecord) {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(
          `
            INSERT INTO xlb_local_gateway_credentials
              (id, user_id, account_scope_id, token_id, updated_at, data)
            VALUES ($1, $2, $3, $4, NOW(), $5::jsonb)
            ON CONFLICT (user_id, account_scope_id)
            DO UPDATE SET
              id = EXCLUDED.id,
              token_id = EXCLUDED.token_id,
              data = EXCLUDED.data,
              updated_at = NOW()
          `,
          [
            record.id,
            record.userId,
            record.accountScopeId,
            record.tokenId,
            JSON.stringify(record),
          ],
        );
      },
      undefined,
    );
  }

  async deleteSessionByToken(token: string) {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(`DELETE FROM xlb_sessions WHERE token = $1`, [token]);
      },
      undefined,
    );
  }

  async clearSessions() {
    await this.withSchemaRetry(
      async () => {
        if (!this.pool) {
          return;
        }

        await this.pool.query(`DELETE FROM xlb_sessions`);
      },
      undefined,
    );
  }

  async deleteExpiredSessions(nowIso = new Date().toISOString()) {
    return this.withSchemaRetry(async () => {
      if (!this.pool) {
        return 0;
      }

      const result = await this.pool.query(
        `DELETE FROM xlb_sessions WHERE expires_at <= $1::timestamptz`,
        [nowIso],
      );
      return result.rowCount ?? 0;
    }, 0);
  }

  async getUserById(userId: string) {
    return this.querySingleByParam<AuthUserRecord>(
      "SELECT data FROM xlb_users WHERE id = $1 LIMIT 1",
      [userId],
      null,
    );
  }

  async getUserByEmail(email: string) {
    return this.querySingleByParam<AuthUserRecord>(
      "SELECT data FROM xlb_users WHERE lower(email) = lower($1) LIMIT 1",
      [email],
      null,
    );
  }

  async getSessionByToken(token: string) {
    return this.querySingleByParam<SessionRecord>(
      "SELECT data FROM xlb_sessions WHERE token = $1 LIMIT 1",
      [token],
      null,
    );
  }

  async getValidSessionByToken(token: string, nowIso = new Date().toISOString()) {
    return this.querySingleByParam<SessionRecord>(
      "SELECT data FROM xlb_sessions WHERE token = $1 AND expires_at > $2::timestamptz LIMIT 1",
      [token, nowIso],
      null,
    );
  }

  async getWorkspaceById(workspaceId: string) {
    return this.querySingleByParam<WorkspaceRecord>(
      "SELECT data FROM xlb_workspaces_catalog WHERE id = $1 LIMIT 1",
      [workspaceId],
      null,
    );
  }

  async getDeploymentById(deploymentId: string) {
    return this.querySingleByParam<DeploymentRecord>(
      "SELECT data FROM xlb_deployments WHERE id = $1 LIMIT 1",
      [deploymentId],
      null,
    );
  }

  async getDeploymentByGatewaySecret(secretKey: string) {
    return this.querySingleByParam<DeploymentRecord>(
      `
        SELECT data
        FROM xlb_deployments
        WHERE data->'gatewayKey'->>'secretKey' = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [secretKey],
      null,
    );
  }

  async getWalletByUserId(userId: string) {
    return this.querySingleByParam<WalletRecord>(
      `
        SELECT data
        FROM xlb_wallets
        WHERE data->>'userId' = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [userId],
      null,
    );
  }

  async getWorkspaceMembership(userId: string, workspaceId: string) {
    return this.querySingleByParam<WorkspaceMembershipRecord>(
      `
        SELECT data
        FROM xlb_workspace_members
        WHERE user_id = $1 AND workspace_id = $2
        LIMIT 1
      `,
      [userId, workspaceId],
      null,
    );
  }

  async getLocalGatewayCredentialByUserAndScope(userId: string, accountScopeId: string) {
    return this.querySingleByParam<LocalGatewayCredentialRecord>(
      `
        SELECT data
        FROM xlb_local_gateway_credentials
        WHERE user_id = $1 AND account_scope_id = $2
        LIMIT 1
      `,
      [userId, accountScopeId],
      null,
    );
  }

  async getLocalGatewayCredentialByTokenId(tokenId: string) {
    return this.querySingleByParam<LocalGatewayCredentialRecord>(
      `
        SELECT data
        FROM xlb_local_gateway_credentials
        WHERE token_id = $1
        LIMIT 1
      `,
      [tokenId],
      null,
    );
  }

  async withAdvisoryLock<T>(lockId: number, timeoutMs: number, operation: () => Promise<T>) {
    await this.ensureInitialized();
    if (!this.pool) {
      return {
        acquired: true,
        value: await operation(),
      } as const;
    }
    const pool = this.pool;

    return this.withSchemaRetry(async () => {
      const client = await pool.connect();
      try {
        const deadline = Date.now() + Math.max(timeoutMs, 0);
        while (true) {
          const result = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS locked",
            [lockId],
          );
          if (result.rows[0]?.locked) {
            break;
          }
          if (Date.now() >= deadline) {
            return {
              acquired: false,
              value: null,
            } as const;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        try {
          const value = await operation();
          return {
            acquired: true,
            value,
          } as const;
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        }
      } finally {
        client.release();
      }
    }, { acquired: false, value: null as T | null });
  }

  async checkReadiness() {
    return this.withSchemaRetry(async () => {
      if (!this.pool) {
        return {
          ok: false,
          reason: "DATABASE_URL is not configured",
          database: this.getHealthSnapshot(),
        };
      }

      await this.pool.query("SELECT 1");
      return {
        ok: true,
        database: this.getHealthSnapshot(),
      };
    }, {
      ok: false,
      reason: "DATABASE_URL is not configured",
      database: this.getHealthSnapshot(),
    });
  }

  async registerUserBundle(input: {
    user: AuthUserRecord;
    workspace: WorkspaceRecord;
    membership: WorkspaceMembershipRecord;
    wallet: WalletRecord;
    session: SessionRecord;
  }) {
    return this.withTransaction(async (client) => {
      const existingUser = await client.query<{ id: string }>(
        `SELECT id FROM xlb_users WHERE lower(email) = lower($1) LIMIT 1`,
        [input.user.email],
      );
      if (existingUser.rowCount) {
        const error = new Error("EMAIL_ALREADY_EXISTS");
        (error as Error & { code?: string }).code = "23505";
        throw error;
      }

      await this.upsertUserWithClient(client, input.user);
      await this.upsertWorkspaceWithClient(client, input.workspace);
      await this.upsertWorkspaceMemberWithClient(client, input.membership);
      await this.upsertWalletWithClient(client, input.wallet);
      await this.upsertSessionWithClient(client, input.session);
    });
  }

  async createWorkspaceBundle(input: {
    user: AuthUserRecord;
    workspace: WorkspaceRecord;
    membership: WorkspaceMembershipRecord;
    wallet?: WalletRecord | null;
  }) {
    return this.withTransaction(async (client) => {
      await this.lockUserById(client, input.user.id);
      await this.upsertWorkspaceWithClient(client, input.workspace);
      await this.upsertWorkspaceMemberWithClient(client, input.membership);
      if (input.wallet) {
        const existingWallet = await this.querySingleByParamWithClient<WalletRecord>(
          client,
          `
            SELECT data
            FROM xlb_wallets
            WHERE data->>'userId' = $1
            ORDER BY updated_at DESC
            LIMIT 1
          `,
          [input.user.id],
          null,
        );
        if (!existingWallet) {
          await this.upsertWalletWithClient(client, input.wallet);
        }
      }
      await this.upsertUserWithClient(client, input.user);
    });
  }

  async setUserActiveWorkspace(input: { userId: string; workspaceId: string }) {
    return this.withTransaction(async (client) => {
      const user = await this.lockUserById(client, input.userId);
      const workspace = await this.querySingleByParamWithClient<WorkspaceRecord>(
        client,
        `SELECT data FROM xlb_workspaces_catalog WHERE id = $1 LIMIT 1`,
        [input.workspaceId],
        null,
      );
      if (!workspace || workspace.status === "archived") {
        throw new Error(`Workspace ${input.workspaceId} not found`);
      }
      const membership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
        `,
        [input.userId, input.workspaceId],
        null,
      );
      if (!membership) {
        throw new Error(`Workspace ${input.workspaceId} is not accessible for user ${input.userId}`);
      }
      user.activeWorkspaceId = input.workspaceId;
      await this.upsertUserWithClient(client, user);
    });
  }

  async leaveWorkspace(input: {
    currentUserId: string;
    workspaceId: string;
    nextWorkspaceId: string;
  }) {
    return this.withTransaction(async (client) => {
      const membership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [input.currentUserId, input.workspaceId],
        null,
      );
      if (!membership) {
        throw new Error("WORKSPACE_MEMBER_NOT_FOUND");
      }

      const ownerRows = await client.query<{ data: WorkspaceMembershipRecord }>(
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE workspace_id = $1 AND (data->>'role') = 'owner'
          FOR UPDATE
        `,
        [input.workspaceId],
      );
      const owners = ownerRows.rows.map((row) => row.data);
      if (membership.role === "owner" && owners.length <= 1) {
        throw new Error("LAST_OWNER_CANNOT_LEAVE");
      }

      const nextWorkspaceMembership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
        `,
        [input.currentUserId, input.nextWorkspaceId],
        null,
      );
      if (!nextWorkspaceMembership) {
        throw new Error("NEXT_WORKSPACE_NOT_ACCESSIBLE");
      }

      await client.query(
        `DELETE FROM xlb_workspace_members WHERE user_id = $1 AND workspace_id = $2`,
        [membership.userId, membership.workspaceId],
      );

      const workspace = await this.querySingleByParamWithClient<WorkspaceRecord>(
        client,
        `SELECT data FROM xlb_workspaces_catalog WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [input.workspaceId],
        null,
      );
      if (workspace?.ownerUserId === membership.userId) {
        const nextOwner = owners.find((item) => item.userId !== membership.userId);
        if (nextOwner) {
          workspace.ownerUserId = nextOwner.userId;
          await this.upsertWorkspaceWithClient(client, workspace);
        }
      }

      const user = await this.lockUserById(client, input.currentUserId);
      if (user.activeWorkspaceId === input.workspaceId) {
        user.activeWorkspaceId = input.nextWorkspaceId;
        await this.upsertUserWithClient(client, user);
      }
    });
  }

  async archiveWorkspace(input: {
    currentUserId: string;
    workspaceId: string;
    nextWorkspaceId: string;
  }) {
    return this.withTransaction(async (client) => {
      const currentMembership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [input.currentUserId, input.workspaceId],
        null,
      );
      if (!currentMembership || currentMembership.role !== "owner") {
        throw new Error("WORKSPACE_OWNER_REQUIRED");
      }

      const nextWorkspaceMembership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
        `,
        [input.currentUserId, input.nextWorkspaceId],
        null,
      );
      if (!nextWorkspaceMembership) {
        throw new Error("NEXT_WORKSPACE_NOT_ACCESSIBLE");
      }

      const deployments = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM xlb_deployments
          WHERE workspace_id = $1
            AND COALESCE(data->>'mode', 'cloud') = 'cloud'
        `,
        [input.workspaceId],
      );
      if (Number(deployments.rows[0]?.count ?? "0") > 0) {
        throw new Error("WORKSPACE_HAS_DEPLOYMENTS");
      }

      const memberRows = await client.query<{ data: WorkspaceMembershipRecord }>(
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE workspace_id = $1
          FOR UPDATE
        `,
        [input.workspaceId],
      );
      if ((memberRows.rowCount ?? 0) > 1) {
        throw new Error("WORKSPACE_HAS_OTHER_MEMBERS");
      }

      const workspace = await this.querySingleByParamWithClient<WorkspaceRecord>(
        client,
        `SELECT data FROM xlb_workspaces_catalog WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [input.workspaceId],
        null,
      );
      if (!workspace) {
        throw new Error(`Workspace ${input.workspaceId} not found`);
      }
      workspace.status = "archived";
      await this.upsertWorkspaceWithClient(client, workspace);

      const user = await this.lockUserById(client, input.currentUserId);
      if (user.activeWorkspaceId === input.workspaceId) {
        user.activeWorkspaceId = input.nextWorkspaceId;
        await this.upsertUserWithClient(client, user);
      }
    });
  }

  async addWorkspaceMember(input: {
    currentUserId: string;
    workspaceId: string;
    email: string;
    membership: WorkspaceMembershipRecord;
  }) {
    return this.withTransaction(async (client) => {
      const currentMembership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [input.currentUserId, input.workspaceId],
        null,
      );
      if (!currentMembership || currentMembership.role !== "owner") {
        throw new Error("WORKSPACE_OWNER_REQUIRED");
      }

      const user = await this.querySingleByParamWithClient<AuthUserRecord>(
        client,
        `SELECT data FROM xlb_users WHERE lower(email) = lower($1) LIMIT 1`,
        [input.email],
        null,
      );
      if (!user) {
        throw new Error("USER_EMAIL_NOT_FOUND");
      }

      const existingMembership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
        `,
        [user.id, input.workspaceId],
        null,
      );
      if (existingMembership) {
        throw new Error("WORKSPACE_MEMBER_ALREADY_EXISTS");
      }

      await this.upsertWorkspaceMemberWithClient(client, {
        ...input.membership,
        userId: user.id,
      });
    });
  }

  async updateWorkspaceMemberRole(input: {
    currentUserId: string;
    workspaceId: string;
    memberId: string;
    role: "owner" | "member";
  }) {
    return this.withTransaction(async (client) => {
      const currentMembership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [input.currentUserId, input.workspaceId],
        null,
      );
      if (!currentMembership || currentMembership.role !== "owner") {
        throw new Error("WORKSPACE_OWNER_REQUIRED");
      }

      const membership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE id = $1 AND workspace_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [input.memberId, input.workspaceId],
        null,
      );
      if (!membership) {
        throw new Error("WORKSPACE_MEMBER_NOT_FOUND");
      }

      const ownerRows = await client.query<{ data: WorkspaceMembershipRecord }>(
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE workspace_id = $1 AND (data->>'role') = 'owner'
          FOR UPDATE
        `,
        [input.workspaceId],
      );
      const owners = ownerRows.rows.map((row) => row.data);
      if (membership.role === "owner" && input.role !== "owner" && owners.length <= 1) {
        throw new Error("LAST_OWNER_REQUIRED");
      }

      membership.role = input.role;
      await this.upsertWorkspaceMemberWithClient(client, membership);

      const workspace = await this.querySingleByParamWithClient<WorkspaceRecord>(
        client,
        `SELECT data FROM xlb_workspaces_catalog WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [input.workspaceId],
        null,
      );
      if (workspace && workspace.ownerUserId === membership.userId && input.role !== "owner") {
        const nextOwner = owners.find((item) => item.userId !== membership.userId) ?? currentMembership;
        workspace.ownerUserId = nextOwner.userId;
        await this.upsertWorkspaceWithClient(client, workspace);
      }
    });
  }

  async removeWorkspaceMember(input: {
    currentUserId: string;
    workspaceId: string;
    memberId: string;
  }) {
    return this.withTransaction(async (client) => {
      const currentMembership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE user_id = $1 AND workspace_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [input.currentUserId, input.workspaceId],
        null,
      );
      if (!currentMembership || currentMembership.role !== "owner") {
        throw new Error("WORKSPACE_OWNER_REQUIRED");
      }

      const membership = await this.querySingleByParamWithClient<WorkspaceMembershipRecord>(
        client,
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE id = $1 AND workspace_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [input.memberId, input.workspaceId],
        null,
      );
      if (!membership) {
        throw new Error("WORKSPACE_MEMBER_NOT_FOUND");
      }

      const ownerRows = await client.query<{ data: WorkspaceMembershipRecord }>(
        `
          SELECT data
          FROM xlb_workspace_members
          WHERE workspace_id = $1 AND (data->>'role') = 'owner'
          FOR UPDATE
        `,
        [input.workspaceId],
      );
      const owners = ownerRows.rows.map((row) => row.data);
      if (membership.role === "owner" && owners.length <= 1) {
        throw new Error("LAST_OWNER_REQUIRED");
      }

      const targetUser = await this.lockUserById(client, membership.userId);
      if (targetUser.activeWorkspaceId === input.workspaceId) {
        const nextWorkspaceRow = await client.query<{ workspace_id: string }>(
          `
            SELECT workspace_id
            FROM xlb_workspace_members
            WHERE user_id = $1 AND workspace_id <> $2
            ORDER BY updated_at DESC
            LIMIT 1
          `,
          [membership.userId, input.workspaceId],
        );
        const nextWorkspaceId = nextWorkspaceRow.rows[0]?.workspace_id;
        if (!nextWorkspaceId) {
          throw new Error("TARGET_USER_HAS_NO_FALLBACK_WORKSPACE");
        }
        targetUser.activeWorkspaceId = nextWorkspaceId;
        await this.upsertUserWithClient(client, targetUser);
      }

      await client.query(`DELETE FROM xlb_workspace_members WHERE user_id = $1 AND workspace_id = $2`, [
        membership.userId,
        membership.workspaceId,
      ]);

      const workspace = await this.querySingleByParamWithClient<WorkspaceRecord>(
        client,
        `SELECT data FROM xlb_workspaces_catalog WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [input.workspaceId],
        null,
      );
      if (workspace?.ownerUserId === membership.userId) {
        const nextOwner = owners.find((item) => item.userId !== membership.userId) ?? currentMembership;
        workspace.ownerUserId = nextOwner.userId;
        await this.upsertWorkspaceWithClient(client, workspace);
      }
    });
  }

  async applyWalletTransactionForUser(input: {
    userId: string;
    transaction: Omit<WalletTransactionRecord, "walletId" | "userId" | "balanceAfterCny"> & { id: string };
  }) {
    return this.withSchemaRetry(async () => {
      if (!this.pool) {
        throw new Error("DATABASE_URL is not configured");
      }

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        const wallet = await this.lockWalletByUserId(client, input.userId);
        const nextWallet: WalletRecord = {
          ...wallet,
          balanceCny: this.roundCurrency(wallet.balanceCny + input.transaction.amountCny),
        };
        const transaction: WalletTransactionRecord = {
          ...input.transaction,
          walletId: wallet.id,
          userId: input.userId,
          balanceAfterCny: nextWallet.balanceCny,
        };

        await client.query(
          `
            UPDATE xlb_wallets
            SET data = $2::jsonb, updated_at = NOW()
            WHERE id = $1
          `,
          [wallet.id, JSON.stringify(nextWallet)],
        );
        await client.query(
          `
            INSERT INTO xlb_wallet_transactions (id, workspace_id, created_at, updated_at, data)
            VALUES ($1, $2, $3::timestamptz, NOW(), $4::jsonb)
            ON CONFLICT (id)
            DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at, updated_at = NOW()
          `,
          [
            transaction.id,
            transaction.workspaceId,
            transaction.createdAt,
            JSON.stringify(transaction),
          ],
        );

        await client.query("COMMIT");
        return {
          wallet: nextWallet,
          transaction,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }, null);
  }

  async recordUsageAndCharge(input: {
    userId: string;
    ledger: UsageLedgerRecord;
    charge?: Omit<WalletTransactionRecord, "walletId" | "userId" | "balanceAfterCny"> & { id: string };
  }) {
    return this.withSchemaRetry(async () => {
      if (!this.pool) {
        throw new Error("DATABASE_URL is not configured");
      }

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        const wallet = await this.lockWalletByUserId(client, input.userId);
        const insertedLedger = await client.query<{ data: UsageLedgerRecord }>(
          `
            INSERT INTO xlb_usage_ledger (id, workspace_id, deployment_id, request_id, finished_at, updated_at, data)
            VALUES ($1, $2, $3, $4, $5::timestamptz, NOW(), $6::jsonb)
            ON CONFLICT (workspace_id, deployment_id, request_id)
            DO NOTHING
            RETURNING data
          `,
          [
            input.ledger.id,
            input.ledger.workspaceId,
            input.ledger.deploymentId,
            input.ledger.requestId,
            input.ledger.finishedAt,
            JSON.stringify(input.ledger),
          ],
        );

        if (insertedLedger.rowCount === 0) {
          const existingLedger = await client.query<{ data: UsageLedgerRecord }>(
            `
              SELECT data
              FROM xlb_usage_ledger
              WHERE workspace_id = $1 AND deployment_id = $2 AND request_id = $3
              LIMIT 1
            `,
            [input.ledger.workspaceId, input.ledger.deploymentId, input.ledger.requestId],
          );

          await client.query("COMMIT");
          return {
            created: false,
            ledger: existingLedger.rows[0]?.data ?? input.ledger,
            wallet,
            transaction: null,
          };
        }

        let nextWallet = wallet;
        let transaction: WalletTransactionRecord | null = null;

        if (input.charge) {
          nextWallet = {
            ...wallet,
            balanceCny: this.roundCurrency(wallet.balanceCny + input.charge.amountCny),
          };
          transaction = {
            ...input.charge,
            walletId: wallet.id,
            userId: input.userId,
            balanceAfterCny: nextWallet.balanceCny,
          };

          await client.query(
            `
              UPDATE xlb_wallets
              SET data = $2::jsonb, updated_at = NOW()
              WHERE id = $1
            `,
            [wallet.id, JSON.stringify(nextWallet)],
          );
          await client.query(
            `
              INSERT INTO xlb_wallet_transactions (id, workspace_id, created_at, updated_at, data)
              VALUES ($1, $2, $3::timestamptz, NOW(), $4::jsonb)
              ON CONFLICT (id)
              DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at, updated_at = NOW()
            `,
            [
              transaction.id,
              transaction.workspaceId,
              transaction.createdAt,
              JSON.stringify(transaction),
            ],
          );
        }

        await client.query("COMMIT");
        return {
          created: true,
          ledger: input.ledger,
          wallet: nextWallet,
          transaction,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }, null);
  }

  getHealthSnapshot() {
    return {
      enabled: this.pool !== null,
      initialized: this.initialized,
      pool: this.pool
        ? {
            total: this.pool.totalCount,
            idle: this.pool.idleCount,
            waiting: this.pool.waitingCount,
          }
        : null,
    };
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
          expires_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL
        )
      `,
    );
    if (this.pool) {
      await this.pool.query(`
        ALTER TABLE xlb_sessions
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
      `);
      await this.pool.query(`
        UPDATE xlb_sessions
        SET expires_at = COALESCE((data->>'expiresAt')::timestamptz, NOW() + INTERVAL '30 days')
        WHERE expires_at IS NULL
      `);
      await this.pool.query(`
        ALTER TABLE xlb_sessions
        ALTER COLUMN expires_at SET NOT NULL
      `);
    }
    await this.ensureTableExists(
      "xlb_local_gateway_credentials",
      `
        CREATE TABLE IF NOT EXISTS xlb_local_gateway_credentials (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_scope_id TEXT NOT NULL,
          token_id TEXT NOT NULL UNIQUE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data JSONB NOT NULL,
          UNIQUE (user_id, account_scope_id)
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
        CREATE INDEX IF NOT EXISTS xlb_wallets_user_idx
          ON xlb_wallets ((data->>'userId'));
        CREATE INDEX IF NOT EXISTS xlb_usage_ledger_workspace_idx
          ON xlb_usage_ledger (workspace_id, finished_at DESC);
        CREATE INDEX IF NOT EXISTS xlb_wallet_transactions_workspace_idx
          ON xlb_wallet_transactions (workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS xlb_local_gateway_credentials_user_scope_idx
          ON xlb_local_gateway_credentials (user_id, account_scope_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS xlb_local_gateway_credentials_token_idx
          ON xlb_local_gateway_credentials (token_id);
        CREATE INDEX IF NOT EXISTS xlb_sessions_user_idx
          ON xlb_sessions (user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS xlb_sessions_token_idx
          ON xlb_sessions (token);
        CREATE INDEX IF NOT EXISTS xlb_sessions_user_expires_idx
          ON xlb_sessions (user_id, expires_at DESC);
        CREATE INDEX IF NOT EXISTS xlb_sessions_expires_idx
          ON xlb_sessions (expires_at);
      `);
    }
  }

  private async queryRows<T>(sql: string, fallback: T[]) {
    return this.withSchemaRetry(async () => {
      if (!this.pool) {
        return fallback;
      }

      const result = await this.pool.query<{ data: T }>(sql);
      return result.rows.map((row) => row.data);
    }, fallback);
  }

  private async querySingle<T>(sql: string, fallback: T | null) {
    return this.querySingleByParam(sql, [], fallback);
  }

  private async querySingleByParam<T>(sql: string, params: unknown[], fallback: T | null) {
    return this.withSchemaRetry(async () => {
      if (!this.pool) {
        return fallback;
      }

      const result = await this.pool.query<{ data: T }>(sql, params);
      return result.rows[0]?.data ?? fallback;
    }, fallback);
  }

  private async querySingleByParamWithClient<T>(
    client: PoolClient,
    sql: string,
    params: unknown[],
    fallback: T | null,
  ) {
    const result = await client.query<{ data: T }>(sql, params);
    return result.rows[0]?.data ?? fallback;
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return this.withSchemaRetry(async () => {
      if (!this.pool) {
        throw new Error("DATABASE_URL is not configured");
      }

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const value = await operation(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }, null as T | null);
  }

  private async upsertScopedJson(
    tableName: "xlb_deployments" | "xlb_wallets" | "xlb_workspaces_catalog",
    scopeColumn: "workspace_id" | "owner_user_id",
    id: string,
    scopeValue: string,
    data: unknown,
  ) {
    await this.withSchemaRetry(
      async () => {
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
      },
      undefined,
    );
  }

  private async upsertDataOnlyJson(
    tableName: "xlb_users",
    id: string,
    data: unknown,
  ) {
    await this.withSchemaRetry(
      async () => {
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
      },
      undefined,
    );
  }

  private async upsertUserWithClient(client: PoolClient, record: AuthUserRecord) {
    await client.query(
      `
        INSERT INTO xlb_users (id, email, updated_at, data)
        VALUES ($1, ($2::jsonb->>'email'), NOW(), $2::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET email = EXCLUDED.email, data = EXCLUDED.data, updated_at = NOW()
      `,
      [record.id, JSON.stringify(record)],
    );
  }

  private async upsertWorkspaceWithClient(client: PoolClient, record: WorkspaceRecord) {
    await client.query(
      `
        INSERT INTO xlb_workspaces_catalog (id, owner_user_id, updated_at, data)
        VALUES ($1, $2, NOW(), $3::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, data = EXCLUDED.data, updated_at = NOW()
      `,
      [record.id, record.ownerUserId, JSON.stringify(record)],
    );
  }

  private async upsertWorkspaceMemberWithClient(client: PoolClient, record: WorkspaceMembershipRecord) {
    await client.query(
      `
        INSERT INTO xlb_workspace_members (id, user_id, workspace_id, updated_at, data)
        VALUES ($1, $2, $3, NOW(), $4::jsonb)
        ON CONFLICT (user_id, workspace_id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `,
      [record.id, record.userId, record.workspaceId, JSON.stringify(record)],
    );
  }

  private async upsertWalletWithClient(client: PoolClient, record: WalletRecord) {
    await client.query(
      `
        INSERT INTO xlb_wallets (id, workspace_id, updated_at, data)
        VALUES ($1, $2, NOW(), $3::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET workspace_id = EXCLUDED.workspace_id, data = EXCLUDED.data, updated_at = NOW()
      `,
      [record.id, record.workspaceId, JSON.stringify(record)],
    );
  }

  private async upsertSessionWithClient(client: PoolClient, record: SessionRecord) {
    await client.query(
      `
        INSERT INTO xlb_sessions (id, token, user_id, expires_at, updated_at, data)
        VALUES ($1, $2, $3, $4::timestamptz, NOW(), $5::jsonb)
        ON CONFLICT (token)
        DO UPDATE SET
          data = EXCLUDED.data,
          user_id = EXCLUDED.user_id,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
      `,
      [record.id, record.token, record.userId, record.expiresAt, JSON.stringify(record)],
    );
  }

  private async withSchemaRetry<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    await this.ensureInitialized();
    if (!this.pool) {
      return fallback;
    }

    try {
      return await operation();
    } catch (error) {
      if (!this.isUndefinedTableError(error)) {
        throw error;
      }

      this.logger.warn("Store schema missing during request; recreating xlb_* tables and retrying.");
      this.ensuredTables.clear();
      await this.ensureBaseSchema();
      return operation();
    }
  }

  private isUndefinedTableError(error: unknown) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "42P01"
    );
  }

  private async lockWalletByUserId(client: PoolClient, userId: string) {
    const result = await client.query<{ id: string; data: WalletRecord }>(
      `
        SELECT id, data
        FROM xlb_wallets
        WHERE data->>'userId' = $1
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [userId],
    );

    const wallet = result.rows[0]?.data;
    if (!wallet) {
      throw new Error(`Wallet for user ${userId} not found`);
    }

    return wallet;
  }

  private async lockUserById(client: PoolClient, userId: string) {
    const result = await client.query<{ data: AuthUserRecord }>(
      `
        SELECT data
        FROM xlb_users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [userId],
    );

    const user = result.rows[0]?.data;
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    return user;
  }

  private readPositiveIntegerEnv(name: string, fallback: number) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  private roundCurrency(value: number) {
    return Math.round(value * 1000000) / 1000000;
  }
}
