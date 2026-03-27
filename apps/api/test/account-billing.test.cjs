const test = require("node:test");
const assert = require("node:assert/strict");
require("reflect-metadata");

const { HEADERS_METADATA } = require("@nestjs/common/constants");

const { StoreService } = require("../dist/modules/store/store.service.js");
const { BillingService } = require("../dist/modules/billing/billing.service.js");
const { BillingSyncService } = require("../dist/modules/billing/billing-sync.service.js");
const { BillingController } = require("../dist/modules/billing/billing.controller.js");
const { AuthController } = require("../dist/modules/auth/auth.controller.js");
const { HealthController } = require("../dist/modules/health/health.controller.js");

function createPostgresStateStub() {
  return {
    ensureInitialized: async () => {},
    isEnabled: () => false,
    listDeployments: async () => [],
    listWallets: async () => [],
    listUsageLedger: async () => [],
    listWalletTransactions: async () => [],
    listUsers: async () => [],
    listWorkspacesCatalog: async () => [],
    listWorkspaceMembers: async () => [],
    listSessions: async () => [],
    listLocalGatewayCredentials: async () => [],
    upsertDeployment: async () => {},
    upsertLocalGatewayCredential: async () => {},
    upsertWallet: async () => {},
    insertUsageLedger: async () => {},
    insertWalletTransaction: async () => {},
    upsertWorkspace: async () => {},
    upsertWorkspaceMember: async () => {},
    upsertUser: async () => {},
    upsertSession: async () => {},
    deleteLegacyCurrentUserState: async () => {},
    deleteWorkspaceMember: async () => {},
    deleteSessionByToken: async () => {},
    deleteDeployment: async () => {},
    deleteExpiredSessions: async () => 0,
    withAdvisoryLock: async (_lockId, _timeoutMs, operation) => ({
      acquired: true,
      value: await operation(),
    }),
    checkReadiness: async () => ({
      ok: false,
      reason: "DATABASE_URL is not configured",
      database: {
        enabled: false,
        initialized: true,
        pool: null,
      },
    }),
    getHealthSnapshot: () => ({
      enabled: false,
      initialized: true,
      pool: null,
    }),
  };
}

function createLiteLlmProxyStub() {
  const updates = [];

  return {
    updates,
    async listSpendLogs() {
      return [];
    },
    async getVirtualKeyInfo(key) {
      return {
        key,
        info: {
          spend: 12.5,
          blocked: false,
          metadata: {
            user_id: "user_001",
            workspace_id: "ws_main",
          },
        },
      };
    },
    async updateVirtualKey(input) {
      updates.push(input);
      return { ok: true };
    },
  };
}

async function createStoreService() {
  const store = new StoreService(createPostgresStateStub());
  await store.onModuleInit();
  return store;
}

test("syncUserUsage aggregates all deployments owned by one account and dedupes repeated logs", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);

  const deploymentMain = await store.createDeployment({
    id: "dep_account_main",
    workspaceId: "ws_main",
    name: "账号主实例",
    mode: "cloud",
    status: "running",
    provider: "aliyun",
    region: "cn-hangzhou",
    gatewayKey: {
      tokenId: "vk_main",
      secretKey: "sk-main",
      modelId: "qwen35-plus",
      baseUrl: "https://gateway.xiaolanbu.com/v1",
    },
  });

  const deploymentTeam = await store.createDeployment({
    id: "dep_account_team",
    workspaceId: "ws_team",
    name: "账号团队实例",
    mode: "cloud",
    status: "running",
    provider: "aliyun",
    region: "cn-shanghai",
    gatewayKey: {
      tokenId: "vk_team",
      secretKey: "sk-team",
      modelId: "qwen35-plus",
      baseUrl: "https://gateway.xiaolanbu.com/v1",
    },
  });

  liteLlm.listSpendLogs = async () => [
    {
      request_id: "req_main_1",
      api_key: "vk_main",
      startTime: "2026-03-18T00:00:00.000Z",
      endTime: "2026-03-18T00:00:02.000Z",
      model: "qwen35-plus",
      custom_llm_provider: "dashscope",
      status: "success",
      metadata: {
        user_id: "user_001",
        workspace_id: "ws_main",
        user_api_key_alias: `deployment:${deploymentMain.id}`,
        usage_object: {
          prompt_tokens: 1200,
          completion_tokens: 300,
          total_tokens: 1500,
        },
      },
    },
    {
      request_id: "req_team_1",
      api_key: "vk_team",
      startTime: "2026-03-18T00:05:00.000Z",
      endTime: "2026-03-18T00:05:03.000Z",
      model: "qwen35-plus",
      custom_llm_provider: "dashscope",
      status: "success",
      metadata: {
        user_id: "user_001",
        workspace_id: "ws_team",
        user_api_key_alias: `deployment:${deploymentTeam.id}`,
        usage_object: {
          prompt_tokens: 800,
          completion_tokens: 200,
          total_tokens: 1000,
        },
      },
    },
    {
      request_id: "req_other_user",
      api_key: "vk_other",
      startTime: "2026-03-18T00:10:00.000Z",
      endTime: "2026-03-18T00:10:02.000Z",
      model: "qwen35-plus",
      custom_llm_provider: "dashscope",
      status: "success",
      metadata: {
        user_id: "user_002",
        workspace_id: "ws_demo_user",
        user_api_key_alias: "deployment:dep_other",
        usage_object: {
          prompt_tokens: 500,
          completion_tokens: 100,
          total_tokens: 600,
        },
      },
    },
  ];

  const beforeBalance = store.getWalletByUserId("user_001").balanceCny;

  const firstRun = await billing.syncUserUsage({
    userId: "user_001",
    limit: 100,
  });

  assert.equal(firstRun.userId, "user_001");
  assert.equal(firstRun.synced, 2);
  assert.equal(firstRun.skipped, 0);
  assert.equal(firstRun.items.length, 2);

  const summaries = store.listDeploymentUsageSummariesByUserId("user_001", "today");
  const summaryDeploymentIds = new Set(summaries.map((item) => item.deploymentId));
  assert.ok(summaryDeploymentIds.has(deploymentMain.id));
  assert.ok(summaryDeploymentIds.has(deploymentTeam.id));

  const afterFirstBalance = store.getWalletByUserId("user_001").balanceCny;
  assert.ok(afterFirstBalance < beforeBalance, "wallet should be charged after synced usage");

  const secondRun = await billing.syncUserUsage({
    userId: "user_001",
    limit: 100,
  });

  assert.equal(secondRun.synced, 0);
  assert.equal(secondRun.skipped, 2);
  assert.equal(store.listUsageLedgerByUserId("user_001").length, 2);
  assert.equal(store.getWalletByUserId("user_001").balanceCny, afterFirstBalance);
});

test("syncUserUsage maps local credential spend into the synthetic local bucket and exposes localUsage", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);
  const now = new Date();
  const oneSecondAgo = new Date(now.getTime() - 1000);

  await store.upsertLocalGatewayCredential({
    id: "lgc_user_002_ws_demo_user",
    userId: "user_002",
    accountScopeId: "ws_demo_user",
    tokenId: "vk_local_demo",
    secretKey: "sk-local-demo",
    baseUrl: "https://gateway.xiaolanbu.com/v1",
    providerId: "openai",
    defaultModelId: "gpt-5.2",
    allowedModelIds: ["gpt-5.2", "gpt-4o"],
    status: "active",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    metadata: {
      localDeviceId: "desktop-a",
    },
  });

  liteLlm.listSpendLogs = async () => [
    {
      request_id: "req_local_1",
      api_key: "vk_local_demo",
      startTime: oneSecondAgo.toISOString(),
      endTime: now.toISOString(),
      model: "gpt-5.2",
      custom_llm_provider: "openai",
      status: "success",
      metadata: {
        user_id: "user_002",
        workspace_id: "ws_demo_user",
        account_scope_id: "ws_demo_user",
        credential_scope: "local",
        usage_object: {
          prompt_tokens: 400,
          completion_tokens: 160,
          total_tokens: 560,
        },
      },
    },
  ];

  const result = await billing.syncUserUsage({
    userId: "user_002",
    limit: 100,
  });

  assert.equal(result.synced, 1);
  assert.equal(result.skipped, 0);

  const ledgerItems = store.listUsageLedgerByUserId("user_002");
  const localLedger = ledgerItems.find((item) => item.requestId === "req_local_1");
  assert.ok(localLedger, "expected local usage ledger entry");
  assert.equal(localLedger.workspaceId, "ws_demo_user");
  assert.equal(localLedger.deploymentId, "local:ws_demo_user");
  assert.equal(localLedger.metadata.client_scope, "local");
  assert.equal(localLedger.metadata.local_device_id, "desktop-a");

  const usage = await billing.getUserUsageSummaryWithLocal("user_002", "today");
  assert.equal(usage.localUsage.workspaceId, "ws_demo_user");
  assert.equal(usage.localUsage.requestCount, 1);
  assert.equal(usage.localUsage.totalTokens, 560);
  assert.ok(usage.localUsage.totalCostCny >= 0);

  const summaries = store.listDeploymentUsageSummariesByUserId("user_002", "today");
  assert.ok(summaries.every((item) => !item.deploymentId.startsWith("local:")));
});

test("reconcileUserGatewayBudgets blocks all keys under one account when balance is exhausted", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);

  await store.createDeployment({
    id: "dep_reconcile_main",
    workspaceId: "ws_main",
    name: "主实例",
    mode: "cloud",
    status: "running",
    provider: "aliyun",
    region: "cn-hangzhou",
    gatewayKey: {
      tokenId: "vk_reconcile_main",
      secretKey: "sk-reconcile-main",
      modelId: "qwen35-plus",
      baseUrl: "https://gateway.xiaolanbu.com/v1",
    },
  });

  await store.createDeployment({
    id: "dep_reconcile_team",
    workspaceId: "ws_team",
    name: "团队实例",
    mode: "cloud",
    status: "running",
    provider: "aliyun",
    region: "cn-shanghai",
    gatewayKey: {
      tokenId: "vk_reconcile_team",
      secretKey: "sk-reconcile-team",
      modelId: "qwen35-plus",
      baseUrl: "https://gateway.xiaolanbu.com/v1",
    },
  });

  const wallet = store.getWalletByUserId("user_001");
  wallet.balanceCny = 0;

  const result = await billing.reconcileUserGatewayBudgets("user_001");

  assert.equal(result.userId, "user_001");
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((item) => item.blocked === true));
  assert.equal(liteLlm.updates.length, 2);
  assert.ok(liteLlm.updates.every((item) => item.blocked === true));
});

test("reconcileUserGatewayBudgets recovers logged deployment keys for an account even when deployment records are missing", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);

  liteLlm.listSpendLogs = async () => [
    {
      api_key: "vk_logged_only",
      metadata: {
        user_id: "user_001",
        workspace_id: "ws_main",
        user_api_key_alias: "deployment:dep_logged_only",
      },
    },
  ];
  liteLlm.getVirtualKeyInfo = async (key) => ({
    key,
    info: {
      spend: 3.25,
      blocked: true,
      max_budget: 0,
      key_alias: "deployment:dep_logged_only",
      metadata: {
        user_id: "user_001",
        workspace_id: "ws_main",
      },
    },
  });

  const result = await billing.reconcileUserGatewayBudgets("user_001");

  assert.equal(result.userId, "user_001");
  assert.ok(
    result.items.some(
      (item) =>
        item.keyAlias === "deployment:dep_logged_only" &&
        item.source === "log-reconcile" &&
        item.blocked === false,
    ),
  );
  assert.ok(
    liteLlm.updates.some(
      (item) =>
        item.key === "vk_logged_only" &&
        item.blocked === false &&
        item.maxBudget > 0,
    ),
  );
});

test("syncUserUsage falls back to logged upstream spend for non-qwen models", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);

  await store.createDeployment({
    id: "dep_openai_main",
    workspaceId: "ws_main",
    name: "OpenAI 兼容实例",
    mode: "cloud",
    status: "running",
    provider: "aliyun",
    region: "cn-hangzhou",
    gatewayKey: {
      tokenId: "vk_openai_main",
      secretKey: "sk-openai-main",
      modelId: "gpt-5.2",
      baseUrl: "https://gateway.xiaolanbu.com/v1",
    },
  });

  liteLlm.listSpendLogs = async () => [
    {
      request_id: "req_openai_1",
      api_key: "vk_openai_main",
      startTime: "2026-03-18T01:00:00.000Z",
      endTime: "2026-03-18T01:00:01.000Z",
      model: "gpt-5.2",
      custom_llm_provider: "openai",
      spend: 0.42,
      status: "success",
      metadata: {
        user_id: "user_001",
        workspace_id: "ws_main",
        usage_object: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      },
    },
  ];

  const result = await billing.syncUserUsage({
    userId: "user_001",
    limit: 10,
  });

  assert.equal(result.synced, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].provider, "openai");
  assert.equal(result.items[0].model, "gpt-5.2");
  assert.equal(result.items[0].upstreamCostCny, 0.42);
  assert.equal(result.items[0].billableCostCny, 0.63);
  assert.equal(result.items[0].priceSnapshot.pricingVersion, "logged-spend-fallback-v1");
});

test("reconcileUserGatewayBudgets ignores logged deployment keys that have no account ownership metadata", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);

  liteLlm.listSpendLogs = async () => [
    {
      api_key: "vk_unknown_owner",
      metadata: {
        user_api_key_alias: "deployment:dep_unknown_owner",
      },
    },
  ];

  const result = await billing.reconcileUserGatewayBudgets("user_001");

  assert.equal(result.userId, "user_001");
  assert.equal(
    result.items.some((item) => item.keyAlias === "deployment:dep_unknown_owner"),
    false,
  );
  assert.equal(
    liteLlm.updates.some((item) => item.key === "vk_unknown_owner"),
    false,
  );
});

test("reconcileUserGatewayBudgets ignores deployment-record keys when live key ownership belongs to another account", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);

  await store.createDeployment({
    id: "dep_wrong_owner",
    workspaceId: "ws_main",
    name: "错误归属实例",
    mode: "cloud",
    status: "running",
    provider: "aliyun",
    region: "cn-hangzhou",
    gatewayKey: {
      tokenId: "vk_wrong_owner",
      secretKey: "sk-wrong-owner",
      modelId: "qwen35-plus",
      baseUrl: "https://gateway.xiaolanbu.com/v1",
    },
  });

  liteLlm.getVirtualKeyInfo = async (key) => ({
    key,
    info: {
      spend: 4.2,
      blocked: false,
      metadata: {
        user_id: "user_002",
        workspace_id: "ws_demo_user",
      },
    },
  });

  const result = await billing.reconcileUserGatewayBudgets("user_001");

  assert.equal(result.userId, "user_001");
  assert.equal(result.items.length, 0);
  assert.equal(liteLlm.updates.length, 0);
});

test("reconcileUserGatewayBudgets ignores logged deployment keys when live key ownership mismatches the account", async () => {
  const store = await createStoreService();
  const liteLlm = createLiteLlmProxyStub();
  const billing = new BillingService(store, liteLlm);

  liteLlm.listSpendLogs = async () => [
    {
      api_key: "vk_logged_mismatch",
      metadata: {
        user_id: "user_001",
        workspace_id: "ws_main",
        user_api_key_alias: "deployment:dep_logged_mismatch",
      },
    },
  ];
  liteLlm.getVirtualKeyInfo = async (key) => ({
    key,
    info: {
      spend: 6.75,
      blocked: false,
      metadata: {
        user_id: "user_002",
        workspace_id: "ws_demo_user",
      },
    },
  });

  const result = await billing.reconcileUserGatewayBudgets("user_001");

  assert.equal(result.userId, "user_001");
  assert.equal(
    result.items.some((item) => item.keyAlias === "deployment:dep_logged_mismatch"),
    false,
  );
  assert.equal(
    liteLlm.updates.some((item) => item.key === "vk_logged_mismatch"),
    false,
  );
});

test("billing sync service runs at most once per account and no longer depends on workspace iteration", async () => {
  const calls = [];
  const storeService = {
    async listUsersAsync() {
      return [{ id: "user_001" }, { id: "user_002" }];
    },
    listWorkspaces() {
      throw new Error("legacy workspace iteration should not be used");
    },
  };
  const billingService = {
    async syncUserUsage(input) {
      calls.push(input);
      return {
        userId: input.userId,
        accountScopeId: input.userId === "user_001" ? "ws_main" : "ws_demo_user",
        synced: 0,
        skipped: 0,
        scanned: 1,
        items: [],
      };
    },
  };

  const postgresStateService = {
    isEnabled() {
      return true;
    },
    async withAdvisoryLock(_lockId, _timeoutMs, operation) {
      return {
        acquired: true,
        value: await operation(),
      };
    },
  };

  const queueService = {
    isEnabled() {
      return false;
    },
    isWorkerMode() {
      return false;
    },
  };

  const syncService = new BillingSyncService(
    storeService,
    billingService,
    postgresStateService,
    queueService,
  );
  process.env.XLB_BILLING_SYNC_LIMIT = "77";

  await syncService.runSyncCycle("startup");

  assert.deepEqual(calls, [
    { userId: "user_001", limit: 77 },
    { userId: "user_002", limit: 77 },
  ]);
});

test("billing sync service skips cycle when another replica holds the leader lock", async () => {
  const calls = [];
  const storeService = {
    async listUsersAsync() {
      calls.push("listUsersAsync");
      return [{ id: "user_001" }];
    },
  };
  const billingService = {
    async syncUserUsage() {
      calls.push("syncUserUsage");
      return {
        userId: "user_001",
        accountScopeId: "ws_main",
        synced: 0,
        skipped: 0,
        scanned: 0,
        items: [],
      };
    },
  };
  const postgresStateService = {
    isEnabled() {
      return true;
    },
    async withAdvisoryLock() {
      return {
        acquired: false,
        value: null,
      };
    },
  };

  const queueService = {
    isEnabled() {
      return true;
    },
    isWorkerMode() {
      return false;
    },
    async enqueueBillingJobIfIdle() {
      calls.push("enqueueBillingJobIfIdle");
      return null;
    },
  };

  const syncService = new BillingSyncService(
    storeService,
    billingService,
    postgresStateService,
    queueService,
  );
  await syncService.runSyncCycle("startup");

  assert.deepEqual(calls, []);
});

test("billing account aliases reuse the same account-first handlers", async () => {
  const storeCalls = [];
  const billingCalls = [];
  const storeService = {
    async getUserBySessionTokenAsync(sessionToken) {
      return sessionToken === "sess_ok" ? { id: "user_001" } : null;
    },
    async getPreferredWorkspaceIdForUserAsync(userId) {
      storeCalls.push(["getPreferredWorkspaceIdForUser", userId]);
      return "ws_main";
    },
    async getWalletByUserIdAsync(userId) {
      storeCalls.push(["getWalletByUserId", userId]);
      return { id: "wallet_main", userId, balanceCny: 100 };
    },
    async getUsageSummaryByUserIdAsync(userId, period) {
      storeCalls.push(["getUsageSummaryByUserId", userId, period]);
      return { userId, period, totalCostCny: 1.23 };
    },
    async listDeploymentUsageSummariesByUserIdAsync(userId, period) {
      storeCalls.push(["listDeploymentUsageSummariesByUserId", userId, period]);
      return [{ userId, period, deploymentId: "dep_1" }];
    },
    async listBillingFeedByUserIdAsync(userId) {
      storeCalls.push(["listBillingFeedByUserId", userId]);
      return [{ id: "feed_1", userId }];
    },
    async listUsageLedgerByUserIdAsync(userId, input) {
      storeCalls.push(["listUsageLedgerByUserId", userId, input]);
      return [{ id: "ledger_1", userId, ...input }];
    },
    async listWalletTransactionsByUserIdAsync(userId, limit) {
      storeCalls.push(["listWalletTransactionsByUserId", userId, limit]);
      return [{ id: "txn_1", userId, limit }];
    },
  };
  const billingService = {
    getUserUsageSummaryWithLocal(userId, period) {
      billingCalls.push(["getUserUsageSummaryWithLocal", userId, period]);
      return {
        summary: { userId, period, totalCostCny: 1.23 },
        localUsage: { userId, period, totalCostCny: 0.45, requestCount: 2 },
      };
    },
    syncUserUsage(input) {
      billingCalls.push(["syncUserUsage", input]);
      return { ok: true, ...input };
    },
    createWalletTopupForUser(input) {
      billingCalls.push(["createWalletTopupForUser", input]);
      return { ok: true, input };
    },
    createWalletAdjustmentForUser(input) {
      billingCalls.push(["createWalletAdjustmentForUser", input]);
      return { ok: true, input };
    },
    reconcileUserGatewayBudgets(userId) {
      billingCalls.push(["reconcileUserGatewayBudgets", userId]);
      return { ok: true, userId };
    },
  };

  const controller = new BillingController(storeService, billingService);

  assert.deepEqual(await controller.getAccountWallet("sess_ok"), {
    wallet: { id: "wallet_main", userId: "user_001", balanceCny: 100 },
  });
  assert.deepEqual(await controller.getAccountUsageSummary("today", "sess_ok"), {
    summary: { userId: "user_001", period: "today", totalCostCny: 1.23 },
    localUsage: { userId: "user_001", period: "today", totalCostCny: 0.45, requestCount: 2 },
  });
  assert.deepEqual(await controller.listAccountDeploymentUsageSummaries("today", "sess_ok"), {
    items: [{ userId: "user_001", period: "today", deploymentId: "dep_1" }],
  });
  assert.deepEqual(await controller.listAccountBillingFeed("sess_ok"), {
    items: [{ id: "feed_1", userId: "user_001" }],
  });
  assert.deepEqual(await controller.listAccountUsageLedger("dep_1", "25", "sess_ok"), {
    items: [{ id: "ledger_1", userId: "user_001", deploymentId: "dep_1", limit: 25 }],
  });
  assert.deepEqual(await controller.listAccountWalletTransactions("12", "sess_ok"), {
    items: [{ id: "txn_1", userId: "user_001", limit: 12 }],
  });
  assert.deepEqual(await controller.syncAccountUsage("15", "sess_ok"), {
    ok: true,
    userId: "user_001",
    limit: 15,
  });
  assert.deepEqual(
    await controller.createAccountWalletTopup({ amountCny: 88, title: "充值" }, "sess_ok"),
    { ok: true, input: { userId: "user_001", amountCny: 88, title: "充值" } },
  );
  assert.deepEqual(
    await controller.createAccountWalletAdjustment({ amountCny: -5, title: "调整" }, "sess_ok"),
    { ok: true, input: { userId: "user_001", amountCny: -5, title: "调整" } },
  );
  assert.deepEqual(await controller.reconcileAccountGatewayBudgets("sess_ok"), {
    ok: true,
    userId: "user_001",
  });

  assert.ok(storeCalls.some((entry) => entry[0] === "getWalletByUserId"));
  assert.ok(billingCalls.some((entry) => entry[0] === "getUserUsageSummaryWithLocal"));
  assert.ok(billingCalls.some((entry) => entry[0] === "syncUserUsage"));
  assert.ok(billingCalls.some((entry) => entry[0] === "reconcileUserGatewayBudgets"));
});

test("auth account-scope route accepts the new field and returns account-centric response", async () => {
  const storeService = {
    async getUserBySessionTokenAsync(sessionToken) {
      return sessionToken === "sess_ok" ? { id: "user_001" } : null;
    },
    async getPreferredWorkspaceIdForUserAsync() {
      return "ws_main";
    },
    async setCurrentWorkspaceForUser(userId, scopeId) {
      return { id: userId, activeWorkspaceId: scopeId };
    },
    async listUserWorkspaceViewsAsync() {
      return [{ id: "ws_team", role: "owner", name: "团队", ownerUserId: "user_001", planName: "pro", status: "active" }];
    },
    async getWorkspaceMembershipAsync() {
      return { role: "owner" };
    },
  };

  const controller = new AuthController(storeService);
  const result = await controller.setCurrentAccountScope("sess_ok", "ws_team", undefined);

  assert.equal(result.billingUserId, "user_001");
  assert.equal(result.accountScopeId, "ws_team");
  assert.equal(result.defaultScopeId, "ws_team");
  assert.equal(result.currentAccountScope.id, "ws_team");
  assert.equal(result.currentAccountRole, "owner");
  assert.equal(result.activeWorkspaceId, "ws_team");
});

test("health readiness exposes readiness fields", async () => {
  const controller = new HealthController(
    {
      getHealthSnapshot() {
        return {
          enabled: true,
          initialized: true,
          pool: { total: 1, idle: 1, waiting: 0 },
        };
      },
      async checkReadiness() {
        return {
          ok: true,
          database: {
            enabled: true,
            initialized: true,
            pool: { total: 1, idle: 1, waiting: 0 },
          },
        };
      },
    },
    {
      async ping() {
        return { ok: true, response: "PONG" };
      },
      getRedisHealthSnapshot() {
        return {
          enabled: true,
          workerMode: false,
          redisUrlConfigured: true,
        };
      },
    },
  );

  const result = await controller.getReadiness();

  assert.equal(result.ok, true);
  assert.equal(result.service, "xiaolanbu-api");
  assert.equal(result.redis.ok, true);
  assert.ok(result.session.ttlMs > 0);
  assert.ok(Number.isFinite(result.billingSync.leaderLockId));
});

test("legacy workspace routes advertise deprecation headers", async () => {
  const authHeaders =
    Reflect.getMetadata(HEADERS_METADATA, AuthController.prototype.setCurrentWorkspace) ?? [];
  const billingHeaders =
    Reflect.getMetadata(HEADERS_METADATA, BillingController.prototype.getWallet) ?? [];

  assert.deepEqual(
    authHeaders.map((item) => [item.name, item.value]),
    [
      ["X-Xiaolanbu-Legacy-Route", "true"],
      ["Deprecation", "true"],
    ],
  );
  assert.deepEqual(
    billingHeaders.map((item) => [item.name, item.value]),
    [
      ["X-Xiaolanbu-Legacy-Route", "true"],
      ["Deprecation", "true"],
    ],
  );
});
