import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
export class StoreService implements OnModuleInit {
  private readonly logger = new Logger(StoreService.name);

  constructor(private readonly postgresStateService: PostgresStateService) {}

  private currentUser: UserRecord = {
    id: "user_001",
    displayName: "午松",
    email: "owner@xiaolanbu.app",
    avatarInitial: "午",
    activeWorkspaceId: "ws_main",
  };

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
  ];

  private sessions: SessionRecord[] = [];

  private deployments: DeploymentRecord[] = [
    {
      id: "dep_cloud_prod",
      workspaceId: "ws_main",
      name: "云端托管实例",
      mode: "cloud",
      status: "running",
      provider: "aliyun",
      region: "ap-southeast-1",
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl: "https://console.xiaolanbu.app/demo/cloud",
      gatewayUrl: "https://api.xiaolanbu.app/gateway/ws_main",
      createdAt: "2026-03-09T09:20:00.000Z",
      lastHeartbeatAt: "2026-03-09T12:08:00.000Z",
      access: {
        browserControlUrl: "https://console.xiaolanbu.app/demo/cloud/browser",
      },
    },
    {
      id: "dep_local_mac",
      workspaceId: "ws_main",
      name: "本地桌面实例",
      mode: "local",
      status: "running",
      provider: "local",
      region: "local-device",
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl: "http://127.0.0.1:18789",
      gatewayUrl: "http://127.0.0.1:3031",
      createdAt: "2026-03-08T14:10:00.000Z",
      lastHeartbeatAt: "2026-03-09T12:09:00.000Z",
      access: {
        dashboardUrl: "http://127.0.0.1:18789",
        browserControlUrl: "http://127.0.0.1:18791",
      },
    },
  ];

  private wallets: WalletRecord[] = [
    {
      id: "wallet_main",
      workspaceId: "ws_main",
      balanceCny: 286.4,
      frozenCny: 0,
      currency: "CNY",
    },
    {
      id: "wallet_team",
      workspaceId: "ws_team",
      balanceCny: 88,
      frozenCny: 0,
      currency: "CNY",
    },
  ];

  private readonly usageSummaries: UsageSummaryRecord[] = [
    {
      workspaceId: "ws_main",
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
      period: "today",
      requestCount: 0,
      totalTokens: 0,
      totalCostCny: 0,
      topModels: [],
    },
    {
      workspaceId: "ws_team",
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
      kind: "usage",
      title: "今日模型调用汇总",
      amountCny: -18.72,
      createdAt: "2026-03-09T12:00:00.000Z",
    },
    {
      id: "bill_002",
      workspaceId: "ws_main",
      kind: "topup",
      title: "余额充值",
      amountCny: 200,
      createdAt: "2026-03-08T18:20:00.000Z",
    },
    {
      id: "bill_003",
      workspaceId: "ws_main",
      kind: "usage",
      title: "昨日模型调用汇总",
      amountCny: -22.45,
      createdAt: "2026-03-08T12:00:00.000Z",
    },
    {
      id: "bill_team_001",
      workspaceId: "ws_team",
      kind: "topup",
      title: "团队工作区初始额度",
      amountCny: 88,
      createdAt: "2026-03-09T10:00:00.000Z",
    },
  ];

  private usageLedger: UsageLedgerRecord[] = [];

  private walletTransactions: WalletTransactionRecord[] = [
    {
      id: "txn_001",
      walletId: "wallet_main",
      workspaceId: "ws_main",
      type: "topup",
      title: "余额充值",
      amountCny: 200,
      balanceAfterCny: 286.4,
      createdAt: "2026-03-08T18:20:00.000Z",
      referenceType: "topup",
      referenceId: "topup_001",
    },
  ];

  async onModuleInit() {
    await this.postgresStateService.ensureInitialized();

    if (!this.postgresStateService.isEnabled()) {
      return;
    }

    const [
      persistedDeployments,
      persistedWallets,
      persistedUsageLedger,
      persistedWalletTransactions,
      persistedUsers,
      persistedWorkspaces,
      persistedWorkspaceMembers,
      persistedSessions,
    ] =
      await Promise.all([
        this.postgresStateService.listDeployments(),
        this.postgresStateService.listWallets(),
        this.postgresStateService.listUsageLedger(),
        this.postgresStateService.listWalletTransactions(),
        this.postgresStateService.listUsers(),
        this.postgresStateService.listWorkspacesCatalog(),
        this.postgresStateService.listWorkspaceMembers(),
        this.postgresStateService.listSessions(),
      ]);
    const persistedUser = await this.postgresStateService.getCurrentUser();

    this.users = this.mergeById(this.users, persistedUsers);
    this.workspaces = this.mergeById(this.workspaces, persistedWorkspaces);
    this.workspaceMembers = this.mergeById(this.workspaceMembers, persistedWorkspaceMembers);
    this.sessions = this.mergeById(this.sessions, persistedSessions);
    if (persistedUser) {
      this.currentUser = {
        ...this.currentUser,
        ...persistedUser,
        activeWorkspaceId: persistedUser.activeWorkspaceId ?? this.currentUser.activeWorkspaceId,
      };
    }

    this.deployments = this.mergeById(this.deployments, persistedDeployments);
    this.wallets = this.mergeById(this.wallets, persistedWallets);
    this.usageLedger = this.mergeById(this.usageLedger, persistedUsageLedger);
    this.walletTransactions = this.mergeById(this.walletTransactions, persistedWalletTransactions);

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
    if (!persistedUser) {
      await this.postgresStateService.upsertCurrentUser(this.currentUser);
    }

    this.logger.log(
      `Loaded persisted state: deployments=${persistedDeployments.length}, wallets=${persistedWallets.length}, ledger=${persistedUsageLedger.length}, transactions=${persistedWalletTransactions.length}`,
    );
  }

  getCurrentUser() {
    return this.currentUser;
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

    const publicUser = this.toUserRecord(user);
    const workspaces = this.listUserWorkspaceViews(user.id);
    return {
      user: publicUser,
      workspaces,
      currentWorkspace:
        workspaces.find((item) => item.id === publicUser.activeWorkspaceId) ?? workspaces[0] ?? null,
      currentWorkspaceRole:
        this.getWorkspaceMembership(user.id, publicUser.activeWorkspaceId)?.role ?? null,
    };
  }

  async registerUser(input: { displayName: string; email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    if (this.users.some((item) => item.email.toLowerCase() === email)) {
      throw new NotFoundException("该邮箱已存在");
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

    return this.createSessionForUser(user);
  }

  async createWorkspaceForUser(input: { userId: string; name: string }) {
    const user = this.users.find((item) => item.id === input.userId);
    if (!user) {
      throw new NotFoundException(`User ${input.userId} not found`);
    }

    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException("请先填写工作区名称");
    }

    const { workspace, membership, wallet } = this.createOwnedWorkspaceBundle(user.id, {
      name,
      planName: "轻享版",
      status: "trial",
      initialBalanceCny: 20,
    });
    user.activeWorkspaceId = workspace.id;

    this.workspaces.unshift(workspace);
    this.workspaceMembers.unshift(membership);
    this.wallets.unshift(wallet);

    await Promise.all([
      this.postgresStateService.upsertWorkspace(workspace),
      this.postgresStateService.upsertWorkspaceMember(membership),
      this.postgresStateService.upsertWallet(wallet),
      this.postgresStateService.upsertUser(user),
    ]);

    if (user.id === this.currentUser.id) {
      await this.setCurrentWorkspace(workspace.id);
    }

    return this.getAuthContextByUserId(user.id);
  }

  async updateWorkspaceName(input: { currentUserId: string; workspaceId: string; name: string }) {
    this.assertUserCanManageWorkspace(input.currentUserId, input.workspaceId);

    const workspace = this.getWorkspace(input.workspaceId);
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException("请先填写工作区名称");
    }

    workspace.name = name;
    await this.postgresStateService.upsertWorkspace(workspace);

    return this.getAuthContextByUserId(input.currentUserId);
  }

  async updateUserProfile(input: { userId: string; displayName: string }) {
    const user = this.users.find((item) => item.id === input.userId);
    if (!user) {
      throw new NotFoundException(`User ${input.userId} not found`);
    }

    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new BadRequestException("请先填写昵称");
    }

    user.displayName = displayName;
    user.avatarInitial = displayName.slice(0, 1).toUpperCase();
    await this.postgresStateService.upsertUser(user);

    if (this.currentUser.id === user.id) {
      this.currentUser = this.toUserRecord(user);
      await this.postgresStateService.upsertCurrentUser(this.currentUser);
    }

    return this.getAuthContextByUserId(input.userId);
  }

  async updateUserPassword(input: { userId: string; currentPassword: string; newPassword: string }) {
    const user = this.users.find((item) => item.id === input.userId);
    if (!user) {
      throw new NotFoundException(`User ${input.userId} not found`);
    }

    if (!this.verifyPassword(input.currentPassword, user.passwordHash)) {
      throw new BadRequestException("当前密码不正确");
    }

    const nextPassword = input.newPassword.trim();
    if (nextPassword.length < 8) {
      throw new BadRequestException("新密码至少需要 8 位");
    }

    user.passwordHash = this.hashPassword(nextPassword);
    await this.postgresStateService.upsertUser(user);

    return {
      ok: true,
      message: "密码已更新，请用新密码继续登录。",
    };
  }

  async leaveWorkspace(input: { currentUserId: string; workspaceId: string }) {
    this.assertUserHasWorkspaceAccess(input.currentUserId, input.workspaceId);

    const membership = this.getWorkspaceMembership(input.currentUserId, input.workspaceId);
    if (!membership) {
      throw new NotFoundException("你不在当前工作区中");
    }

    const nextWorkspace = this.listUserWorkspaces(input.currentUserId).find(
      (item) => item.id !== input.workspaceId,
    );
    if (!nextWorkspace) {
      throw new BadRequestException("至少保留一个可用工作区后才能退出当前工作区");
    }

    if (membership.role === "owner") {
      const ownerCount = this.workspaceMembers.filter(
        (item) => item.workspaceId === input.workspaceId && item.role === "owner",
      ).length;
      if (ownerCount <= 1) {
        throw new BadRequestException("当前工作区最后一位拥有者不能直接退出，请先转移拥有者或归档工作区");
      }
    }

    this.workspaceMembers = this.workspaceMembers.filter((item) => item.id !== membership.id);
    await this.postgresStateService.deleteWorkspaceMember(membership.userId, membership.workspaceId);

    const currentUser = this.users.find((item) => item.id === input.currentUserId);
    if (currentUser?.activeWorkspaceId === input.workspaceId) {
      currentUser.activeWorkspaceId = nextWorkspace.id;
      await this.postgresStateService.upsertUser(currentUser);

      if (this.currentUser.id === currentUser.id) {
        this.currentUser = this.toUserRecord(currentUser);
        await this.postgresStateService.upsertCurrentUser(this.currentUser);
      }
    }

    return this.getAuthContextByUserId(input.currentUserId);
  }

  async archiveWorkspace(input: { currentUserId: string; workspaceId: string }) {
    this.assertUserCanManageWorkspace(input.currentUserId, input.workspaceId);

    const workspace = this.getWorkspace(input.workspaceId);
    const nextWorkspace = this.listUserWorkspaces(input.currentUserId).find(
      (item) => item.id !== input.workspaceId,
    );
    if (!nextWorkspace) {
      throw new BadRequestException("至少保留一个可用工作区后才能归档当前工作区");
    }

    const deploymentCount = this.deployments.filter((item) => item.workspaceId === input.workspaceId).length;
    if (deploymentCount > 0) {
      throw new BadRequestException("请先销毁当前工作区下的全部实例，再归档工作区");
    }

    const memberCount = this.workspaceMembers.filter((item) => item.workspaceId === input.workspaceId).length;
    if (memberCount > 1) {
      throw new BadRequestException("请先移除或让其他成员退出当前工作区，再执行归档");
    }

    workspace.status = "archived";
    await this.postgresStateService.upsertWorkspace(workspace);

    const currentUser = this.users.find((item) => item.id === input.currentUserId);
    if (currentUser?.activeWorkspaceId === input.workspaceId) {
      currentUser.activeWorkspaceId = nextWorkspace.id;
      await this.postgresStateService.upsertUser(currentUser);

      if (this.currentUser.id === currentUser.id) {
        this.currentUser = this.toUserRecord(currentUser);
        await this.postgresStateService.upsertCurrentUser(this.currentUser);
      }
    }

    return this.getAuthContextByUserId(input.currentUserId);
  }

  async loginUser(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    const user = this.users.find((item) => item.email.toLowerCase() === email);
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

    const session = this.sessions.find((item) => item.token === token);
    if (!session) {
      return null;
    }

    session.lastSeenAt = new Date().toISOString();
    await this.postgresStateService.upsertSession(session);
    return session;
  }

  async setCurrentWorkspace(workspaceId: string) {
    this.getWorkspace(workspaceId);
    this.currentUser = {
      ...this.currentUser,
      activeWorkspaceId: workspaceId,
    };
    await this.postgresStateService.upsertCurrentUser(this.currentUser);
    return this.currentUser;
  }

  listWorkspaces() {
    return this.workspaces;
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
    const accessibleWorkspaceIds = new Set(this.listUserWorkspaces(userId).map((item) => item.id));
    if (workspaceId) {
      this.assertUserHasWorkspaceAccess(userId, workspaceId);
      return this.deployments.filter((item) => item.workspaceId === workspaceId);
    }
    return this.deployments.filter((item) => accessibleWorkspaceIds.has(item.workspaceId));
  }

  getDeploymentForUser(userId: string, deploymentId: string) {
    const deployment = this.getDeployment(deploymentId);
    this.assertUserHasWorkspaceAccess(userId, deployment.workspaceId);
    return deployment;
  }

  async setCurrentWorkspaceForUser(userId: string, workspaceId: string) {
    const user = this.users.find((item) => item.id === userId);
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const targetWorkspace = this.listUserWorkspaces(userId).find((item) => item.id === workspaceId);
    if (!targetWorkspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    user.activeWorkspaceId = workspaceId;
    await this.postgresStateService.upsertUser(user);

    if (user.id === this.currentUser.id) {
      await this.setCurrentWorkspace(workspaceId);
    }

    return this.toUserRecord(user);
  }

  async addWorkspaceMemberByEmail(input: {
    currentUserId: string;
    workspaceId: string;
    email: string;
    role?: "owner" | "member";
  }) {
    this.assertUserCanManageWorkspace(input.currentUserId, input.workspaceId);

    const normalizedEmail = input.email.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new NotFoundException("请先填写成员邮箱");
    }

    const user = this.users.find((item) => item.email.toLowerCase() === normalizedEmail);
    if (!user) {
      throw new NotFoundException("该邮箱尚未注册小懒布账号");
    }

    const existing = this.getWorkspaceMembership(user.id, input.workspaceId);
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

    this.workspaceMembers.unshift(membership);
    await this.postgresStateService.upsertWorkspaceMember(membership);

    return this.listWorkspaceMembers(input.workspaceId);
  }

  async updateWorkspaceMemberRole(input: {
    currentUserId: string;
    workspaceId: string;
    memberId: string;
    role: "owner" | "member";
  }) {
    this.assertUserCanManageWorkspace(input.currentUserId, input.workspaceId);

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

    membership.role = input.role;
    await this.postgresStateService.upsertWorkspaceMember(membership);

    if (input.role !== "owner") {
      await this.reassignWorkspaceOwnerIfNeeded(input.workspaceId, membership.userId);
    }

    return this.listWorkspaceMembers(input.workspaceId);
  }

  async removeWorkspaceMember(input: {
    currentUserId: string;
    workspaceId: string;
    memberId: string;
  }) {
    this.assertUserCanManageWorkspace(input.currentUserId, input.workspaceId);

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

    return this.listWorkspaceMembers(input.workspaceId);
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

    const workspaces = this.listUserWorkspaceViews(user.id);
    const publicUser = this.toUserRecord(user);
    return {
      user: publicUser,
      workspaces,
      activeWorkspaceId: publicUser.activeWorkspaceId,
      currentWorkspace:
        workspaces.find((item) => item.id === publicUser.activeWorkspaceId) ?? workspaces[0] ?? null,
      currentWorkspaceRole:
        this.getWorkspaceMembership(user.id, publicUser.activeWorkspaceId)?.role ?? null,
    };
  }

  getWorkspace(workspaceId: string) {
    const workspace = this.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    return workspace;
  }

  listDeployments(workspaceId?: string) {
    if (!workspaceId) {
      return this.deployments;
    }
    this.getWorkspace(workspaceId);
    return this.deployments.filter((item) => item.workspaceId === workspaceId);
  }

  async createDeployment(input: CreateDeploymentInput) {
    this.getWorkspace(input.workspaceId);

    const record: DeploymentRecord = {
      id: input.id ?? `dep_${Date.now()}`,
      workspaceId: input.workspaceId,
      name: input.name,
      mode: input.mode,
      status: input.status ?? (input.mode === "cloud" ? "creating" : "running"),
      provider: input.provider ?? (input.mode === "cloud" ? "aliyun" : "local"),
      region: input.region ?? (input.mode === "cloud" ? "cn-hangzhou" : "local-device"),
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl:
        input.consoleUrl ??
        (input.mode === "cloud"
          ? `https://console.xiaolanbu.app/demo/${input.name}`
          : "http://127.0.0.1:18789"),
      gatewayUrl:
        input.gatewayUrl ??
        (input.mode === "cloud"
          ? `https://api.xiaolanbu.app/gateway/${input.workspaceId}`
          : "http://127.0.0.1:3031"),
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

    this.deployments.unshift(record);
    await this.postgresStateService.upsertDeployment(record);
    return record;
  }

  async updateDeploymentStatus(deploymentId: string, status: DeploymentStatus) {
    const record = this.getDeployment(deploymentId);
    record.status = status;
    record.lastHeartbeatAt = new Date().toISOString();
    await this.postgresStateService.upsertDeployment(record);
    return record;
  }

  async updateDeployment(deploymentId: string, patch: Partial<DeploymentRecord>) {
    const record = this.getDeployment(deploymentId);
    Object.assign(record, patch);
    record.lastHeartbeatAt = new Date().toISOString();
    await this.postgresStateService.upsertDeployment(record);
    return record;
  }

  async deleteDeployment(deploymentId: string) {
    const index = this.deployments.findIndex((item) => item.id === deploymentId);
    if (index < 0) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const [removed] = this.deployments.splice(index, 1);
    await this.postgresStateService.deleteDeployment(deploymentId);
    return removed;
  }

  getDeployment(deploymentId: string) {
    const record = this.deployments.find((item) => item.id === deploymentId);
    if (!record) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    return record;
  }

  getWallet(workspaceId: string) {
    this.getWorkspace(workspaceId);
    const wallet = this.wallets.find((item) => item.workspaceId === workspaceId);
    if (!wallet) {
      throw new NotFoundException(`Wallet for workspace ${workspaceId} not found`);
    }
    return wallet;
  }

  getUsageSummary(workspaceId: string, period: "today" | "7d" | "30d") {
    this.getWorkspace(workspaceId);
    const dynamicSummary = this.buildUsageSummaryFromLedger(workspaceId, period);
    if (dynamicSummary) {
      return dynamicSummary;
    }
    const summary =
      this.usageSummaries.find((item) => item.workspaceId === workspaceId && item.period === period) ??
      this.usageSummaries.find((item) => item.workspaceId === workspaceId && item.period === "today");
    if (summary) {
      return summary;
    }

    return {
      workspaceId,
      period,
      requestCount: 0,
      totalTokens: 0,
      totalCostCny: 0,
      topModels: [],
    };
  }

  listDeploymentUsageSummaries(workspaceId: string, period: "today" | "7d" | "30d") {
    this.getWorkspace(workspaceId);

    const now = Date.now();
    const periodStart =
      period === "today"
        ? now - 24 * 60 * 60 * 1000
        : period === "7d"
          ? now - 7 * 24 * 60 * 60 * 1000
          : now - 30 * 24 * 60 * 60 * 1000;

    const ledgerByDeploymentId = new Map<string, UsageLedgerRecord[]>();

    for (const item of this.usageLedger) {
      if (item.workspaceId !== workspaceId) {
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

    return this.listDeployments(workspaceId)
      .map<DeploymentUsageSummaryRecord>((deployment) => {
        const items = ledgerByDeploymentId.get(deployment.id) ?? [];
        return {
          workspaceId,
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
    this.getWorkspace(workspaceId);
    const transactionFeed = this.walletTransactions
      .filter((item) => item.workspaceId === workspaceId)
      .map<BillingFeedRecord>((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        kind:
          item.type === "topup" ? "topup" : item.type === "usage" ? "usage" : "adjustment",
        title: item.title,
        amountCny: item.amountCny,
        createdAt: item.createdAt,
      }));

    return [...this.billingFeed.filter((item) => item.workspaceId === workspaceId), ...transactionFeed].sort(
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
    this.getWorkspace(workspaceId);
    const items = this.usageLedger
      .filter((item) => item.workspaceId === workspaceId)
      .filter((item) => (input?.deploymentId ? item.deploymentId === input.deploymentId : true))
      .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));

    if (typeof input?.limit === "number" && input.limit > 0) {
      return items.slice(0, input.limit);
    }

    return items;
  }

  findUsageLedger(workspaceId: string, deploymentId: string, requestId: string) {
    return this.usageLedger.find(
      (item) =>
        item.workspaceId === workspaceId &&
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

  listWalletTransactions(workspaceId: string, limit = 50) {
    this.getWorkspace(workspaceId);
    return this.walletTransactions
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async createWalletTransaction(
    workspaceId: string,
    input: Omit<WalletTransactionRecord, "id" | "walletId" | "workspaceId" | "balanceAfterCny">,
  ) {
    const wallet = this.getWallet(workspaceId);
    wallet.balanceCny = this.roundCurrency(wallet.balanceCny + input.amountCny);

    const record: WalletTransactionRecord = {
      id: `wtx_${Date.now()}_${this.walletTransactions.length + 1}`,
      walletId: wallet.id,
      workspaceId,
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

  findDeploymentByGatewayTokenId(workspaceId: string, tokenId: string) {
    return this.deployments.find(
      (item) => item.workspaceId === workspaceId && item.gatewayKey?.tokenId === tokenId,
    );
  }

  private buildUsageSummaryFromLedger(
    workspaceId: string,
    period: "today" | "7d" | "30d",
  ): UsageSummaryRecord | null {
    const now = Date.now();
    const periodStart =
      period === "today"
        ? now - 24 * 60 * 60 * 1000
        : period === "7d"
          ? now - 7 * 24 * 60 * 60 * 1000
          : now - 30 * 24 * 60 * 60 * 1000;

    const items = this.usageLedger.filter((item) => {
      if (item.workspaceId !== workspaceId) {
        return false;
      }
      const finishedAt = Date.parse(item.finishedAt);
      return Number.isFinite(finishedAt) && finishedAt >= periodStart;
    });

    if (items.length === 0) {
      return null;
    }

    const topModelsMap = new Map<string, { tokens: number; costCny: number }>();

    for (const item of items) {
      const entry = topModelsMap.get(item.model) ?? { tokens: 0, costCny: 0 };
      entry.tokens += item.totalTokens;
      entry.costCny = this.roundCurrency(entry.costCny + item.billableCostCny);
      topModelsMap.set(item.model, entry);
    }

    const topModels = [...topModelsMap.entries()]
      .map(([model, value]) => ({
        model,
        tokens: value.tokens,
        costCny: value.costCny,
      }))
      .sort((left, right) => right.costCny - left.costCny)
      .slice(0, 5);

    return {
      workspaceId,
      period,
      requestCount: items.length,
      totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
      totalCostCny: this.roundCurrency(items.reduce((sum, item) => sum + item.billableCostCny, 0)),
      topModels,
    };
  }

  private async createSessionForUser(user: AuthUserRecord) {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: `sess_${Date.now()}`,
      token: `xlb_sess_${randomBytes(24).toString("hex")}`,
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
    };

    this.sessions.unshift(session);
    await this.postgresStateService.upsertSession(session);

    return {
      sessionToken: session.token,
      user: this.toUserRecord(user),
      activeWorkspaceId: user.activeWorkspaceId,
      currentWorkspace:
        this.listUserWorkspaceViews(user.id).find((item) => item.id === user.activeWorkspaceId) ?? null,
      currentWorkspaceRole:
        this.getWorkspaceMembership(user.id, user.activeWorkspaceId)?.role ?? null,
      workspaces: this.listUserWorkspaceViews(user.id),
    };
  }

  private toUserRecord(user: AuthUserRecord): UserRecord {
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      avatarInitial: user.avatarInitial,
      activeWorkspaceId: user.activeWorkspaceId,
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
