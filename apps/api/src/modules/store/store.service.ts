import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import {
  AuthUserRecord,
  BillingFeedRecord,
  DeploymentUsageSummaryRecord,
  DeploymentAccessRecord,
  DeploymentGatewayKeyRecord,
  DeploymentRecord,
  DeploymentStatus,
  LocalGatewayCredentialRecord,
  UsageLedgerRecord,
  UsageSummaryRecord,
  SessionRecord,
  UserRecord,
  WalletRecord,
  WalletTransactionRecord,
  WorkspaceMembershipRecord,
  WorkspaceRecord,
  WorkspaceMemberViewRecord,
  WorkspaceViewRecord,
} from "./models";
import { PostgresStateService } from "./postgres-state.service";

const DEFAULT_PUBLIC_APP_BASE_URL = (
  process.env.XLB_APP_PUBLIC_BASE_URL?.trim() ||
  (process.env.ROOT_DOMAIN?.trim() ? `https://${process.env.ROOT_DOMAIN.trim()}` : "https://xiaolanbu.com")
).replace(/\/+$/, "");

interface CreateDeploymentInput {
  id?: string;
  workspaceId: string;
  name: string;
  mode: "local" | "cloud";
  status?: DeploymentStatus;
  region?: string;
  provider?: string;
  consoleUrl?: string;
  gatewayUrl?: string;
  publicIpAddress?: string[];
  privateIpAddress?: string[];
  zoneId?: string;
  vendorInstanceIds?: string[];
  access?: DeploymentAccessRecord;
  gatewayKey?: DeploymentGatewayKeyRecord;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class StoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StoreService.name);
  private readonly stateRefreshMinIntervalMs = this.readStateRefreshMinIntervalMs();
  private readonly sessionTtlMs = this.readSessionTtlMs();
  private readonly sessionTouchIntervalMs = this.readSessionTouchIntervalMs();
  private readonly sessionCleanupIntervalMs = this.readSessionCleanupIntervalMs();
  private refreshInFlight: Promise<void> | null = null;
  private lastDatabaseRefreshAt = 0;
  private sessionCleanupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly postgresStateService: PostgresStateService) {}

  private workspaces: WorkspaceRecord[] = [
    {
      id: "ws_main",
      ownerUserId: "user_001",
      name: "小懒布主工作区",
      planName: "陪跑版",
      status: "active",
    },
    {
      id: "ws_team",
      ownerUserId: "user_001",
      name: "小懒布团队工作区",
      planName: "专业版",
      status: "trial",
    },
    {
      id: "ws_demo_user",
      ownerUserId: "user_002",
      name: "普通测试用户工作区",
      planName: "轻享版",
      status: "active",
    },
  ];

  private users: AuthUserRecord[] = [
    {
      id: "user_001",
      displayName: "午松",
      email: "owner@xiaolanbu.app",
      avatarInitial: "午",
      activeWorkspaceId: "ws_main",
      passwordHash: this.hashPassword("Xiaolanbu123!"),
      createdAt: "2026-03-08T10:00:00.000Z",
    },
    {
      id: "user_002",
      displayName: "测试用户",
      email: "demo@xiaolanbu.app",
      avatarInitial: "测",
      activeWorkspaceId: "ws_demo_user",
      passwordHash: this.hashPassword("DemoUser123!"),
      createdAt: "2026-03-10T09:30:00.000Z",
    },
  ];

  private workspaceMembers: WorkspaceMembershipRecord[] = [
    {
      id: "wsm_main_owner",
      userId: "user_001",
      workspaceId: "ws_main",
      role: "owner",
      createdAt: "2026-03-08T10:00:00.000Z",
    },
    {
      id: "wsm_team_owner",
      userId: "user_001",
      workspaceId: "ws_team",
      role: "owner",
      createdAt: "2026-03-08T10:00:00.000Z",
    },
    {
      id: "wsm_demo_owner",
      userId: "user_002",
      workspaceId: "ws_demo_user",
      role: "owner",
      createdAt: "2026-03-10T09:30:00.000Z",
    },
  ];

  private sessions: SessionRecord[] = [];
  private localGatewayCredentials: LocalGatewayCredentialRecord[] = [];

  private deployments: DeploymentRecord[] = [
    {
      id: "dep_cloud_prod",
      workspaceId: "ws_main",
      ownerUserId: "user_001",
      name: "云端托管实例",
      mode: "cloud",
      status: "running",
      provider: "aliyun",
      region: "ap-southeast-1",
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl: `${DEFAULT_PUBLIC_APP_BASE_URL}/demo/cloud`,
      gatewayUrl: "https://gateway.xiaolanbu.com/v1",
      createdAt: "2026-03-09T09:20:00.000Z",
      lastHeartbeatAt: "2026-03-09T12:08:00.000Z",
      access: {
        browserControlUrl: `${DEFAULT_PUBLIC_APP_BASE_URL}/demo/cloud/browser`,
      },
    },
  ];

  private wallets: WalletRecord[] = [
    {
      id: "wallet_main",
      workspaceId: "ws_main",
      userId: "user_001",
      balanceCny: 286.4,
      frozenCny: 0,
      currency: "CNY",
    },
    {
      id: "wallet_team",
      workspaceId: "ws_team",
      userId: "user_001",
      balanceCny: 88,
      frozenCny: 0,
      currency: "CNY",
    },
    {
      id: "wallet_demo_user",
      workspaceId: "ws_demo_user",
      userId: "user_002",
      balanceCny: 128,
      frozenCny: 0,
      currency: "CNY",
    },
  ];

  private readonly usageSummaries: UsageSummaryRecord[] = [
    {
      workspaceId: "ws_main",
      userId: "user_001",
      period: "today",
      requestCount: 142,
      totalTokens: 186420,
      totalCostCny: 18.72,
      topModels: [
        { model: "qwen-max", tokens: 80210, costCny: 8.2 },
        { model: "gpt-4.1-mini", tokens: 69500, costCny: 6.12 },
        { model: "claude-3.5-haiku", tokens: 36710, costCny: 4.4 },
      ],
    },
    {
      workspaceId: "ws_main",
      userId: "user_001",
      period: "30d",
      requestCount: 2861,
      totalTokens: 3429050,
      totalCostCny: 318.64,
      topModels: [
        { model: "qwen-max", tokens: 1380210, costCny: 128.2 },
        { model: "gpt-4.1-mini", tokens: 1239500, costCny: 106.84 },
        { model: "claude-3.5-haiku", tokens: 809340, costCny: 83.6 },
      ],
    },
    {
      workspaceId: "ws_team",
      userId: "user_001",
      period: "today",
      requestCount: 0,
      totalTokens: 0,
      totalCostCny: 0,
      topModels: [],
    },
    {
      workspaceId: "ws_team",
      userId: "user_001",
      period: "30d",
      requestCount: 0,
      totalTokens: 0,
      totalCostCny: 0,
      topModels: [],
    },
  ];

  private readonly billingFeed: BillingFeedRecord[] = [
    {
      id: "bill_001",
      workspaceId: "ws_main",
      userId: "user_001",
      kind: "usage",
      title: "今日模型调用汇总",
      amountCny: -18.72,
      createdAt: "2026-03-09T12:00:00.000Z",
    },
    {
      id: "bill_002",
      workspaceId: "ws_main",
      userId: "user_001",
      kind: "topup",
      title: "余额充值",
      amountCny: 200,
      createdAt: "2026-03-08T18:20:00.000Z",
    },
    {
      id: "bill_003",
      workspaceId: "ws_main",
      userId: "user_001",
      kind: "usage",
      title: "昨日模型调用汇总",
      amountCny: -22.45,
      createdAt: "2026-03-08T12:00:00.000Z",
    },
    {
      id: "bill_team_001",
      workspaceId: "ws_team",
      userId: "user_001",
      kind: "topup",
      title: "团队工作区初始额度",
      amountCny: 88,
      createdAt: "2026-03-09T10:00:00.000Z",
    },
    {
      id: "bill_demo_001",
      workspaceId: "ws_demo_user",
      userId: "user_002",
      kind: "topup",
      title: "普通测试用户初始余额",
      amountCny: 128,
      createdAt: "2026-03-10T09:30:00.000Z",
    },
  ];

  private usageLedger: UsageLedgerRecord[] = [];

  private walletTransactions: WalletTransactionRecord[] = [
    {
      id: "txn_001",
      walletId: "wallet_main",
      workspaceId: "ws_main",
      userId: "user_001",
      type: "topup",
      title: "余额充值",
      amountCny: 200,
      balanceAfterCny: 286.4,
      createdAt: "2026-03-08T18:20:00.000Z",
      referenceType: "topup",
      referenceId: "topup_001",
    },
    {
      id: "txn_demo_001",
      walletId: "wallet_demo_user",
      workspaceId: "ws_demo_user",
      userId: "user_002",
      type: "topup",
      title: "普通测试用户初始余额",
      amountCny: 128,
      balanceAfterCny: 128,
      createdAt: "2026-03-10T09:30:00.000Z",
      referenceType: "topup",
      referenceId: "topup_demo_001",
    },
  ];

  async onModuleInit() {
    await this.postgresStateService.ensureInitialized();

    if (!this.postgresStateService.isEnabled()) {
      return;
    }

    const [
      persistedDeployments,
      persistedLocalGatewayCredentials,
      persistedWallets,
      persistedUsageLedger,
      persistedWalletTransactions,
      persistedUsers,
      persistedWorkspaces,
      persistedWorkspaceMembers,
    ] = await Promise.all([
      this.postgresStateService.listDeployments(),
      this.postgresStateService.listLocalGatewayCredentials(),
      this.postgresStateService.listWallets(),
      this.postgresStateService.listUsageLedger(),
      this.postgresStateService.listWalletTransactions(),
      this.postgresStateService.listUsers(),
      this.postgresStateService.listWorkspacesCatalog(),
      this.postgresStateService.listWorkspaceMembers(),
    ]);
    await this.normalizeAccountBillingState();

    if (persistedDeployments.length === 0) {
      await Promise.all(this.deployments.map((item) => this.postgresStateService.upsertDeployment(item)));
    }
    if (persistedWallets.length === 0) {
      await Promise.all(this.wallets.map((item) => this.postgresStateService.upsertWallet(item)));
    }
    if (persistedUsageLedger.length === 0 && this.usageLedger.length > 0) {
      await Promise.all(this.usageLedger.map((item) => this.postgresStateService.insertUsageLedger(item)));
    }
    if (persistedWalletTransactions.length === 0 && this.walletTransactions.length > 0) {
      await Promise.all(
        this.walletTransactions.map((item) => this.postgresStateService.insertWalletTransaction(item)),
      );
    }
    if (persistedUsers.length === 0) {
      await Promise.all(this.users.map((item) => this.postgresStateService.upsertUser(item)));
    }
    if (persistedWorkspaces.length === 0) {
      await Promise.all(this.workspaces.map((item) => this.postgresStateService.upsertWorkspace(item)));
    }
    if (persistedWorkspaceMembers.length === 0) {
      await Promise.all(
        this.workspaceMembers.map((item) => this.postgresStateService.upsertWorkspaceMember(item)),
      );
    }
    await this.postgresStateService.deleteLegacyCurrentUserState();
    await this.refreshStateFromDatabase({
      force: true,
      reason: "startup",
    });

    this.logger.log(
      `Loaded persisted state: deployments=${persistedDeployments.length}, localCredentials=${persistedLocalGatewayCredentials.length}, wallets=${persistedWallets.length}, ledger=${persistedUsageLedger.length}, transactions=${persistedWalletTransactions.length}`,
    );
    this.lastDatabaseRefreshAt = Date.now();
    this.startSessionCleanupLoop();
    this.logger.log(
      `DB-first store enabled. sessionTtlMs=${this.sessionTtlMs} touchIntervalMs=${this.sessionTouchIntervalMs} cleanupIntervalMs=${this.sessionCleanupIntervalMs}`,
    );
  }

  onModuleDestroy() {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }
  }

  async refreshStateFromDatabase(options?: { force?: boolean; reason?: string }) {
    if (!this.postgresStateService.isEnabled()) {
      return;
    }

    const force = options?.force === true;
    const now = Date.now();
    if (
      !force &&
      this.lastDatabaseRefreshAt > 0 &&
      now - this.lastDatabaseRefreshAt < this.stateRefreshMinIntervalMs
    ) {
      return;
    }

    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }

    this.refreshInFlight = this.reloadStateFromDatabase(options?.reason).finally(() => {
      this.refreshInFlight = null;
    });
    await this.refreshInFlight;
  }

  getUserBySessionToken(token?: string | null) {
    if (!token) {
      return null;
    }

    const session = this.sessions.find((item) => item.token === token);
    if (!session) {
      return null;
    }

    return this.users.find((item) => item.id === session.userId) ?? null;
  }

  getAuthContext(token?: string | null) {
    const user = this.getUserBySessionToken(token);
    if (!user) {
      return null;
    }

    return this.buildAuthContextForUser(user);
  }

  async listUsersAsync() {
    if (!this.postgresStateService.isEnabled()) {
      return this.listUsers();
    }

    const users = await this.postgresStateService.listUsers();
    return Promise.all(users.map((user) => this.toUserRecordAsync(user)));
  }

  async getUserAsync(userId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.getUser(userId);
    }

    const user = await this.postgresStateService.getUserById(userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    return user;
  }

  async getUserByEmailAsync(email: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.users.find((item) => item.email.toLowerCase() === email.toLowerCase()) ?? null;
    }

    return this.postgresStateService.getUserByEmail(email.trim().toLowerCase());
  }

  async getUserBySessionTokenAsync(token?: string | null) {
    if (!token) {
      return null;
    }

    if (!this.postgresStateService.isEnabled()) {
      return this.getUserBySessionToken(token);
    }

    const now = new Date().toISOString();
    const session = await this.postgresStateService.getValidSessionByToken(token, now);
    if (!session) {
      return null;
    }

    return this.postgresStateService.getUserById(session.userId);
  }

  async getAuthContextAsync(token?: string | null) {
    const user = await this.getUserBySessionTokenAsync(token);
    if (!user) {
      return null;
    }

    return this.buildAuthContextForUserAsync(user);
  }

  async getWorkspaceAsync(workspaceId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.getWorkspace(workspaceId);
    }

    const workspace = await this.postgresStateService.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    return workspace;
  }

  async listUserWorkspacesAsync(userId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.listUserWorkspaces(userId);
    }

    const [workspaces, memberships] = await Promise.all([
      this.postgresStateService.listWorkspacesCatalog(),
      this.postgresStateService.listWorkspaceMembers(),
    ]);
    const workspaceIds = new Set(
      memberships.filter((item) => item.userId === userId).map((item) => item.workspaceId),
    );
    return workspaces.filter((item) => workspaceIds.has(item.id) && item.status !== "archived");
  }

  async listUserWorkspaceViewsAsync(userId: string): Promise<WorkspaceViewRecord[]> {
    const workspaces = await this.listUserWorkspacesAsync(userId);
    return Promise.all(
      workspaces.map(async (workspace) => ({
        ...workspace,
        role: (await this.getWorkspaceMembershipAsync(userId, workspace.id))?.role ?? "member",
      })),
    );
  }

  async listWorkspaceMembersAsync(workspaceId: string): Promise<WorkspaceMemberViewRecord[]> {
    if (!this.postgresStateService.isEnabled()) {
      return this.listWorkspaceMembers(workspaceId);
    }

    await this.getWorkspaceAsync(workspaceId);
    const [memberships, users] = await Promise.all([
      this.postgresStateService.listWorkspaceMembers(),
      this.postgresStateService.listUsers(),
    ]);
    const usersById = new Map(users.map((item) => [item.id, item] as const));

    return memberships
      .filter((item) => item.workspaceId === workspaceId)
      .map((item) => {
        const user = usersById.get(item.userId);
        if (!user) {
          throw new NotFoundException(`User ${item.userId} not found`);
        }

        return {
          id: item.id,
          userId: item.userId,
          workspaceId: item.workspaceId,
          role: item.role,
          createdAt: item.createdAt,
          user: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
            avatarInitial: user.avatarInitial,
            activeWorkspaceId: user.activeWorkspaceId,
            accountScopeId: user.activeWorkspaceId,
            defaultScopeId: user.activeWorkspaceId,
          },
        };
      })
      .sort((left, right) => {
        if (left.role !== right.role) {
          return left.role === "owner" ? -1 : 1;
        }
        return left.user.displayName.localeCompare(right.user.displayName, "zh-CN");
      });
  }

  async getWorkspaceMembershipAsync(userId: string, workspaceId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.getWorkspaceMembership(userId, workspaceId);
    }

    return this.postgresStateService.getWorkspaceMembership(userId, workspaceId);
  }

  async assertUserHasWorkspaceAccessAsync(userId: string, workspaceId: string) {
    const targetWorkspace = (await this.listUserWorkspacesAsync(userId)).find((item) => item.id === workspaceId);
    if (!targetWorkspace) {
      throw new ForbiddenException(`Workspace ${workspaceId} is not accessible for user ${userId}`);
    }
    return targetWorkspace;
  }

  async assertUserCanManageWorkspaceAsync(userId: string, workspaceId: string) {
    const membership = await this.getWorkspaceMembershipAsync(userId, workspaceId);
    if (!membership) {
      throw new ForbiddenException(`Workspace ${workspaceId} is not accessible for user ${userId}`);
    }
    if (membership.role !== "owner") {
      throw new ForbiddenException(`Workspace ${workspaceId} requires owner role`);
    }
    return membership;
  }

  async getPreferredWorkspaceIdForUserAsync(userId: string) {
    const user = await this.getUserAsync(userId);
    const activeWorkspaceId = user.activeWorkspaceId?.trim();
    if (activeWorkspaceId) {
      const accessible = (await this.listUserWorkspacesAsync(userId)).find(
        (item) => item.id === activeWorkspaceId,
      );
      if (accessible) {
        return accessible.id;
      }
    }

    const fallbackWorkspace = (await this.listUserWorkspacesAsync(userId))[0];
    if (!fallbackWorkspace) {
      throw new NotFoundException(`User ${userId} has no available workspace`);
    }

    return fallbackWorkspace.id;
  }

  async getBillingUserIdForWorkspaceAsync(workspaceId: string) {
    return (await this.getWorkspaceAsync(workspaceId)).ownerUserId;
  }

  async listDeploymentsAsync(workspaceId?: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.listDeployments(workspaceId);
    }

    const deployments = await this.postgresStateService.listDeployments();
    if (!workspaceId) {
      return deployments;
    }
    await this.getWorkspaceAsync(workspaceId);
    return deployments.filter((item) => item.workspaceId === workspaceId);
  }

  async listLocalGatewayCredentialsAsync(input?: { userId?: string; accountScopeId?: string }) {
    const items = this.postgresStateService.isEnabled()
      ? await this.postgresStateService.listLocalGatewayCredentials()
      : this.localGatewayCredentials;

    return items.filter((item) => {
      if (input?.userId && item.userId !== input.userId) {
        return false;
      }
      if (input?.accountScopeId && item.accountScopeId !== input.accountScopeId) {
        return false;
      }
      return true;
    });
  }

  async getLocalGatewayCredentialAsync(userId: string, accountScopeId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return (
        this.localGatewayCredentials.find(
          (item) => item.userId === userId && item.accountScopeId === accountScopeId,
        ) ?? null
      );
    }

    return this.postgresStateService.getLocalGatewayCredentialByUserAndScope(userId, accountScopeId);
  }

  async getLocalGatewayCredentialByTokenIdAsync(tokenId?: string | null) {
    const normalizedTokenId = typeof tokenId === "string" ? tokenId.trim() : "";
    if (!normalizedTokenId) {
      return null;
    }

    if (!this.postgresStateService.isEnabled()) {
      return this.localGatewayCredentials.find((item) => item.tokenId === normalizedTokenId) ?? null;
    }

    return this.postgresStateService.getLocalGatewayCredentialByTokenId(normalizedTokenId);
  }

  async upsertLocalGatewayCredential(record: LocalGatewayCredentialRecord) {
    if (!this.postgresStateService.isEnabled()) {
      this.upsertLocalGatewayCredentialRecord(record);
      await this.postgresStateService.upsertLocalGatewayCredential(record);
      return record;
    }

    await this.postgresStateService.upsertLocalGatewayCredential(record);
    await this.refreshLocalStateAfterWrite("upsert-local-gateway-credential");
    return (await this.getLocalGatewayCredentialAsync(record.userId, record.accountScopeId)) ?? record;
  }

  async getDeploymentAsync(deploymentId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.getDeployment(deploymentId);
    }

    const deployment = await this.postgresStateService.getDeploymentById(deploymentId);
    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    return deployment;
  }

  async getDeploymentByGatewaySecretAsync(secretKey?: string | null) {
    const normalizedSecret = typeof secretKey === "string" ? secretKey.trim() : "";
    if (!normalizedSecret) {
      return null;
    }

    if (!this.postgresStateService.isEnabled()) {
      return (
        this.deployments.find((item) => item.gatewayKey?.secretKey?.trim() === normalizedSecret) ?? null
      );
    }

    return this.postgresStateService.getDeploymentByGatewaySecret(normalizedSecret);
  }

  async listDeploymentsOwnedByUserAsync(userId: string) {
    const deployments = await this.listDeploymentsAsync();
    const ownedWorkspaces = new Set((await this.listUserWorkspacesAsync(userId)).map((item) => item.id));
    return deployments.filter(
      (item) =>
        (item.ownerUserId && item.ownerUserId === userId) ||
        (!item.ownerUserId && ownedWorkspaces.has(item.workspaceId)),
    );
  }

  async listDeploymentsForUserAsync(userId: string, workspaceId?: string) {
    if (workspaceId) {
      await this.assertUserHasWorkspaceAccessAsync(userId, workspaceId);
      return (await this.listDeploymentsOwnedByUserAsync(userId)).filter((item) => item.workspaceId === workspaceId);
    }
    return this.listDeploymentsOwnedByUserAsync(userId);
  }

  async getDeploymentForUserAsync(userId: string, deploymentId: string) {
    const deployment = await this.getDeploymentAsync(deploymentId);
    if ((await this.getBillingUserIdForDeploymentAsync(deploymentId)) !== userId) {
      throw new ForbiddenException(`Deployment ${deploymentId} is not accessible for user ${userId}`);
    }
    return deployment;
  }

  async getBillingUserIdForDeploymentAsync(deploymentId: string) {
    const deployment = await this.getDeploymentAsync(deploymentId);
    return deployment.ownerUserId || (await this.getBillingUserIdForWorkspaceAsync(deployment.workspaceId));
  }

  async getWalletByUserIdAsync(userId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.getWalletByUserId(userId);
    }

    await this.getUserAsync(userId);
    const wallet = await this.postgresStateService.getWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException(`Wallet for user ${userId} not found`);
    }
    return wallet;
  }

  async getWalletAsync(workspaceId: string) {
    return this.getWalletByUserIdAsync(await this.getBillingUserIdForWorkspaceAsync(workspaceId));
  }

  async getAuthContextByUserIdAsync(userId: string) {
    const user = await this.getUserAsync(userId);
    return this.buildAuthContextForUserAsync(user);
  }

  async listUsageLedgerByUserIdAsync(
    userId: string,
    input?: {
      deploymentId?: string;
      limit?: number;
    },
  ) {
    if (!this.postgresStateService.isEnabled()) {
      return this.listUsageLedgerByUserId(userId, input);
    }

    const items = (await this.postgresStateService.listUsageLedger())
      .filter((item) => item.userId === userId)
      .filter((item) => (input?.deploymentId ? item.deploymentId === input.deploymentId : true))
      .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));

    if (typeof input?.limit === "number" && input.limit > 0) {
      return items.slice(0, input.limit);
    }

    return items;
  }

  async listUsageLedgerAsync(
    workspaceId: string,
    input?: {
      deploymentId?: string;
      limit?: number;
    },
  ) {
    return this.listUsageLedgerByUserIdAsync(await this.getBillingUserIdForWorkspaceAsync(workspaceId), input);
  }

  async listWalletTransactionsByUserIdAsync(userId: string, limit = 50) {
    if (!this.postgresStateService.isEnabled()) {
      return this.listWalletTransactionsByUserId(userId, limit);
    }

    return (await this.postgresStateService.listWalletTransactions())
      .filter((item) => item.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async listWalletTransactionsAsync(workspaceId: string, limit = 50) {
    return this.listWalletTransactionsByUserIdAsync(
      await this.getBillingUserIdForWorkspaceAsync(workspaceId),
      limit,
    );
  }

  async listBillingFeedByUserIdAsync(userId: string) {
    if (!this.postgresStateService.isEnabled()) {
      return this.listBillingFeedByUserId(userId);
    }

    const transactionFeed = (await this.listWalletTransactionsByUserIdAsync(userId, 200)).map<BillingFeedRecord>(
      (item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        userId: item.userId,
        kind: item.type === "topup" ? "topup" : item.type === "usage" ? "usage" : "adjustment",
        title: item.title,
        amountCny: item.amountCny,
        createdAt: item.createdAt,
      }),
    );

    return transactionFeed.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listBillingFeedAsync(workspaceId: string) {
    return this.listBillingFeedByUserIdAsync(await this.getBillingUserIdForWorkspaceAsync(workspaceId));
  }

  async getUsageSummaryByUserIdAsync(
    userId: string,
    period: "today" | "7d" | "30d",
    workspaceId?: string,
  ) {
    if (!this.postgresStateService.isEnabled()) {
      return this.getUsageSummaryByUserId(userId, period, workspaceId);
    }

    const resolvedWorkspaceId = workspaceId ?? (await this.getPreferredWorkspaceIdForUserAsync(userId));
    const items = await this.listUsageLedgerByUserIdAsync(userId);
    return this.buildUsageSummaryFromItems(items, userId, resolvedWorkspaceId, period);
  }

  async getUsageSummaryAsync(workspaceId: string, period: "today" | "7d" | "30d") {
    return this.getUsageSummaryByUserIdAsync(
      await this.getBillingUserIdForWorkspaceAsync(workspaceId),
      period,
      workspaceId,
    );
  }

  async listDeploymentUsageSummariesByUserIdAsync(
    userId: string,
    period: "today" | "7d" | "30d",
    workspaceId?: string,
  ) {
    if (!this.postgresStateService.isEnabled()) {
      return this.listDeploymentUsageSummariesByUserId(userId, period, workspaceId);
    }

    const resolvedWorkspaceId = workspaceId ?? (await this.getPreferredWorkspaceIdForUserAsync(userId));
    const [items, deployments] = await Promise.all([
      this.listUsageLedgerByUserIdAsync(userId),
      this.listDeploymentsOwnedByUserAsync(userId),
    ]);
    const periodStart = this.getPeriodStartTimestamp(period);
    const ledgerByDeploymentId = new Map<string, UsageLedgerRecord[]>();

    for (const item of items) {
      const finishedAt = Date.parse(item.finishedAt);
      if (!Number.isFinite(finishedAt) || finishedAt < periodStart) {
        continue;
      }
      const bucket = ledgerByDeploymentId.get(item.deploymentId) ?? [];
      bucket.push(item);
      ledgerByDeploymentId.set(item.deploymentId, bucket);
    }

    return deployments
      .filter((deployment) => deployment.mode === "cloud")
      .map<DeploymentUsageSummaryRecord>((deployment) => {
        const deploymentItems = ledgerByDeploymentId.get(deployment.id) ?? [];
        return {
          workspaceId: deployment.workspaceId || resolvedWorkspaceId,
          userId,
          deploymentId: deployment.id,
          deploymentName: deployment.name,
          mode: deployment.mode,
          provider: deployment.provider,
          region: deployment.region,
          status: deployment.status,
          period,
          requestCount: deploymentItems.length,
          totalTokens: deploymentItems.reduce((sum, item) => sum + item.totalTokens, 0),
          totalCostCny: this.roundCurrency(
            deploymentItems.reduce((sum, item) => sum + item.billableCostCny, 0),
          ),
          promptTokens: deploymentItems.reduce((sum, item) => sum + item.promptTokens, 0),
          completionTokens: deploymentItems.reduce((sum, item) => sum + item.completionTokens, 0),
          cachedTokens: deploymentItems.reduce((sum, item) => sum + item.cachedTokens, 0),
          reasoningTokens: deploymentItems.reduce((sum, item) => sum + item.reasoningTokens, 0),
          lastRequestAt:
            deploymentItems
              .map((item) => item.finishedAt)
              .sort((left, right) => right.localeCompare(left))[0] ?? undefined,
        };
      })
      .sort((left, right) => {
        if (right.totalCostCny !== left.totalCostCny) {
          return right.totalCostCny - left.totalCostCny;
        }
        return right.requestCount - left.requestCount;
      });
  }

  async listDeploymentUsageSummariesAsync(
    workspaceId: string,
    period: "today" | "7d" | "30d",
  ) {
    return this.listDeploymentUsageSummariesByUserIdAsync(
      await this.getBillingUserIdForWorkspaceAsync(workspaceId),
      period,
      workspaceId,
    );
  }

  async registerUser(input: { displayName: string; email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    if (await this.getUserByEmailAsync(email)) {
      throw new BadRequestException("该邮箱已存在");
    }

    const userId = `user_${Date.now()}`;
    const now = new Date().toISOString();
    const displayName = input.displayName.trim() || email.split("@")[0] || "用户";

    const user: AuthUserRecord = {
      id: userId,
      displayName,
      email,
      avatarInitial: displayName.charAt(0) || "小",
      activeWorkspaceId: "",
      passwordHash: this.hashPassword(input.password),
      createdAt: now,
    };
    const { workspace, membership, wallet } = this.createOwnedWorkspaceBundle(user.id, {
      name: `${displayName} 的工作区`,
      planName: "轻享版",
      status: "trial",
      initialBalanceCny: 20,
    });
    user.activeWorkspaceId = workspace.id;

    try {
      if (this.postgresStateService.isEnabled()) {
        const session = this.buildSessionRecord(user.id);
        await this.postgresStateService.registerUserBundle({
          user,
          workspace,
          membership,
          wallet,
          session,
        });
        await this.refreshLocalStateAfterWrite("register-user");
        return {
          sessionToken: session.token,
          ...(await this.buildAuthContextForUserAsync(user)),
        };
      }

      this.users.unshift(user);
      this.workspaces.unshift(workspace);
      this.workspaceMembers.unshift(membership);
      this.wallets.unshift(wallet);

      await Promise.all([
        this.postgresStateService.upsertUser(user),
        this.postgresStateService.upsertWorkspace(workspace),
        this.postgresStateService.upsertWorkspaceMember(membership),
        this.postgresStateService.upsertWallet(wallet),
      ]);
      await this.refreshLocalStateAfterWrite("register-user");
      return this.createSessionForUser(await this.getUserAsync(user.id));
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("register-user", error);
      if (this.isUniqueViolation(error)) {
        throw new BadRequestException("该邮箱已存在");
      }
      throw error;
    }
  }

  async createWorkspaceForUser(input: { userId: string; name: string }) {
    const user = await this.getUserAsync(input.userId);

    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException("请先填写工作区名称");
    }

    const existingWallet = await this.getWalletByUserIdAsync(user.id).catch(() => null);
    const { workspace, membership, wallet } = this.createOwnedWorkspaceBundle(user.id, {
      name,
      planName: "轻享版",
      status: "trial",
      initialBalanceCny: 20,
    });
    user.activeWorkspaceId = workspace.id;

    try {
      if (this.postgresStateService.isEnabled()) {
        await this.postgresStateService.createWorkspaceBundle({
          user,
          workspace,
          membership,
          wallet: existingWallet ? null : wallet,
        });
        await this.refreshLocalStateAfterWrite("create-workspace");
        return this.getAuthContextByUserIdAsync(user.id);
      }

      this.workspaces.unshift(workspace);
      this.workspaceMembers.unshift(membership);
      if (!existingWallet) {
        this.wallets.unshift(wallet);
      }

      const writes = [
        this.postgresStateService.upsertWorkspace(workspace),
        this.postgresStateService.upsertWorkspaceMember(membership),
        this.postgresStateService.upsertUser(user),
      ];
      if (!existingWallet) {
        writes.push(this.postgresStateService.upsertWallet(wallet));
      }
      await Promise.all(writes);
      await this.refreshLocalStateAfterWrite("create-workspace");
      return this.getAuthContextByUserIdAsync(user.id);
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("create-workspace", error);
      throw error;
    }
  }

  async updateWorkspaceName(input: { currentUserId: string; workspaceId: string; name: string }) {
    await this.assertUserCanManageWorkspaceAsync(input.currentUserId, input.workspaceId);

    const workspace = await this.getWorkspaceAsync(input.workspaceId);
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException("请先填写工作区名称");
    }

    workspace.name = name;
    try {
      await this.postgresStateService.upsertWorkspace(workspace);
      await this.refreshLocalStateAfterWrite("update-workspace-name");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("update-workspace-name", error);
      throw error;
    }

    return this.getAuthContextByUserIdAsync(input.currentUserId);
  }

  async updateUserProfile(input: { userId: string; displayName: string }) {
    const user = await this.getUserAsync(input.userId);

    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new BadRequestException("请先填写昵称");
    }

    user.displayName = displayName;
    user.avatarInitial = displayName.slice(0, 1).toUpperCase();
    try {
      await this.postgresStateService.upsertUser(user);
      await this.refreshLocalStateAfterWrite("update-user-profile");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("update-user-profile", error);
      throw error;
    }

    return this.getAuthContextByUserIdAsync(input.userId);
  }

  async updateUserPassword(input: { userId: string; currentPassword: string; newPassword: string }) {
    const user = await this.getUserAsync(input.userId);

    if (!this.verifyPassword(input.currentPassword, user.passwordHash)) {
      throw new BadRequestException("当前密码不正确");
    }

    const nextPassword = input.newPassword.trim();
    if (nextPassword.length < 8) {
      throw new BadRequestException("新密码至少需要 8 位");
    }

    user.passwordHash = this.hashPassword(nextPassword);
    try {
      await this.postgresStateService.upsertUser(user);
      await this.refreshLocalStateAfterWrite("update-user-password");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("update-user-password", error);
      throw error;
    }

    return {
      ok: true,
      message: "密码已更新，请用新密码继续登录。",
    };
  }

  async leaveWorkspace(input: { currentUserId: string; workspaceId: string }) {
    await this.assertUserHasWorkspaceAccessAsync(input.currentUserId, input.workspaceId);

    const membership = await this.getWorkspaceMembershipAsync(input.currentUserId, input.workspaceId);
    if (!membership) {
      throw new NotFoundException("你不在当前工作区中");
    }

    const nextWorkspace = (await this.listUserWorkspacesAsync(input.currentUserId)).find(
      (item) => item.id !== input.workspaceId,
    );
    if (!nextWorkspace) {
      throw new BadRequestException("至少保留一个可用工作区后才能退出当前工作区");
    }

    if (membership.role === "owner") {
      const ownerCount = (await this.postgresStateService.listWorkspaceMembers()).filter(
        (item) => item.workspaceId === input.workspaceId && item.role === "owner",
      ).length;
      if (ownerCount <= 1) {
        throw new BadRequestException("当前工作区最后一位拥有者不能直接退出，请先转移拥有者或归档工作区");
      }
    }

    try {
      if (this.postgresStateService.isEnabled()) {
        await this.postgresStateService.leaveWorkspace({
          currentUserId: input.currentUserId,
          workspaceId: input.workspaceId,
          nextWorkspaceId: nextWorkspace.id,
        });
        await this.refreshLocalStateAfterWrite("leave-workspace");
        return this.getAuthContextByUserIdAsync(input.currentUserId);
      }

      this.workspaceMembers = this.workspaceMembers.filter((item) => item.id !== membership.id);
      await this.postgresStateService.deleteWorkspaceMember(membership.userId, membership.workspaceId);

      const currentUser = await this.getUserAsync(input.currentUserId);
      if (currentUser?.activeWorkspaceId === input.workspaceId) {
        currentUser.activeWorkspaceId = nextWorkspace.id;
        await this.postgresStateService.upsertUser(currentUser);
      }
      await this.refreshLocalStateAfterWrite("leave-workspace");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("leave-workspace", error);
      this.throwWorkspaceMutationError(error);
    }

    return this.getAuthContextByUserIdAsync(input.currentUserId);
  }

  async archiveWorkspace(input: { currentUserId: string; workspaceId: string }) {
    await this.assertUserCanManageWorkspaceAsync(input.currentUserId, input.workspaceId);

    const workspace = await this.getWorkspaceAsync(input.workspaceId);
    const nextWorkspace = (await this.listUserWorkspacesAsync(input.currentUserId)).find(
      (item) => item.id !== input.workspaceId,
    );
    if (!nextWorkspace) {
      throw new BadRequestException("至少保留一个可用工作区后才能归档当前工作区");
    }

    const deploymentCount = (await this.listDeploymentsAsync(input.workspaceId)).filter(
      (item) => item.mode === "cloud",
    ).length;
    if (deploymentCount > 0) {
      throw new BadRequestException("请先销毁当前工作区下的全部实例，再归档工作区");
    }

    const memberCount = (await this.postgresStateService.listWorkspaceMembers()).filter(
      (item) => item.workspaceId === input.workspaceId,
    ).length;
    if (memberCount > 1) {
      throw new BadRequestException("请先移除或让其他成员退出当前工作区，再执行归档");
    }

    try {
      if (this.postgresStateService.isEnabled()) {
        await this.postgresStateService.archiveWorkspace({
          currentUserId: input.currentUserId,
          workspaceId: input.workspaceId,
          nextWorkspaceId: nextWorkspace.id,
        });
        await this.refreshLocalStateAfterWrite("archive-workspace");
        return this.getAuthContextByUserIdAsync(input.currentUserId);
      }

      workspace.status = "archived";
      await this.postgresStateService.upsertWorkspace(workspace);

      const currentUser = await this.getUserAsync(input.currentUserId);
      if (currentUser?.activeWorkspaceId === input.workspaceId) {
        currentUser.activeWorkspaceId = nextWorkspace.id;
        await this.postgresStateService.upsertUser(currentUser);
      }
      await this.refreshLocalStateAfterWrite("archive-workspace");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("archive-workspace", error);
      this.throwWorkspaceMutationError(error);
    }

    return this.getAuthContextByUserIdAsync(input.currentUserId);
  }

  async loginUser(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    const user = await this.getUserByEmailAsync(email);
    if (!user || !this.verifyPassword(input.password, user.passwordHash)) {
      throw new NotFoundException("邮箱或密码不正确");
    }

    return this.createSessionForUser(user);
  }

  async logoutSession(token?: string | null) {
    if (!token) {
      return;
    }

    this.sessions = this.sessions.filter((item) => item.token !== token);
    await this.postgresStateService.deleteSessionByToken(token);
  }

  async touchSession(token?: string | null) {
    if (!token) {
      return null;
    }

    const session = this.postgresStateService.isEnabled()
      ? await this.postgresStateService.getValidSessionByToken(token)
      : this.sessions.find((item) => item.token === token) ?? null;
    if (!session) {
      return null;
    }

    const now = new Date();
    const lastSeenAt = Date.parse(session.lastSeenAt);
    if (
      Number.isFinite(lastSeenAt) &&
      now.getTime() - lastSeenAt < this.sessionTouchIntervalMs
    ) {
      return session;
    }

    session.lastSeenAt = now.toISOString();
    session.expiresAt = new Date(now.getTime() + this.sessionTtlMs).toISOString();
    await this.postgresStateService.upsertSession(session);
    return session;
  }

  listWorkspaces() {
    return this.workspaces;
  }

  listUsers() {
    return this.users.map((user) => this.toUserRecord(user));
  }

  listUserWorkspaces(userId: string) {
    const workspaceIds = new Set(
      this.workspaceMembers.filter((item) => item.userId === userId).map((item) => item.workspaceId),
    );
    return this.workspaces.filter((item) => workspaceIds.has(item.id) && item.status !== "archived");
  }

  listUserWorkspaceViews(userId: string): WorkspaceViewRecord[] {
    return this.listUserWorkspaces(userId).map((workspace) => ({
      ...workspace,
      role: this.getWorkspaceMembership(userId, workspace.id)?.role ?? "member",
    }));
  }

  assertUserHasWorkspaceAccess(userId: string, workspaceId: string) {
    const targetWorkspace = this.listUserWorkspaces(userId).find((item) => item.id === workspaceId);
    if (!targetWorkspace) {
      throw new ForbiddenException(`Workspace ${workspaceId} is not accessible for user ${userId}`);
    }
    return targetWorkspace;
  }

  getWorkspaceMembership(userId: string, workspaceId: string) {
    return this.workspaceMembers.find(
      (item) => item.userId === userId && item.workspaceId === workspaceId,
    ) ?? null;
  }

  listWorkspaceMembers(workspaceId: string): WorkspaceMemberViewRecord[] {
    this.getWorkspace(workspaceId);

    return this.workspaceMembers
      .filter((item) => item.workspaceId === workspaceId)
      .map((item) => {
        const user = this.users.find((candidate) => candidate.id === item.userId);
        if (!user) {
          throw new NotFoundException(`User ${item.userId} not found`);
        }

        return {
          id: item.id,
          userId: item.userId,
          workspaceId: item.workspaceId,
          role: item.role,
          createdAt: item.createdAt,
          user: this.toUserRecord(user),
        };
      })
      .sort((left, right) => {
        if (left.role !== right.role) {
          return left.role === "owner" ? -1 : 1;
        }
        return left.user.displayName.localeCompare(right.user.displayName, "zh-CN");
      });
  }

  assertUserCanManageWorkspace(userId: string, workspaceId: string) {
    const membership = this.getWorkspaceMembership(userId, workspaceId);
    if (!membership) {
      throw new ForbiddenException(`Workspace ${workspaceId} is not accessible for user ${userId}`);
    }
    if (membership.role !== "owner") {
      throw new ForbiddenException(`Workspace ${workspaceId} requires owner role`);
    }
    return membership;
  }

  listDeploymentsForUser(userId: string, workspaceId?: string) {
    if (workspaceId) {
      this.assertUserHasWorkspaceAccess(userId, workspaceId);
      return this.listDeploymentsOwnedByUser(userId).filter((item) => item.workspaceId === workspaceId);
    }
    return this.listDeploymentsOwnedByUser(userId);
  }

  getDeploymentForUser(userId: string, deploymentId: string) {
    const deployment = this.getDeployment(deploymentId);
    if (this.getBillingUserIdForDeployment(deploymentId) !== userId) {
      throw new ForbiddenException(`Deployment ${deploymentId} is not accessible for user ${userId}`);
    }
    return deployment;
  }

  async setCurrentWorkspaceForUser(userId: string, workspaceId: string) {
    const user = await this.getUserAsync(userId);
    const targetWorkspace = (await this.listUserWorkspacesAsync(userId)).find((item) => item.id === workspaceId);
    if (!targetWorkspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    try {
      if (this.postgresStateService.isEnabled()) {
        await this.postgresStateService.setUserActiveWorkspace({
          userId,
          workspaceId,
        });
        await this.refreshLocalStateAfterWrite("set-current-workspace");
        return this.toUserRecordAsync(await this.getUserAsync(userId));
      }

      user.activeWorkspaceId = workspaceId;
      await this.postgresStateService.upsertUser(user);
      await this.refreshLocalStateAfterWrite("set-current-workspace");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("set-current-workspace", error);
      throw error;
    }

    return this.toUserRecordAsync(user);
  }

  async addWorkspaceMemberByEmail(input: {
    currentUserId: string;
    workspaceId: string;
    email: string;
    role?: "owner" | "member";
  }) {
    await this.assertUserCanManageWorkspaceAsync(input.currentUserId, input.workspaceId);

    const normalizedEmail = input.email.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new NotFoundException("请先填写成员邮箱");
    }

    const user = await this.getUserByEmailAsync(normalizedEmail);
    if (!user) {
      throw new NotFoundException("该邮箱尚未注册小懒布账号");
    }

    const existing = await this.getWorkspaceMembershipAsync(user.id, input.workspaceId);
    if (existing) {
      throw new ForbiddenException("该成员已经在当前工作区中");
    }

    const membership: WorkspaceMembershipRecord = {
      id: `wsm_${Date.now()}_${this.workspaceMembers.length + 1}`,
      userId: user.id,
      workspaceId: input.workspaceId,
      role: input.role ?? "member",
      createdAt: new Date().toISOString(),
    };

    try {
      if (this.postgresStateService.isEnabled()) {
        await this.postgresStateService.addWorkspaceMember({
          currentUserId: input.currentUserId,
          workspaceId: input.workspaceId,
          email: normalizedEmail,
          membership: {
            ...membership,
            userId: user.id,
          },
        });
        await this.refreshLocalStateAfterWrite("add-workspace-member");
        return this.listWorkspaceMembersAsync(input.workspaceId);
      }

      this.workspaceMembers.unshift(membership);
      await this.postgresStateService.upsertWorkspaceMember(membership);
      await this.refreshLocalStateAfterWrite("add-workspace-member");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("add-workspace-member", error);
      if (this.isUniqueViolation(error)) {
        throw new ForbiddenException("该成员已经在当前工作区中");
      }
      this.throwWorkspaceMutationError(error);
    }

    return this.listWorkspaceMembersAsync(input.workspaceId);
  }

  async updateWorkspaceMemberRole(input: {
    currentUserId: string;
    workspaceId: string;
    memberId: string;
    role: "owner" | "member";
  }) {
    await this.assertUserCanManageWorkspaceAsync(input.currentUserId, input.workspaceId);

    if (this.postgresStateService.isEnabled()) {
      try {
        await this.postgresStateService.updateWorkspaceMemberRole(input);
        await this.refreshLocalStateAfterWrite("update-workspace-member-role");
      } catch (error) {
        await this.recoverLocalStateAfterWriteFailure("update-workspace-member-role", error);
        this.throwWorkspaceMutationError(error);
      }

      return this.listWorkspaceMembersAsync(input.workspaceId);
    }

    const membership = this.workspaceMembers.find(
      (item) => item.id === input.memberId && item.workspaceId === input.workspaceId,
    );
    if (!membership) {
      throw new NotFoundException("该成员不存在");
    }

    if (membership.role === input.role) {
      return this.listWorkspaceMembers(input.workspaceId);
    }

    if (membership.role === "owner" && input.role !== "owner") {
      const ownerCount = this.workspaceMembers.filter(
        (item) => item.workspaceId === input.workspaceId && item.role === "owner",
      ).length;
      if (ownerCount <= 1) {
        throw new BadRequestException("当前工作区至少要保留一位拥有者");
      }
    }

    try {
      membership.role = input.role;
      await this.postgresStateService.upsertWorkspaceMember(membership);

      if (input.role !== "owner") {
        await this.reassignWorkspaceOwnerIfNeeded(input.workspaceId, membership.userId);
      }
      await this.refreshLocalStateAfterWrite("update-workspace-member-role");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("update-workspace-member-role", error);
      throw error;
    }

    return this.listWorkspaceMembersAsync(input.workspaceId);
  }

  async removeWorkspaceMember(input: {
    currentUserId: string;
    workspaceId: string;
    memberId: string;
  }) {
    await this.assertUserCanManageWorkspaceAsync(input.currentUserId, input.workspaceId);

    if (this.postgresStateService.isEnabled()) {
      try {
        await this.postgresStateService.removeWorkspaceMember(input);
        await this.refreshLocalStateAfterWrite("remove-workspace-member");
      } catch (error) {
        await this.recoverLocalStateAfterWriteFailure("remove-workspace-member", error);
        this.throwWorkspaceMutationError(error);
      }

      return this.listWorkspaceMembersAsync(input.workspaceId);
    }

    const membershipIndex = this.workspaceMembers.findIndex(
      (item) => item.id === input.memberId && item.workspaceId === input.workspaceId,
    );
    if (membershipIndex === -1) {
      throw new NotFoundException("该成员不存在");
    }

    const membership = this.workspaceMembers[membershipIndex];
    const ownerCount = this.workspaceMembers.filter(
      (item) => item.workspaceId === input.workspaceId && item.role === "owner",
    ).length;
    if (membership.role === "owner" && ownerCount <= 1) {
      throw new BadRequestException("当前工作区至少要保留一位拥有者");
    }

    try {
      this.workspaceMembers.splice(membershipIndex, 1);
      await this.postgresStateService.deleteWorkspaceMember(membership.userId, membership.workspaceId);
      await this.reassignWorkspaceOwnerIfNeeded(input.workspaceId, membership.userId);

      const targetUser = this.users.find((item) => item.id === membership.userId);
      if (targetUser && targetUser.activeWorkspaceId === input.workspaceId) {
        const nextWorkspace = this.listUserWorkspaces(targetUser.id)[0];
        if (!nextWorkspace) {
          throw new BadRequestException("成员移除后没有可用工作区可切换");
        }
        targetUser.activeWorkspaceId = nextWorkspace.id;
        await this.postgresStateService.upsertUser(targetUser);
      }
      await this.refreshLocalStateAfterWrite("remove-workspace-member");
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("remove-workspace-member", error);
      throw error;
    }

    return this.listWorkspaceMembersAsync(input.workspaceId);
  }

  private async reassignWorkspaceOwnerIfNeeded(workspaceId: string, removedOwnerUserId: string) {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.ownerUserId !== removedOwnerUserId) {
      return;
    }

    const nextOwner = this.workspaceMembers.find(
      (item) => item.workspaceId === workspaceId && item.role === "owner",
    );
    if (!nextOwner) {
      return;
    }

    workspace.ownerUserId = nextOwner.userId;
    await this.postgresStateService.upsertWorkspace(workspace);
  }

  private async normalizeAccountBillingState() {
    const deploymentWrites = [];
    const walletWrites = [];
    const ledgerWrites = [];
    const transactionWrites = [];

    for (const deployment of this.deployments) {
      const ownerUserId = this.getBillingUserIdForWorkspace(deployment.workspaceId);
      if (deployment.ownerUserId !== ownerUserId) {
        deployment.ownerUserId = ownerUserId;
        deploymentWrites.push(this.postgresStateService.upsertDeployment(deployment));
      }
    }

    for (const summary of this.usageSummaries) {
      summary.userId = this.getBillingUserIdForWorkspace(summary.workspaceId);
    }

    for (const feed of this.billingFeed) {
      feed.userId = this.getBillingUserIdForWorkspace(feed.workspaceId);
    }

    const walletsByUserId = new Map<string, WalletRecord[]>();
    for (const wallet of this.wallets) {
      const ownerUserId = this.getBillingUserIdForWorkspace(wallet.workspaceId);
      if (wallet.userId !== ownerUserId) {
        wallet.userId = ownerUserId;
      }
      const bucket = walletsByUserId.get(ownerUserId) ?? [];
      bucket.push(wallet);
      walletsByUserId.set(ownerUserId, bucket);
    }

    for (const user of this.users) {
      const ownedWallets = walletsByUserId.get(user.id) ?? [];
      if (ownedWallets.length === 0) {
        const workspaceId = user.activeWorkspaceId || this.listUserWorkspaces(user.id)[0]?.id;
        if (!workspaceId) {
          continue;
        }
        const wallet: WalletRecord = {
          id: `wallet_${user.id}`,
          workspaceId,
          userId: user.id,
          balanceCny: 0,
          frozenCny: 0,
          currency: "CNY",
        };
        this.wallets.unshift(wallet);
        walletsByUserId.set(user.id, [wallet]);
        walletWrites.push(this.postgresStateService.upsertWallet(wallet));
        continue;
      }

      const canonicalWallet =
        ownedWallets.find((item) => item.workspaceId === user.activeWorkspaceId) ?? ownedWallets[0];
      const totalBalance = this.roundCurrency(
        ownedWallets.reduce((sum, item) => sum + (Number.isFinite(item.balanceCny) ? item.balanceCny : 0), 0),
      );
      const totalFrozen = this.roundCurrency(
        ownedWallets.reduce((sum, item) => sum + (Number.isFinite(item.frozenCny) ? item.frozenCny : 0), 0),
      );

      if (canonicalWallet.balanceCny !== totalBalance || canonicalWallet.frozenCny !== totalFrozen) {
        canonicalWallet.balanceCny = totalBalance;
        canonicalWallet.frozenCny = totalFrozen;
      }

      canonicalWallet.userId = user.id;
      walletWrites.push(this.postgresStateService.upsertWallet(canonicalWallet));

      for (const wallet of ownedWallets) {
        if (wallet.id === canonicalWallet.id) {
          continue;
        }
        if (typeof wallet.userId !== "undefined") {
          wallet.userId = undefined;
          walletWrites.push(this.postgresStateService.upsertWallet(wallet));
        }
      }
    }

    const walletById = new Map(this.wallets.map((item) => [item.id, item] as const));

    for (const item of this.usageLedger) {
      const ownerUserId =
        item.userId ||
        this.deployments.find((deployment) => deployment.id === item.deploymentId)?.ownerUserId ||
        this.getBillingUserIdForWorkspace(item.workspaceId);
      if (item.userId !== ownerUserId) {
        item.userId = ownerUserId;
        ledgerWrites.push(this.postgresStateService.insertUsageLedger(item));
      }
    }

    for (const item of this.walletTransactions) {
      const ownerUserId =
        item.userId ||
        walletById.get(item.walletId)?.userId ||
        this.getBillingUserIdForWorkspace(item.workspaceId);
      if (item.userId !== ownerUserId) {
        item.userId = ownerUserId;
        transactionWrites.push(this.postgresStateService.insertWalletTransaction(item));
      }
    }

    await Promise.all([...deploymentWrites, ...walletWrites, ...ledgerWrites, ...transactionWrites]);
  }

  private createOwnedWorkspaceBundle(
    userId: string,
    input: {
      name: string;
      planName: WorkspaceRecord["planName"];
      status: WorkspaceRecord["status"];
      initialBalanceCny: number;
    },
  ) {
    const now = new Date().toISOString();
    const workspaceId = `ws_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const workspace: WorkspaceRecord = {
      id: workspaceId,
      ownerUserId: userId,
      name: input.name,
      planName: input.planName,
      status: input.status,
    };
    const membership: WorkspaceMembershipRecord = {
      id: `wsm_${Date.now()}_${this.workspaceMembers.length + 1}`,
      userId,
      workspaceId,
      role: "owner",
      createdAt: now,
    };
    const wallet: WalletRecord = {
      id: `wallet_${Date.now()}_${this.wallets.length + 1}`,
      workspaceId,
      userId,
      balanceCny: input.initialBalanceCny,
      frozenCny: 0,
      currency: "CNY",
    };

    return {
      workspace,
      membership,
      wallet,
    };
  }

  private getAuthContextByUserId(userId: string) {
    const user = this.users.find((item) => item.id === userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    return this.buildAuthContextForUser(user);
  }

  getWorkspace(workspaceId: string) {
    const workspace = this.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    return workspace;
  }

  getUser(userId: string) {
    const user = this.users.find((item) => item.id === userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    return user;
  }

  getBillingUserIdForWorkspace(workspaceId: string) {
    return this.getWorkspace(workspaceId).ownerUserId;
  }

  getPreferredWorkspaceIdForUser(userId: string) {
    const user = this.getUser(userId);
    const activeWorkspaceId = user.activeWorkspaceId?.trim();
    if (activeWorkspaceId) {
      const accessible = this.listUserWorkspaces(userId).find((item) => item.id === activeWorkspaceId);
      if (accessible) {
        return accessible.id;
      }
    }

    const fallbackWorkspace = this.listUserWorkspaces(userId)[0];
    if (!fallbackWorkspace) {
      throw new NotFoundException(`User ${userId} has no available workspace`);
    }

    return fallbackWorkspace.id;
  }

  getBillingUserIdForDeployment(deploymentId: string) {
    const deployment = this.getDeployment(deploymentId);
    return deployment.ownerUserId || this.getBillingUserIdForWorkspace(deployment.workspaceId);
  }

  listDeploymentsOwnedByUser(userId: string) {
    return this.deployments.filter(
      (item) => (item.ownerUserId || this.getBillingUserIdForWorkspace(item.workspaceId)) === userId,
    );
  }

  listDeployments(workspaceId?: string) {
    if (!workspaceId) {
      return this.deployments;
    }
    this.getWorkspace(workspaceId);
    return this.deployments.filter((item) => item.workspaceId === workspaceId);
  }

  async createDeployment(input: CreateDeploymentInput) {
    const workspace = this.postgresStateService.isEnabled()
      ? await this.getWorkspaceAsync(input.workspaceId)
      : this.getWorkspace(input.workspaceId);

    const record: DeploymentRecord = {
      id: input.id ?? `dep_${Date.now()}`,
      workspaceId: input.workspaceId,
      ownerUserId: workspace.ownerUserId,
      name: input.name,
      mode: input.mode,
      status: input.status ?? (input.mode === "cloud" ? "creating" : "running"),
      provider: input.provider ?? (input.mode === "cloud" ? "aliyun" : "local"),
      region: input.region ?? (input.mode === "cloud" ? "cn-hangzhou" : "local-device"),
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl:
        input.consoleUrl ??
        (input.mode === "cloud"
          ? `${DEFAULT_PUBLIC_APP_BASE_URL}/demo/${encodeURIComponent(input.name)}`
          : "http://127.0.0.1:18789"),
      gatewayUrl:
        input.gatewayUrl ??
        (process.env.XLB_GATEWAY_PUBLIC_BASE_URL?.trim() || "https://gateway.xiaolanbu.com/v1"),
      createdAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      publicIpAddress: input.publicIpAddress,
      privateIpAddress: input.privateIpAddress,
      zoneId: input.zoneId,
      vendorInstanceIds: input.vendorInstanceIds,
      access: input.access,
      gatewayKey: input.gatewayKey,
      metadata: input.metadata,
    };

    try {
      if (!this.postgresStateService.isEnabled()) {
        this.deployments.unshift(record);
      }
      await this.postgresStateService.upsertDeployment(record);
      await this.refreshLocalStateAfterWrite("create-deployment");
      return this.postgresStateService.isEnabled()
        ? await this.getDeploymentAsync(record.id)
        : this.getDeployment(record.id);
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("create-deployment", error);
      throw error;
    }
  }

  async updateDeploymentStatus(deploymentId: string, status: DeploymentStatus) {
    const record = this.postgresStateService.isEnabled()
      ? await this.getDeploymentAsync(deploymentId)
      : this.getDeployment(deploymentId);
    record.status = status;
    record.lastHeartbeatAt = new Date().toISOString();
    try {
      await this.postgresStateService.upsertDeployment(record);
      await this.refreshLocalStateAfterWrite("update-deployment-status");
      return this.postgresStateService.isEnabled()
        ? await this.getDeploymentAsync(deploymentId)
        : this.getDeployment(deploymentId);
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("update-deployment-status", error);
      throw error;
    }
  }

  async updateDeployment(deploymentId: string, patch: Partial<DeploymentRecord>) {
    const record = this.postgresStateService.isEnabled()
      ? await this.getDeploymentAsync(deploymentId)
      : this.getDeployment(deploymentId);
    Object.assign(record, patch);
    record.lastHeartbeatAt = new Date().toISOString();
    try {
      await this.postgresStateService.upsertDeployment(record);
      await this.refreshLocalStateAfterWrite("update-deployment");
      return this.postgresStateService.isEnabled()
        ? await this.getDeploymentAsync(deploymentId)
        : this.getDeployment(deploymentId);
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("update-deployment", error);
      throw error;
    }
  }

  async deleteDeployment(deploymentId: string) {
    let removed: DeploymentRecord;
    if (this.postgresStateService.isEnabled()) {
      removed = await this.getDeploymentAsync(deploymentId);
    } else {
      const index = this.deployments.findIndex((item) => item.id === deploymentId);
      if (index < 0) {
        throw new NotFoundException(`Deployment ${deploymentId} not found`);
      }
      [removed] = this.deployments.splice(index, 1);
    }

    try {
      await this.postgresStateService.deleteDeployment(deploymentId);
      await this.refreshLocalStateAfterWrite("delete-deployment");
      return removed;
    } catch (error) {
      await this.recoverLocalStateAfterWriteFailure("delete-deployment", error);
      throw error;
    }
  }

  getDeployment(deploymentId: string) {
    const record = this.deployments.find((item) => item.id === deploymentId);
    if (!record) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    return record;
  }

  getWallet(workspaceId: string) {
    return this.getWalletByUserId(this.getBillingUserIdForWorkspace(workspaceId));
  }

  getWalletByUserId(userId: string) {
    this.getUser(userId);
    const wallet = this.wallets.find((item) => item.userId === userId);
    if (!wallet) {
      throw new NotFoundException(`Wallet for user ${userId} not found`);
    }
    return wallet;
  }

  getUsageSummary(workspaceId: string, period: "today" | "7d" | "30d") {
    return this.getUsageSummaryByUserId(this.getBillingUserIdForWorkspace(workspaceId), period, workspaceId);
  }

  getUsageSummaryByUserId(
    userId: string,
    period: "today" | "7d" | "30d",
    workspaceId = this.getPreferredWorkspaceIdForUser(userId),
  ) {
    const dynamicSummary = this.buildUsageSummaryFromLedger(userId, workspaceId, period);
    if (dynamicSummary) {
      return dynamicSummary;
    }
    const summary =
      this.usageSummaries.find((item) => item.userId === userId && item.period === period) ??
      this.usageSummaries.find((item) => item.userId === userId && item.period === "today");
    if (summary) {
      return {
        ...summary,
        workspaceId,
        userId,
        period,
      };
    }

    return {
      workspaceId,
      userId,
      period,
      requestCount: 0,
      totalTokens: 0,
      totalCostCny: 0,
      topModels: [],
    };
  }

  listDeploymentUsageSummaries(workspaceId: string, period: "today" | "7d" | "30d") {
    return this.listDeploymentUsageSummariesByUserId(
      this.getBillingUserIdForWorkspace(workspaceId),
      period,
      workspaceId,
    );
  }

  listDeploymentUsageSummariesByUserId(
    userId: string,
    period: "today" | "7d" | "30d",
    workspaceId = this.getPreferredWorkspaceIdForUser(userId),
  ) {

    const now = Date.now();
    const periodStart =
      period === "today"
        ? now - 24 * 60 * 60 * 1000
        : period === "7d"
          ? now - 7 * 24 * 60 * 60 * 1000
          : now - 30 * 24 * 60 * 60 * 1000;

    const ledgerByDeploymentId = new Map<string, UsageLedgerRecord[]>();

    for (const item of this.usageLedger) {
      if (item.userId !== userId) {
        continue;
      }

      const finishedAt = Date.parse(item.finishedAt);
      if (!Number.isFinite(finishedAt) || finishedAt < periodStart) {
        continue;
      }

      const bucket = ledgerByDeploymentId.get(item.deploymentId) ?? [];
      bucket.push(item);
      ledgerByDeploymentId.set(item.deploymentId, bucket);
    }

    return this.listDeploymentsOwnedByUser(userId)
      .filter((deployment) => deployment.mode === "cloud")
      .map<DeploymentUsageSummaryRecord>((deployment) => {
        const items = ledgerByDeploymentId.get(deployment.id) ?? [];
        return {
          workspaceId: deployment.workspaceId || workspaceId,
          userId,
          deploymentId: deployment.id,
          deploymentName: deployment.name,
          mode: deployment.mode,
          provider: deployment.provider,
          region: deployment.region,
          status: deployment.status,
          period,
          requestCount: items.length,
          totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
          totalCostCny: this.roundCurrency(
            items.reduce((sum, item) => sum + item.billableCostCny, 0),
          ),
          promptTokens: items.reduce((sum, item) => sum + item.promptTokens, 0),
          completionTokens: items.reduce((sum, item) => sum + item.completionTokens, 0),
          cachedTokens: items.reduce((sum, item) => sum + item.cachedTokens, 0),
          reasoningTokens: items.reduce((sum, item) => sum + item.reasoningTokens, 0),
          lastRequestAt:
            items
              .map((item) => item.finishedAt)
              .sort((left, right) => right.localeCompare(left))[0] ?? undefined,
        };
      })
      .sort((left, right) => {
        if (right.totalCostCny !== left.totalCostCny) {
          return right.totalCostCny - left.totalCostCny;
        }
        return right.requestCount - left.requestCount;
      });
  }

  listBillingFeed(workspaceId: string) {
    return this.listBillingFeedByUserId(this.getBillingUserIdForWorkspace(workspaceId));
  }

  listBillingFeedByUserId(userId: string) {
    const transactionFeed = this.walletTransactions
      .filter((item) => item.userId === userId)
      .map<BillingFeedRecord>((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        userId: item.userId,
        kind:
          item.type === "topup" ? "topup" : item.type === "usage" ? "usage" : "adjustment",
        title: item.title,
        amountCny: item.amountCny,
        createdAt: item.createdAt,
      }));

    return [...this.billingFeed.filter((item) => item.userId === userId), ...transactionFeed].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt),
    );
  }

  listUsageLedger(
    workspaceId: string,
    input?: {
      deploymentId?: string;
      limit?: number;
    },
  ) {
    return this.listUsageLedgerByUserId(this.getBillingUserIdForWorkspace(workspaceId), input);
  }

  listUsageLedgerByUserId(
    userId: string,
    input?: {
      deploymentId?: string;
      limit?: number;
    },
  ) {
    const items = this.usageLedger
      .filter((item) => item.userId === userId)
      .filter((item) => (input?.deploymentId ? item.deploymentId === input.deploymentId : true))
      .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));

    if (typeof input?.limit === "number" && input.limit > 0) {
      return items.slice(0, input.limit);
    }

    return items;
  }

  findUsageLedger(userId: string, deploymentId: string, requestId: string) {
    return this.usageLedger.find(
      (item) =>
        item.userId === userId &&
        item.deploymentId === deploymentId &&
        item.requestId === requestId,
    );
  }

  async createUsageLedger(input: Omit<UsageLedgerRecord, "id">) {
    const record: UsageLedgerRecord = {
      id: `ulg_${Date.now()}_${this.usageLedger.length + 1}`,
      ...input,
    };

    this.usageLedger.unshift(record);
    await this.postgresStateService.insertUsageLedger(record);
    return record;
  }

  async recordUsageAndCharge(input: {
    userId: string;
    ledger: Omit<UsageLedgerRecord, "id">;
    charge?: Omit<WalletTransactionRecord, "id" | "walletId" | "userId" | "balanceAfterCny">;
  }) {
    const ledger: UsageLedgerRecord = {
      id: `ulg_${Date.now()}_${this.usageLedger.length + 1}`,
      ...input.ledger,
    };

    if (!this.postgresStateService.isEnabled()) {
      if (this.findUsageLedger(input.userId, ledger.deploymentId, ledger.requestId)) {
        return {
          created: false,
          ledger,
          transaction: null,
        };
      }

      const createdLedger = await this.createUsageLedger(input.ledger);
      let transaction: WalletTransactionRecord | null = null;
      if (input.charge) {
        transaction = await this.createWalletTransactionForUser(input.userId, input.charge);
      }

      return {
        created: true,
        ledger: createdLedger,
        transaction,
      };
    }

    const transactionId = input.charge ? `wtx_${Date.now()}_${this.walletTransactions.length + 1}` : null;
    const result = await this.postgresStateService.recordUsageAndCharge({
      userId: input.userId,
      ledger,
      charge: input.charge
        ? {
            id: transactionId!,
            ...input.charge,
          }
        : undefined,
    });

    if (!result) {
      throw new Error("Failed to persist usage ledger");
    }

    this.upsertUsageLedgerRecord(result.ledger);
    this.upsertWalletRecord(result.wallet);
    if (result.transaction) {
      this.upsertWalletTransactionRecord(result.transaction);
    }

    return {
      created: result.created,
      ledger: result.ledger,
      transaction: result.transaction,
    };
  }

  listWalletTransactions(workspaceId: string, limit = 50) {
    return this.listWalletTransactionsByUserId(this.getBillingUserIdForWorkspace(workspaceId), limit);
  }

  listWalletTransactionsByUserId(userId: string, limit = 50) {
    return this.walletTransactions
      .filter((item) => item.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async createWalletTransaction(
    workspaceId: string,
    input: Omit<WalletTransactionRecord, "id" | "walletId" | "workspaceId" | "userId" | "balanceAfterCny">,
  ) {
    const userId = this.getBillingUserIdForWorkspace(workspaceId);
    return this.createWalletTransactionForUser(userId, {
      ...input,
      workspaceId,
    });
  }

  async createWalletTransactionForUser(
    userId: string,
    input: Omit<WalletTransactionRecord, "id" | "walletId" | "userId" | "balanceAfterCny">,
  ) {
    if (this.postgresStateService.isEnabled()) {
      const result = await this.postgresStateService.applyWalletTransactionForUser({
        userId,
        transaction: {
          id: `wtx_${Date.now()}_${this.walletTransactions.length + 1}`,
          ...input,
        },
      });

      if (!result) {
        throw new Error(`Wallet transaction for user ${userId} was not persisted`);
      }

      this.upsertWalletRecord(result.wallet);
      this.upsertWalletTransactionRecord(result.transaction);
      return result.transaction;
    }

    const wallet = this.getWalletByUserId(userId);
    wallet.balanceCny = this.roundCurrency(wallet.balanceCny + input.amountCny);

    const record: WalletTransactionRecord = {
      id: `wtx_${Date.now()}_${this.walletTransactions.length + 1}`,
      walletId: wallet.id,
      userId,
      balanceAfterCny: wallet.balanceCny,
      ...input,
    };

    this.walletTransactions.unshift(record);
    await Promise.all([
      this.postgresStateService.upsertWallet(wallet),
      this.postgresStateService.insertWalletTransaction(record),
    ]);
    return record;
  }

  private buildUsageSummaryFromLedger(
    userId: string,
    workspaceId: string,
    period: "today" | "7d" | "30d",
  ): UsageSummaryRecord | null {
    return this.buildUsageSummaryFromItems(this.usageLedger, userId, workspaceId, period);
  }

  private async createSessionForUser(user: AuthUserRecord) {
    const session = this.buildSessionRecord(user.id);

    this.sessions.unshift(session);
    await this.postgresStateService.upsertSession(session);

    return {
      sessionToken: session.token,
      ...(await this.buildAuthContextForUserAsync(user)),
    };
  }

  private buildAuthContextForUser(user: AuthUserRecord) {
    const publicUser = this.toUserRecord(user);
    const workspaces = this.listUserWorkspaceViews(user.id);
    const accountScopeId = this.getPreferredWorkspaceIdForUser(user.id);
    const currentScope =
      workspaces.find((item) => item.id === accountScopeId) ?? workspaces[0] ?? null;
    const currentAccountRole = accountScopeId
      ? this.getWorkspaceMembership(user.id, accountScopeId)?.role ?? null
      : null;

    return {
      user: publicUser,
      billingUserId: user.id,
      accountScopeId,
      defaultScopeId: accountScopeId,
      currentAccountScope: currentScope,
      currentAccountRole,
      accountScopes: workspaces,
      workspaces,
      activeWorkspaceId: accountScopeId,
      currentWorkspace: currentScope,
      currentWorkspaceRole: currentAccountRole,
    };
  }

  private buildSessionRecord(userId: string): SessionRecord {
    const now = new Date().toISOString();
    return {
      id: `sess_${Date.now()}`,
      token: `xlb_sess_${randomBytes(24).toString("hex")}`,
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
    };
  }

  private async buildAuthContextForUserAsync(user: AuthUserRecord) {
    const publicUser = await this.toUserRecordAsync(user);
    const workspaces = await this.listUserWorkspaceViewsAsync(user.id);
    const accountScopeId = await this.getPreferredWorkspaceIdForUserAsync(user.id);
    const currentScope = workspaces.find((item) => item.id === accountScopeId) ?? workspaces[0] ?? null;
    const currentAccountRole = accountScopeId
      ? (await this.getWorkspaceMembershipAsync(user.id, accountScopeId))?.role ?? null
      : null;

    return {
      user: publicUser,
      billingUserId: user.id,
      accountScopeId,
      defaultScopeId: accountScopeId,
      currentAccountScope: currentScope,
      currentAccountRole,
      accountScopes: workspaces,
      workspaces,
      activeWorkspaceId: accountScopeId,
      currentWorkspace: currentScope,
      currentWorkspaceRole: currentAccountRole,
    };
  }

  private toUserRecord(user: AuthUserRecord): UserRecord {
    const accountScopeId = this.getPreferredWorkspaceIdForUser(user.id);
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      avatarInitial: user.avatarInitial,
      activeWorkspaceId: accountScopeId,
      accountScopeId,
      defaultScopeId: accountScopeId,
    };
  }

  private async toUserRecordAsync(user: AuthUserRecord): Promise<UserRecord> {
    const accountScopeId = await this.getPreferredWorkspaceIdForUserAsync(user.id);
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      avatarInitial: user.avatarInitial,
      activeWorkspaceId: accountScopeId,
      accountScopeId,
      defaultScopeId: accountScopeId,
    };
  }

  private hashPassword(password: string) {
    const salt = randomUUID().replace(/-/g, "");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
  }

  private verifyPassword(password: string, passwordHash: string) {
    const [salt, storedHash] = passwordHash.split(":");
    if (!salt || !storedHash) {
      return false;
    }

    const derivedHash = scryptSync(password, salt, 64);
    const storedBuffer = Buffer.from(storedHash, "hex");
    if (derivedHash.length !== storedBuffer.length) {
      return false;
    }

    return timingSafeEqual(derivedHash, storedBuffer);
  }

  private roundCurrency(value: number) {
    return Math.round(value * 1000000) / 1000000;
  }

  private getPeriodStartTimestamp(period: "today" | "7d" | "30d") {
    const now = Date.now();
    if (period === "today") {
      return now - 24 * 60 * 60 * 1000;
    }
    if (period === "7d") {
      return now - 7 * 24 * 60 * 60 * 1000;
    }
    return now - 30 * 24 * 60 * 60 * 1000;
  }

  private buildUsageSummaryFromItems(
    items: UsageLedgerRecord[],
    userId: string,
    workspaceId: string,
    period: "today" | "7d" | "30d",
  ): UsageSummaryRecord {
    const periodStart = this.getPeriodStartTimestamp(period);
    const filteredItems = items.filter((item) => {
      if (item.userId !== userId) {
        return false;
      }
      const finishedAt = Date.parse(item.finishedAt);
      return Number.isFinite(finishedAt) && finishedAt >= periodStart;
    });

    if (filteredItems.length === 0) {
      return {
        workspaceId,
        userId,
        period,
        requestCount: 0,
        totalTokens: 0,
        totalCostCny: 0,
        topModels: [],
      };
    }

    const topModelsMap = new Map<string, { tokens: number; costCny: number }>();
    for (const item of filteredItems) {
      const entry = topModelsMap.get(item.model) ?? { tokens: 0, costCny: 0 };
      entry.tokens += item.totalTokens;
      entry.costCny = this.roundCurrency(entry.costCny + item.billableCostCny);
      topModelsMap.set(item.model, entry);
    }

    return {
      workspaceId,
      userId,
      period,
      requestCount: filteredItems.length,
      totalTokens: filteredItems.reduce((sum, item) => sum + item.totalTokens, 0),
      totalCostCny: this.roundCurrency(
        filteredItems.reduce((sum, item) => sum + item.billableCostCny, 0),
      ),
      topModels: [...topModelsMap.entries()]
        .map(([model, value]) => ({
          model,
          tokens: value.tokens,
          costCny: value.costCny,
        }))
        .sort((left, right) => right.costCny - left.costCny)
        .slice(0, 5),
    };
  }

  private throwWorkspaceMutationError(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    switch (message) {
      case "USER_EMAIL_NOT_FOUND":
        throw new NotFoundException("该邮箱尚未注册小懒布账号");
      case "WORKSPACE_MEMBER_ALREADY_EXISTS":
        throw new ForbiddenException("该成员已经在当前工作区中");
      case "WORKSPACE_MEMBER_NOT_FOUND":
        throw new NotFoundException("该成员不存在");
      case "LAST_OWNER_REQUIRED":
        throw new BadRequestException("当前工作区至少要保留一位拥有者");
      case "LAST_OWNER_CANNOT_LEAVE":
        throw new BadRequestException("当前工作区最后一位拥有者不能直接退出，请先转移拥有者或归档工作区");
      case "TARGET_USER_HAS_NO_FALLBACK_WORKSPACE":
        throw new BadRequestException("成员移除后没有可用工作区可切换");
      case "WORKSPACE_HAS_DEPLOYMENTS":
        throw new BadRequestException("请先销毁当前工作区下的全部实例，再归档工作区");
      case "WORKSPACE_HAS_OTHER_MEMBERS":
        throw new BadRequestException("请先移除或让其他成员退出当前工作区，再执行归档");
      case "WORKSPACE_OWNER_REQUIRED":
        throw new ForbiddenException("当前操作需要工作区拥有者权限");
      case "NEXT_WORKSPACE_NOT_ACCESSIBLE":
        throw new BadRequestException("至少保留一个可用工作区后才能继续当前操作");
      default:
        throw error instanceof Error ? error : new Error(message);
    }
  }

  private startSessionCleanupLoop() {
    if (!this.postgresStateService.isEnabled() || this.sessionCleanupIntervalMs <= 0) {
      return;
    }

    void this.cleanupExpiredSessions();
    this.sessionCleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, this.sessionCleanupIntervalMs);
    this.sessionCleanupTimer.unref();
  }

  private async cleanupExpiredSessions() {
    if (!this.postgresStateService.isEnabled()) {
      return;
    }

    const deletedCount = await this.postgresStateService.deleteExpiredSessions();
    if (deletedCount > 0) {
      this.logger.log(`Deleted ${deletedCount} expired sessions`);
    }
  }

  private async refreshLocalStateAfterWrite(reason: string) {
    if (!this.postgresStateService.isEnabled()) {
      return;
    }

    await this.refreshStateFromDatabase({
      force: true,
      reason: `post-write:${reason}`,
    });
  }

  private async recoverLocalStateAfterWriteFailure(reason: string, error: unknown) {
    if (!this.postgresStateService.isEnabled()) {
      return;
    }

    try {
      await this.refreshStateFromDatabase({
        force: true,
        reason: `recover:${reason}`,
      });
    } catch (refreshError) {
      this.logger.warn(
        `Failed to recover store snapshot after ${reason}: ${
          refreshError instanceof Error ? refreshError.message : String(refreshError)
        }`,
      );
    }

    if (error instanceof Error) {
      this.logger.warn(`Store mutation failed (${reason}): ${error.message}`);
    }
  }

  private isUniqueViolation(error: unknown) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    );
  }

  private upsertWalletRecord(wallet: WalletRecord) {
    const index = this.wallets.findIndex((item) => item.id === wallet.id);
    if (index >= 0) {
      this.wallets[index] = wallet;
      return;
    }

    this.wallets.unshift(wallet);
  }

  private upsertLocalGatewayCredentialRecord(record: LocalGatewayCredentialRecord) {
    const index = this.localGatewayCredentials.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      this.localGatewayCredentials[index] = record;
      return;
    }

    const existingScopeIndex = this.localGatewayCredentials.findIndex(
      (item) => item.userId === record.userId && item.accountScopeId === record.accountScopeId,
    );
    if (existingScopeIndex >= 0) {
      this.localGatewayCredentials[existingScopeIndex] = record;
      return;
    }

    this.localGatewayCredentials.unshift(record);
  }

  private upsertUsageLedgerRecord(record: UsageLedgerRecord) {
    const index = this.usageLedger.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      this.usageLedger[index] = record;
      return;
    }

    this.usageLedger.unshift(record);
  }

  private upsertWalletTransactionRecord(record: WalletTransactionRecord) {
    const index = this.walletTransactions.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      this.walletTransactions[index] = record;
      return;
    }

    this.walletTransactions.unshift(record);
  }

  private async reloadStateFromDatabase(reason = "request") {
    const [
      persistedDeployments,
      persistedLocalGatewayCredentials,
      persistedWallets,
      persistedUsageLedger,
      persistedWalletTransactions,
      persistedUsers,
      persistedWorkspaces,
      persistedWorkspaceMembers,
      persistedSessions,
    ] = await Promise.all([
      this.postgresStateService.listDeployments(),
      this.postgresStateService.listLocalGatewayCredentials(),
      this.postgresStateService.listWallets(),
      this.postgresStateService.listUsageLedger(),
      this.postgresStateService.listWalletTransactions(),
      this.postgresStateService.listUsers(),
      this.postgresStateService.listWorkspacesCatalog(),
      this.postgresStateService.listWorkspaceMembers(),
      this.postgresStateService.listSessions(),
    ]);

    this.users = [...persistedUsers];
    this.workspaces = [...persistedWorkspaces];
    this.workspaceMembers = [...persistedWorkspaceMembers];
    this.sessions = [...persistedSessions];
    this.deployments = [...persistedDeployments];
    this.localGatewayCredentials = [...persistedLocalGatewayCredentials];
    this.wallets = [...persistedWallets];
    this.usageLedger = [...persistedUsageLedger];
    this.walletTransactions = [...persistedWalletTransactions];

    this.lastDatabaseRefreshAt = Date.now();
    this.logger.debug(
      `Refreshed database-backed store snapshot (${reason}): users=${this.users.length}, workspaces=${this.workspaces.length}, deployments=${this.deployments.length}, sessions=${this.sessions.length}`,
    );
  }

  private readStateRefreshMinIntervalMs() {
    const value = Number(process.env.XLB_STORE_REFRESH_MIN_INTERVAL_MS ?? "250");
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 250;
  }

  private readSessionTtlMs() {
    const value = Number(process.env.XLB_SESSION_TTL_MS ?? String(30 * 24 * 60 * 60 * 1000));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30 * 24 * 60 * 60 * 1000;
  }

  private readSessionTouchIntervalMs() {
    const value = Number(process.env.XLB_SESSION_TOUCH_INTERVAL_MS ?? String(60 * 60 * 1000));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 60 * 60 * 1000;
  }

  private readSessionCleanupIntervalMs() {
    const value = Number(process.env.XLB_SESSION_CLEANUP_INTERVAL_MS ?? String(15 * 60 * 1000));
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 15 * 60 * 1000;
  }

  private mergeById<T extends { id: string }>(base: T[], persisted: T[]) {
    const merged = new Map<string, T>();
    for (const item of base) {
      merged.set(item.id, item);
    }
    for (const item of persisted) {
      merged.set(item.id, item);
    }
    return [...merged.values()];
  }
}
