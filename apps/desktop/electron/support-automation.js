const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  QIANNIU_APP_PATH,
  deriveQianNiuCurrentThread,
  getQianNiuHelperStatus,
  inspectQianNiuUi,
  readQianNiuThread,
  requestQianNiuAccessibility,
  sendQianNiuReply,
} = require("./qianniu-mac-helper");

const IS_WINDOWS = process.platform === "win32";
const WINDOWS_LOCAL_APP_DATA =
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const LOCAL_APP_SUPPORT_DIR = IS_WINDOWS
  ? path.join(WINDOWS_LOCAL_APP_DATA, "Xiaolanbu")
  : path.join(os.homedir(), "Library", "Application Support", "Xiaolanbu");
const LOCAL_COMMERCE_STATE_DIR = path.join(LOCAL_APP_SUPPORT_DIR, "commerce");
const LOCAL_SUPPORT_STATE_DIR = path.join(LOCAL_COMMERCE_STATE_DIR, "support");
const LOCAL_SUPPORT_PLATFORMS_PATH = path.join(LOCAL_SUPPORT_STATE_DIR, "platforms.json");
const LOCAL_SUPPORT_THREADS_PATH = path.join(LOCAL_SUPPORT_STATE_DIR, "threads.json");
const LOCAL_SUPPORT_RULES_PATH = path.join(LOCAL_SUPPORT_STATE_DIR, "rules.json");
const LOCAL_SUPPORT_AUDIT_PATH = path.join(LOCAL_SUPPORT_STATE_DIR, "audit.json");

const TAOBAO_DESKTOP_CONNECTION_MODE = "mac-qianniu-ui";
const TAOBAO_SETUP_STEP_FIELDS = Object.freeze([
  "multiStoreModeConfirmed",
  "narratorModeEnabled",
  "bubbleModeEnabled",
  "popupReminderEnabled",
  "messageAutoPinEnabled",
  "qianniuRestartConfirmed",
]);

const SUPPORT_PLATFORM_DEFINITIONS = Object.freeze([
  {
    id: "taobao",
    label: "淘宝 / 千牛",
    stage: "v1-primary",
    description: "V1 主链。通过千牛桌面版 + macOS 辅助功能控制收消息、读线程和发回复。",
    automationStatus: "supported",
    capabilities: {
      inbox: "mac-qianniu-ui",
      commerce: "desktop-context",
      actions: "approval-only",
    },
  },
  {
    id: "douyin",
    label: "抖音 / 抖店",
    stage: "v2",
    description: "当前先保留规划位，不再保留旧 API / demo 客服实现。",
    automationStatus: "coming-soon",
    capabilities: {
      inbox: "coming-soon",
      commerce: "coming-soon",
      actions: "manual-only",
    },
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    stage: "analysis-only",
    description: "当前只保留能力分析入口，不开放自动客服执行。",
    automationStatus: "analysis-only",
    capabilities: {
      inbox: "analysis-only",
      commerce: "analysis-only",
      actions: "manual-only",
    },
  },
]);

const DEFAULT_SUPPORT_RULES = Object.freeze({
  enabled: false,
  pollIntervalMs: 45000,
  autoReplyLowRisk: true,
  autoRunTriage: true,
  requireHumanForHighRisk: true,
});

const DEFAULT_PLATFORM_SETTINGS = Object.freeze({
  connectionMode: "disconnected",
  automationEnabled: false,
  multiStoreModeConfirmed: false,
  narratorModeEnabled: false,
  bubbleModeEnabled: false,
  popupReminderEnabled: false,
  messageAutoPinEnabled: false,
  qianniuRestartConfirmed: false,
  shopId: "",
  storeLabel: "",
  shopAlias: "",
  storeProfiles: [],
});

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(typeof raw === "string" ? raw.replace(/^\uFEFF/, "") : raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function normalizeInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeStoreProfiles(value, existingProfiles = []) {
  const source = Array.isArray(value) ? value : Array.isArray(existingProfiles) ? existingProfiles : [];
  return source
    .map((entry, index) => {
      if (!isPlainObject(entry)) {
        return null;
      }
      const storeId =
        normalizeString(entry.storeId || entry.id) ||
        normalizeString(entry.storeLabel || entry.shopAlias, `store-${index + 1}`);
      if (!storeId) {
        return null;
      }
      return {
        storeId,
        storeLabel: normalizeString(entry.storeLabel, storeId),
        shopAlias: normalizeString(entry.shopAlias),
        enabled: entry.enabled !== false,
      };
    })
    .filter(Boolean);
}

function listPlatformDefinitions() {
  return SUPPORT_PLATFORM_DEFINITIONS.map((entry) => ({ ...entry }));
}

function findPlatformDefinition(platformId) {
  const normalizedId = normalizeString(platformId).toLowerCase();
  return listPlatformDefinitions().find((entry) => entry.id === normalizedId) ?? null;
}

function readPlatformStore() {
  const parsed = readJsonFile(LOCAL_SUPPORT_PLATFORMS_PATH, { version: 1, items: {} });
  return isPlainObject(parsed) ? parsed : { version: 1, items: {} };
}

function writePlatformStore(store) {
  writeJsonFile(LOCAL_SUPPORT_PLATFORMS_PATH, store);
}

function readThreadStore() {
  const parsed = readJsonFile(LOCAL_SUPPORT_THREADS_PATH, { version: 1, items: [] });
  const items = Array.isArray(parsed?.items) ? parsed.items.filter((entry) => isPlainObject(entry)) : [];
  return { version: 1, items };
}

function writeThreadStore(store) {
  writeJsonFile(LOCAL_SUPPORT_THREADS_PATH, store);
}

function pruneLegacyTaobaoDemoThreads() {
  const store = readThreadStore();
  const nextItems = store.items.filter((entry) => {
    const platformId = normalizeString(entry?.platform).toLowerCase();
    if (platformId !== "taobao") {
      return true;
    }
    return normalizeString(entry?.source) === "qianniu-ax";
  });
  if (nextItems.length !== store.items.length) {
    writeThreadStore({
      version: 1,
      items: nextItems,
    });
  }
}

function readAuditStore() {
  const parsed = readJsonFile(LOCAL_SUPPORT_AUDIT_PATH, { version: 1, items: [] });
  const items = Array.isArray(parsed?.items) ? parsed.items.filter((entry) => isPlainObject(entry)) : [];
  return { version: 1, items };
}

function writeAuditStore(store) {
  writeJsonFile(LOCAL_SUPPORT_AUDIT_PATH, store);
}

function readRulesStore() {
  const parsed = readJsonFile(LOCAL_SUPPORT_RULES_PATH, DEFAULT_SUPPORT_RULES);
  return {
    ...DEFAULT_SUPPORT_RULES,
    ...(isPlainObject(parsed) ? parsed : {}),
    pollIntervalMs: normalizeInteger(parsed?.pollIntervalMs, DEFAULT_SUPPORT_RULES.pollIntervalMs),
  };
}

function writeRulesStore(rules) {
  writeJsonFile(LOCAL_SUPPORT_RULES_PATH, rules);
}

function normalizePlatformSettings(rawSettings = {}, existingSettings = null) {
  const source = isPlainObject(rawSettings) ? rawSettings : {};
  const existing = isPlainObject(existingSettings) ? existingSettings : {};
  return {
    connectionMode: normalizeString(source.connectionMode, existing.connectionMode || "disconnected"),
    automationEnabled:
      typeof source.automationEnabled === "boolean"
        ? source.automationEnabled
        : existing.automationEnabled === true,
    multiStoreModeConfirmed: normalizeBoolean(
      source.multiStoreModeConfirmed,
      existing.multiStoreModeConfirmed === true,
    ),
    narratorModeEnabled: normalizeBoolean(
      source.narratorModeEnabled,
      existing.narratorModeEnabled === true,
    ),
    bubbleModeEnabled: normalizeBoolean(
      source.bubbleModeEnabled,
      existing.bubbleModeEnabled === true,
    ),
    popupReminderEnabled: normalizeBoolean(
      source.popupReminderEnabled,
      existing.popupReminderEnabled === true,
    ),
    messageAutoPinEnabled: normalizeBoolean(
      source.messageAutoPinEnabled,
      existing.messageAutoPinEnabled === true,
    ),
    qianniuRestartConfirmed: normalizeBoolean(
      source.qianniuRestartConfirmed,
      existing.qianniuRestartConfirmed === true,
    ),
    shopId: normalizeString(source.shopId, existing.shopId || ""),
    storeLabel: normalizeString(source.storeLabel, existing.storeLabel || ""),
    shopAlias: normalizeString(source.shopAlias, existing.shopAlias || ""),
    storeProfiles: normalizeStoreProfiles(source.storeProfiles, existing.storeProfiles),
  };
}

function sanitizePlatformSettings(settings) {
  const normalized = isPlainObject(settings) ? settings : {};
  return {
    connectionMode: normalizeString(normalized.connectionMode, "disconnected"),
    automationEnabled: normalized.automationEnabled === true,
    multiStoreModeConfirmed: normalized.multiStoreModeConfirmed === true,
    narratorModeEnabled: normalized.narratorModeEnabled === true,
    bubbleModeEnabled: normalized.bubbleModeEnabled === true,
    popupReminderEnabled: normalized.popupReminderEnabled === true,
    messageAutoPinEnabled: normalized.messageAutoPinEnabled === true,
    qianniuRestartConfirmed: normalized.qianniuRestartConfirmed === true,
    shopId: normalizeString(normalized.shopId),
    storeLabel: normalizeString(normalized.storeLabel),
    shopAlias: normalizeString(normalized.shopAlias),
    storeProfiles: normalizeStoreProfiles(normalized.storeProfiles),
  };
}

function isTaobaoDesktopMode(settings) {
  return normalizeString(settings?.connectionMode).toLowerCase() === TAOBAO_DESKTOP_CONNECTION_MODE;
}

function resolveStoreProfiles(settings) {
  const sanitized = sanitizePlatformSettings(settings);
  if (sanitized.storeProfiles.length > 0) {
    return sanitized.storeProfiles;
  }
  if (sanitized.shopId || sanitized.storeLabel || sanitized.shopAlias) {
    return [
      {
        storeId: sanitized.shopId || sanitized.storeLabel || sanitized.shopAlias || "qianniu-store",
        storeLabel: sanitized.storeLabel || sanitized.shopId || "千牛店铺",
        shopAlias: sanitized.shopAlias,
        enabled: true,
      },
    ];
  }
  return [];
}

function buildSupportSetupChecklist(settings, helperStatus = null) {
  const sanitized = sanitizePlatformSettings(settings);
  return {
    qianniuInstalled:
      helperStatus?.qianniuInstalled === true ||
      (process.platform === "darwin" && fs.existsSync(QIANNIU_APP_PATH)),
    qianniuRunning: helperStatus?.qianniuRunning === true,
    multiStoreModeConfirmed: sanitized.multiStoreModeConfirmed === true,
    narratorModeEnabled: sanitized.narratorModeEnabled === true,
    bubbleModeEnabled: sanitized.bubbleModeEnabled === true,
    popupReminderEnabled: sanitized.popupReminderEnabled === true,
    messageAutoPinEnabled: sanitized.messageAutoPinEnabled === true,
    xiaolanbuAccessibilityGranted: helperStatus?.accessibilityGranted === true,
    qianniuRestartConfirmed: sanitized.qianniuRestartConfirmed === true,
    storeBound: resolveStoreProfiles(settings).length > 0,
  };
}

function buildTaobaoSetupStatus(record, helperStatus = null) {
  const settings = isPlainObject(record?.settings) ? record.settings : {};
  const sanitized = sanitizePlatformSettings(settings);
  const checklist = buildSupportSetupChecklist(settings, helperStatus);
  let blockingReason = "";
  if (helperStatus?.helperAvailable === false) {
    blockingReason = helperStatus.error || "千牛辅助控制 helper 不可用。";
  } else if (!checklist.qianniuInstalled) {
    blockingReason = "未检测到千牛桌面版，请先安装并打开 Aliworkbench。";
  } else if (!checklist.xiaolanbuAccessibilityGranted) {
    blockingReason = "请先给小懒布开启 macOS 辅助功能权限。";
  } else if (!checklist.qianniuRunning) {
    blockingReason = "请先启动千牛客户端，并保持窗口可见。";
  } else if (!checklist.multiStoreModeConfirmed) {
    blockingReason = "请先确认千牛已使用多店铺模式登录。";
  } else if (!checklist.narratorModeEnabled) {
    blockingReason = "请先在千牛设置里打开讲述人模式。";
  } else if (!checklist.bubbleModeEnabled) {
    blockingReason = "请先在千牛设置里打开气泡模式。";
  } else if (!checklist.popupReminderEnabled) {
    blockingReason = "请先在千牛设置里打开弹窗提醒。";
  } else if (!checklist.messageAutoPinEnabled) {
    blockingReason = "请先在千牛设置里打开消息自动置顶。";
  } else if (!checklist.qianniuRestartConfirmed) {
    blockingReason = "请先重启千牛，让以上设置真正生效。";
  } else if (!checklist.storeBound) {
    blockingReason = "请先绑定要托管的千牛店铺。";
  }
  return {
    platform: "taobao",
    helperAvailable: helperStatus?.helperAvailable !== false,
    accessibilityGranted: checklist.xiaolanbuAccessibilityGranted,
    qianniuInstalled: checklist.qianniuInstalled,
    qianniuRunning: checklist.qianniuRunning,
    checklist,
    storeProfiles: resolveStoreProfiles(settings),
    blockingReason,
    app: helperStatus?.app || null,
    windowTitles: Array.isArray(helperStatus?.windowTitles) ? helperStatus.windowTitles : [],
    status:
      blockingReason
        ? "setup-required"
        : sanitized.automationEnabled
          ? "monitoring"
          : "connected",
    connectionMode: TAOBAO_DESKTOP_CONNECTION_MODE,
    updatedAt: nowIso(),
  };
}

function buildDefaultPlatformRecord(definition) {
  const initialSettings = normalizePlatformSettings(
    definition.id === "taobao"
      ? {
          ...DEFAULT_PLATFORM_SETTINGS,
          connectionMode: TAOBAO_DESKTOP_CONNECTION_MODE,
        }
      : DEFAULT_PLATFORM_SETTINGS,
    null,
  );
  return {
    id: definition.id,
    label: definition.label,
    stage: definition.stage,
    description: definition.description,
    automationStatus: definition.automationStatus,
    capabilities: { ...definition.capabilities },
    status:
      definition.id === "taobao"
        ? "setup-required"
        : definition.automationStatus === "analysis-only"
          ? "analysis-only"
          : "coming-soon",
    lastSyncAt: "",
    lastError: "",
    updatedAt: "",
    settings: initialSettings,
  };
}

function normalizePlatformRecord(definition, existing) {
  const base = buildDefaultPlatformRecord(definition);
  const raw = isPlainObject(existing) ? existing : {};
  const rawSettings = isPlainObject(raw.settings) ? raw.settings : {};
  const normalizedSettings =
    definition.id === "taobao"
      ? normalizePlatformSettings(
          {
            ...rawSettings,
            connectionMode: TAOBAO_DESKTOP_CONNECTION_MODE,
          },
          {
            ...base.settings,
            ...rawSettings,
          },
        )
      : normalizePlatformSettings(rawSettings, rawSettings);
  return {
    ...base,
    ...raw,
    label: base.label,
    stage: base.stage,
    description: base.description,
    automationStatus: base.automationStatus,
    capabilities: { ...base.capabilities },
    status:
      definition.id === "taobao"
        ? normalizeString(raw.status, "setup-required")
        : base.status,
    settings: normalizedSettings,
  };
}

function ensurePlatformRecord(platformId) {
  const definition = findPlatformDefinition(platformId);
  if (!definition) {
    return null;
  }
  const store = readPlatformStore();
  const existing = isPlainObject(store.items?.[definition.id]) ? store.items[definition.id] : null;
  return existing ? normalizePlatformRecord(definition, existing) : buildDefaultPlatformRecord(definition);
}

function withUpdatedPlatformRecord(platformId, updater) {
  const record = ensurePlatformRecord(platformId);
  if (!record) {
    return null;
  }
  const store = readPlatformStore();
  const rawCurrent = isPlainObject(store.items?.[platformId]) ? store.items[platformId] : record;
  const nextRecord =
    typeof updater === "function"
      ? updater(record, store, rawCurrent)
      : { ...record, ...(isPlainObject(updater) ? updater : {}) };
  store.items = {
    ...(isPlainObject(store.items) ? store.items : {}),
    [platformId]: nextRecord,
  };
  writePlatformStore(store);
  return nextRecord;
}

function normalizeHistoryItem(value, fallbackRole = "buyer") {
  const source = isPlainObject(value) ? value : {};
  const text = normalizeString(source.text || source.message || source.content);
  if (!text) {
    return null;
  }
  return {
    role: normalizeString(source.role, fallbackRole),
    text,
    timestamp: normalizeString(source.timestamp, nowIso()),
  };
}

function normalizeSupportThread(platformId, value, existing) {
  const source = isPlainObject(value) ? value : {};
  const prior = isPlainObject(existing) ? existing : {};
  const threadId =
    normalizeString(source.threadId || source.id || source.sessionId || source.conversationId) ||
    normalizeString(prior.threadId);
  if (!threadId) {
    return null;
  }
  const history = Array.isArray(source.history)
    ? source.history.map((entry) => normalizeHistoryItem(entry)).filter(Boolean)
    : Array.isArray(prior.history)
      ? prior.history
      : [];
  const attentionState =
    typeof source.attentionState === "string"
      ? normalizeString(source.attentionState)
      : normalizeString(prior.attentionState);
  const lastAlertAt =
    typeof source.lastAlertAt === "string"
      ? normalizeString(source.lastAlertAt)
      : normalizeString(prior.lastAlertAt);
  return {
    id: `${platformId}:${threadId}`,
    platform: platformId,
    threadId,
    buyerId: normalizeString(source.buyerId, prior.buyerId || ""),
    buyerName: normalizeString(source.buyerName, prior.buyerName || ""),
    latestMessage:
      normalizeString(source.latestMessage || source.message || source.latestText) ||
      normalizeString(history[history.length - 1]?.text) ||
      normalizeString(prior.latestMessage),
    history,
    orderRefs: Array.isArray(source.orderRefs)
      ? source.orderRefs.map((entry) => normalizeString(entry)).filter(Boolean)
      : Array.isArray(prior.orderRefs)
        ? prior.orderRefs
        : [],
    status: normalizeString(source.status, prior.status || "open"),
    riskLevel: normalizeString(source.riskLevel, prior.riskLevel || ""),
    lastDecisionAt: normalizeString(source.lastDecisionAt, prior.lastDecisionAt || ""),
    lastAutoReplyAt: normalizeString(source.lastAutoReplyAt, prior.lastAutoReplyAt || ""),
    createdAt: normalizeString(source.createdAt, prior.createdAt || nowIso()),
    updatedAt: normalizeString(source.updatedAt, nowIso()),
    source: normalizeString(source.source, prior.source || "qianniu-ax"),
    attentionState,
    lastAlertAt,
    decision: isPlainObject(source.decision)
      ? source.decision
      : isPlainObject(prior.decision)
        ? prior.decision
        : null,
    context: isPlainObject(source.context)
      ? source.context
      : isPlainObject(prior.context)
        ? prior.context
        : null,
    requestedActions: Array.isArray(source.requestedActions)
      ? source.requestedActions.filter((entry) => isPlainObject(entry))
      : Array.isArray(prior.requestedActions)
        ? prior.requestedActions
        : [],
    replyLog: Array.isArray(prior.replyLog) ? prior.replyLog : [],
  };
}

function normalizeThreadIdentity(value) {
  return normalizeString(value).toLowerCase();
}

function isReminderThreadMatch(thread, reminderThread) {
  const reminderCandidates = [
    reminderThread?.threadId,
    reminderThread?.buyerName,
    reminderThread?.buyerId,
  ]
    .map((entry) => normalizeThreadIdentity(entry))
    .filter(Boolean);
  if (reminderCandidates.length === 0) {
    return false;
  }
  const threadCandidates = [
    thread?.threadId,
    thread?.buyerName,
    thread?.buyerId,
  ]
    .map((entry) => normalizeThreadIdentity(entry))
    .filter(Boolean);
  return threadCandidates.some((entry) => reminderCandidates.includes(entry));
}

function buildTaobaoDerivedThreadsFromInspect(inspect) {
  const reminderThread = isPlainObject(inspect?.reminderThread) ? inspect.reminderThread : null;
  const alertTimestamp = reminderThread ? nowIso() : "";
  return (Array.isArray(inspect?.derivedThreads) ? inspect.derivedThreads : []).map((entry) => ({
    ...entry,
    source: "qianniu-ax",
    attentionState: reminderThread && isReminderThreadMatch(entry, reminderThread) ? "popup" : "",
    lastAlertAt: reminderThread && isReminderThreadMatch(entry, reminderThread) ? alertTimestamp : "",
  }));
}

function listThreadsForPlatform(platformId) {
  pruneLegacyTaobaoDemoThreads();
  const normalizedPlatformId = normalizeString(platformId).toLowerCase();
  return readThreadStore()
    .items.filter((entry) => normalizeString(entry.platform).toLowerCase() === normalizedPlatformId)
    .sort((left, right) => {
      const leftPopup = normalizeString(left.attentionState).toLowerCase() === "popup" ? 1 : 0;
      const rightPopup = normalizeString(right.attentionState).toLowerCase() === "popup" ? 1 : 0;
      if (leftPopup !== rightPopup) {
        return rightPopup - leftPopup;
      }
      const rightAlertAt = Date.parse(right.lastAlertAt || 0) || 0;
      const leftAlertAt = Date.parse(left.lastAlertAt || 0) || 0;
      if (leftAlertAt !== rightAlertAt) {
        return rightAlertAt - leftAlertAt;
      }
      return (Date.parse(right.updatedAt || right.createdAt || 0) || 0) - (Date.parse(left.updatedAt || left.createdAt || 0) || 0);
    });
}

function upsertThreads(platformId, threads) {
  const store = readThreadStore();
  const existingByThreadId = new Map(
    store.items
      .filter((entry) => normalizeString(entry.platform).toLowerCase() === normalizeString(platformId).toLowerCase())
      .map((entry) => [normalizeString(entry.threadId), entry]),
  );
  const nextThreads = (Array.isArray(threads) ? threads : [])
    .map((entry) =>
      normalizeSupportThread(
        platformId,
        entry,
        existingByThreadId.get(normalizeString(entry?.threadId || entry?.id)),
      ),
    )
    .filter(Boolean);
  const others = store.items.filter(
    (entry) => normalizeString(entry.platform).toLowerCase() !== normalizeString(platformId).toLowerCase(),
  );
  writeThreadStore({
    version: 1,
    items: [...others, ...nextThreads],
  });
  return nextThreads;
}

function updateThread(platformId, threadId, updater) {
  const store = readThreadStore();
  let updatedThread = null;
  const nextItems = store.items.map((entry) => {
    if (
      normalizeString(entry.platform).toLowerCase() !== normalizeString(platformId).toLowerCase() ||
      normalizeString(entry.threadId) !== normalizeString(threadId)
    ) {
      return entry;
    }
    const nextValue = typeof updater === "function" ? updater(entry) : entry;
    updatedThread = normalizeSupportThread(platformId, nextValue, entry);
    return updatedThread || entry;
  });
  writeThreadStore({ version: 1, items: nextItems });
  return updatedThread;
}

function getThreadById(platformId, threadId) {
  return (
    readThreadStore().items.find(
      (entry) =>
        normalizeString(entry.platform).toLowerCase() === normalizeString(platformId).toLowerCase() &&
        normalizeString(entry.threadId) === normalizeString(threadId),
    ) ?? null
  );
}

function appendAuditRecord(record) {
  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: nowIso(),
    ...record,
  };
  const store = readAuditStore();
  const items = [entry, ...store.items].slice(0, 500);
  writeAuditStore({ version: 1, items });
  return entry;
}

function listSupportAudit(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const limit = normalizeInteger(payload.limit, 100);
  const items = readAuditStore().items.filter((entry) => {
    if (!platformId) {
      return true;
    }
    return normalizeString(entry.platform).toLowerCase() === platformId;
  });
  return {
    ok: true,
    items: items.slice(0, limit),
  };
}

function summarizeThreadCounts(platformId) {
  const record = ensurePlatformRecord(platformId);
  const threads = listThreadsForPlatform(platformId).filter((entry) =>
    record?.id === "taobao" ? normalizeString(entry.source) === "qianniu-ax" : false,
  );
  return {
    queueCount: threads.filter((entry) => entry.status === "open" || entry.status === "triaged").length,
    pendingApprovalCount: threads.filter((entry) => entry.status === "awaiting-human").length,
    repliedCount: threads.filter((entry) => entry.status === "replied").length,
  };
}

function buildPublicPlatformRecord(record) {
  const definition = findPlatformDefinition(record.id);
  const settings = sanitizePlatformSettings(record.settings);
  const counts = summarizeThreadCounts(record.id);
  const storeProfiles = resolveStoreProfiles(record.settings);
  return {
    id: record.id,
    label: record.label,
    stage: record.stage,
    description: record.description,
    automationStatus: record.automationStatus,
    capabilities:
      record.id === "taobao"
        ? {
            ...(definition?.capabilities ?? {}),
            inbox: "configured",
            reply: "configured",
            commerce: "desktop-context",
          }
        : {
            ...(definition?.capabilities ?? {}),
            reply: "not-available",
          },
    status: record.status,
    lastSyncAt: record.lastSyncAt || "",
    lastError: record.lastError || "",
    updatedAt: record.updatedAt || "",
    queueCount: counts.queueCount,
    pendingApprovalCount: counts.pendingApprovalCount,
    repliedCount: counts.repliedCount,
    storeProfiles,
    settings,
  };
}

function listSupportPlatforms() {
  const store = readPlatformStore();
  const items = {};
  for (const definition of SUPPORT_PLATFORM_DEFINITIONS) {
    const existing = isPlainObject(store.items?.[definition.id]) ? store.items[definition.id] : null;
    items[definition.id] = existing
      ? normalizePlatformRecord(definition, existing)
      : buildDefaultPlatformRecord(definition);
  }
  if (JSON.stringify(store.items || {}) !== JSON.stringify(items)) {
    writePlatformStore({ version: 1, items });
  }
  return {
    ok: true,
    items: Object.values(items).map((entry) => buildPublicPlatformRecord(entry)),
    rules: readRulesStore(),
  };
}

function getSupportPlatformStatus(payload = {}) {
  const record = ensurePlatformRecord(payload.platform);
  if (!record) {
    return {
      ok: false,
      error: "unknown support platform",
    };
  }
  return {
    ok: true,
    platform: buildPublicPlatformRecord(record),
    rules: readRulesStore(),
  };
}

async function getSupportSetupStatus(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const record = ensurePlatformRecord(platformId);
  if (!record) {
    return {
      ok: false,
      error: "unknown support platform",
    };
  }
  if (platformId !== "taobao") {
    return {
      ok: true,
      setupStatus: {
        platform: platformId,
        helperAvailable: false,
        accessibilityGranted: false,
        qianniuInstalled: false,
        qianniuRunning: false,
        checklist: {},
        blockingReason: "",
        status: record.status,
      },
      platform: buildPublicPlatformRecord(record),
    };
  }
  const helperStatus = await getQianNiuHelperStatus();
  const setupStatus = buildTaobaoSetupStatus(record, helperStatus);
  const nextRecord = withUpdatedPlatformRecord(platformId, (current) => ({
    ...current,
    status: setupStatus.status,
    lastError: setupStatus.blockingReason || "",
    updatedAt: nowIso(),
  }));
  return {
    ok: true,
    setupStatus,
    platform: buildPublicPlatformRecord(nextRecord || record),
  };
}

async function requestSupportAccessibility(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  if (platformId !== "taobao") {
    return {
      ok: false,
      error: "accessibility request is only available for taobao on macOS",
    };
  }
  const helper = await requestQianNiuAccessibility();
  const statusResult = await getSupportSetupStatus({ platform: platformId });
  appendAuditRecord({
    platform: platformId,
    type: "setup-accessibility",
    outcome: helper?.ok ? "requested" : "failed",
    title: helper?.ok ? "已请求辅助功能权限" : "辅助功能权限请求失败",
    detail: helper?.error || "已尝试打开系统辅助功能设置页。",
  });
  return {
    ok: helper?.ok !== false,
    helper,
    ...statusResult,
  };
}

function confirmSupportSetupStep(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const step = normalizeString(payload.step);
  if (platformId !== "taobao" || !TAOBAO_SETUP_STEP_FIELDS.includes(step)) {
    return {
      ok: false,
      error: "unknown support setup step",
    };
  }
  const value = payload.value !== false;
  const nextRecord = withUpdatedPlatformRecord(platformId, (current, _store, rawCurrent) => ({
    ...current,
    settings: normalizePlatformSettings(
      { [step]: value },
      rawCurrent?.settings || current.settings,
    ),
    updatedAt: nowIso(),
  }));
  return {
    ok: true,
    platform: buildPublicPlatformRecord(nextRecord || ensurePlatformRecord(platformId)),
  };
}

function bindSupportStore(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  if (platformId !== "taobao") {
    return {
      ok: false,
      error: "store binding is only available for taobao v1",
    };
  }
  const storeId =
    normalizeString(payload.storeId) ||
    normalizeString(payload.storeLabel) ||
    normalizeString(payload.shopAlias);
  if (!storeId) {
    return {
      ok: false,
      error: "missing store identity",
    };
  }
  const nextRecord = withUpdatedPlatformRecord(platformId, (current, _store, rawCurrent) => {
    const existingProfiles = resolveStoreProfiles(rawCurrent?.settings || current.settings);
    const storeProfiles = [
      {
        storeId,
        storeLabel: normalizeString(payload.storeLabel, storeId),
        shopAlias: normalizeString(payload.shopAlias),
        enabled: payload.enabled !== false,
      },
      ...existingProfiles.filter((entry) => normalizeString(entry.storeId) !== storeId),
    ];
    return {
      ...current,
      settings: normalizePlatformSettings(
        {
          shopId: storeId,
          storeLabel: normalizeString(payload.storeLabel, storeId),
          shopAlias: normalizeString(payload.shopAlias),
          storeProfiles,
        },
        rawCurrent?.settings || current.settings,
      ),
      updatedAt: nowIso(),
    };
  });
  appendAuditRecord({
    platform: platformId,
    type: "bind-store",
    outcome: "succeeded",
    title: "千牛店铺已绑定",
    detail: normalizeString(payload.storeLabel, storeId),
  });
  return {
    ok: true,
    platform: buildPublicPlatformRecord(nextRecord || ensurePlatformRecord(platformId)),
  };
}

async function inspectSupportUI(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  if (platformId !== "taobao") {
    return {
      ok: false,
      error: "ui inspect is only available for taobao v1",
    };
  }
  const record = ensurePlatformRecord(platformId);
  if (!record) {
    return {
      ok: false,
      error: "unknown support platform",
    };
  }
  const inspect = await inspectQianNiuUi();
  if (!inspect?.ok) {
    appendAuditRecord({
      platform: platformId,
      type: "ui-inspect",
      outcome: "failed",
      title: "千牛 UI 检测失败",
      detail: inspect?.error || "inspect failed",
    });
    return inspect;
  }
  if (inspect.accessibilityGranted !== true) {
    return {
      ok: false,
      error: "请先给小懒布开启 macOS 辅助功能权限。",
      platform: buildPublicPlatformRecord(record),
      inspect,
      currentThread: null,
      items: [],
    };
  }
  if (inspect.qianniuRunning !== true) {
    return {
      ok: false,
      error: "请先启动千牛客户端，再执行界面检测。",
      platform: buildPublicPlatformRecord(record),
      inspect,
      currentThread: null,
      items: [],
    };
  }
  const selectedThreadId = normalizeString(payload.threadId);
  const existingThread = selectedThreadId ? getThreadById(platformId, selectedThreadId) : null;
  const fallbackCurrentThread = deriveQianNiuCurrentThread(inspect, existingThread);
  let currentThread = fallbackCurrentThread;
  const threadLabel =
    normalizeString(existingThread?.threadId) ||
    normalizeString(existingThread?.buyerName) ||
    normalizeString(fallbackCurrentThread?.buyerName) ||
    normalizeString(fallbackCurrentThread?.threadId) ||
    normalizeString(fallbackCurrentThread?.buyerId);
  if (threadLabel) {
    const readResult = await readQianNiuThread({
      threadTitle: threadLabel,
      existingThread: existingThread || fallbackCurrentThread,
    });
    if (readResult?.ok && readResult.thread) {
      currentThread = readResult.thread;
    }
  }
  appendAuditRecord({
    platform: platformId,
    type: "ui-inspect",
    outcome: "succeeded",
    title: "千牛 UI 检测完成",
    detail: `识别到 ${String(Array.isArray(inspect.derivedThreads) ? inspect.derivedThreads.length : 0)} 个会话入口。`,
  });
  return {
    ok: true,
    platform: buildPublicPlatformRecord(record),
    inspect,
    currentThread,
    reminderThread: inspect?.reminderThread || null,
    items: buildTaobaoDerivedThreadsFromInspect(inspect),
  };
}

async function startSupportPlatformMonitor(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const statusResult = await getSupportSetupStatus({ platform: platformId });
  if (!statusResult?.ok) {
    return statusResult;
  }
  if (statusResult.setupStatus?.blockingReason) {
    return {
      ...statusResult,
      ok: false,
      error: statusResult.setupStatus.blockingReason,
    };
  }
  const nextRecord = withUpdatedPlatformRecord(platformId, (current, _store, rawCurrent) => ({
    ...current,
    status: "monitoring",
    lastError: "",
    settings: normalizePlatformSettings(
      {
        connectionMode: TAOBAO_DESKTOP_CONNECTION_MODE,
        automationEnabled: true,
      },
      rawCurrent?.settings || current.settings,
    ),
    updatedAt: nowIso(),
  }));
  appendAuditRecord({
    platform: platformId,
    type: "monitor-start",
    outcome: "succeeded",
    title: "千牛监听已启动",
    detail: "桌面端已开始监听千牛会话变化。",
  });
  return {
    ok: true,
    platform: buildPublicPlatformRecord(nextRecord || ensurePlatformRecord(platformId)),
    setupStatus: statusResult.setupStatus,
  };
}

function stopSupportPlatformMonitor(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const nextRecord = withUpdatedPlatformRecord(platformId, (current, _store, rawCurrent) => ({
    ...current,
    status: platformId === "taobao" ? "connected" : current.status,
    settings: normalizePlatformSettings(
      {
        automationEnabled: false,
      },
      rawCurrent?.settings || current.settings,
    ),
    updatedAt: nowIso(),
  }));
  appendAuditRecord({
    platform: platformId,
    type: "monitor-stop",
    outcome: "succeeded",
    title: "千牛监听已暂停",
    detail: "平台自动化已停止，不再自动轮询与发回复。",
  });
  return {
    ok: true,
    platform: buildPublicPlatformRecord(nextRecord || ensurePlatformRecord(platformId)),
  };
}

async function pullSupportInbox(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  pruneLegacyTaobaoDemoThreads();
  const record = ensurePlatformRecord(platformId);
  if (!record) {
    return { ok: false, error: "unknown support platform" };
  }
  if (platformId !== "taobao") {
    return {
      ok: true,
      platform: buildPublicPlatformRecord(record),
      items: [],
      cursor: "",
    };
  }
  try {
    const setupStatus = buildTaobaoSetupStatus(record, await getQianNiuHelperStatus());
    if (setupStatus.blockingReason) {
      throw new Error(setupStatus.blockingReason);
    }
    const inspect = await inspectQianNiuUi();
    if (!inspect?.ok) {
      throw new Error(inspect?.error || "无法读取千牛桌面会话列表。");
    }
    const threads = upsertThreads(platformId, buildTaobaoDerivedThreadsFromInspect(inspect));
    const nextRecord = withUpdatedPlatformRecord(platformId, (current) => ({
      ...current,
      status: sanitizePlatformSettings(current.settings).automationEnabled ? "monitoring" : "connected",
      lastSyncAt: nowIso(),
      lastError: "",
      updatedAt: nowIso(),
    }));
    appendAuditRecord({
      platform: platformId,
      type: "inbox-pull",
      outcome: "succeeded",
      title: `${record.label} 已刷新消息队列`,
      detail: `拉取到 ${String(threads.length)} 条会话。`,
    });
    return {
      ok: true,
      platform: buildPublicPlatformRecord(nextRecord || record),
      items: threads,
      cursor: "",
    };
  } catch (error) {
    const nextRecord = withUpdatedPlatformRecord(platformId, (current) => ({
      ...current,
      status: "error",
      lastError: error instanceof Error ? error.message : "拉取消息失败",
      updatedAt: nowIso(),
    }));
    appendAuditRecord({
      platform: platformId,
      type: "inbox-pull",
      outcome: "failed",
      title: `${record.label} 拉取消息失败`,
      detail: error instanceof Error ? error.message : "拉取消息失败",
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : "拉取消息失败",
      items: [],
      platform: buildPublicPlatformRecord(nextRecord || record),
    };
  }
}

async function getSupportThread(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const threadId = normalizeString(payload.threadId);
  if (!platformId || !threadId) {
    return {
      ok: false,
      error: "missing support thread params",
    };
  }
  const record = ensurePlatformRecord(platformId);
  if (!record) {
    return { ok: false, error: "unknown support platform" };
  }
  let existing = getThreadById(platformId, threadId);
  if (!existing && platformId === "taobao") {
    const inspect = await inspectQianNiuUi();
    if (inspect?.ok && Array.isArray(inspect.derivedThreads) && inspect.derivedThreads.length > 0) {
      upsertThreads(platformId, buildTaobaoDerivedThreadsFromInspect(inspect));
      existing = getThreadById(platformId, threadId);
    }
  }
  if (!existing) {
    return { ok: false, error: "support thread not found" };
  }
  if (platformId !== "taobao") {
    return {
      ok: false,
      error: "当前平台暂未开放客服线程读取。",
      thread: existing,
      platform: buildPublicPlatformRecord(record),
    };
  }
  try {
    const threadLabel =
      normalizeString(existing.threadId) ||
      normalizeString(existing.buyerName) ||
      normalizeString(existing.buyerId);
    const readResult = await readQianNiuThread({
      threadTitle: threadLabel,
      existingThread: existing,
    });
    if (!readResult?.ok) {
      throw new Error(readResult?.error || "无法读取千牛当前会话。");
    }
    const nextThread = updateThread(platformId, threadId, (current) => ({
      ...current,
      ...readResult.thread,
      source: "qianniu-ax",
      updatedAt: nowIso(),
    }));
    return {
      ok: true,
      platform: buildPublicPlatformRecord(record),
      thread: nextThread || existing,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "读取客服会话失败",
      thread: existing,
      platform: buildPublicPlatformRecord(record),
    };
  }
}

function normalizeSupportDecision(value) {
  const source = isPlainObject(value) ? value : {};
  const normalizedActions = Array.isArray(source.requestedActions)
    ? source.requestedActions
        .map((entry) => {
          if (!isPlainObject(entry)) {
            return null;
          }
          const type = normalizeString(entry.type);
          if (!type) {
            return null;
          }
          return {
            type,
            reason: normalizeString(entry.reason),
            payload: isPlainObject(entry.payload) ? entry.payload : {},
          };
        })
        .filter(Boolean)
    : [];
  const normalizedRisk = normalizeString(source.riskLevel, "medium").toLowerCase();
  const riskLevel =
    normalizedRisk === "low" || normalizedRisk === "medium" || normalizedRisk === "high"
      ? normalizedRisk
      : "medium";
  const normalizedAction = normalizeString(source.nextAction, riskLevel === "low" ? "auto-reply" : "human-review").toLowerCase();
  const nextAction =
    normalizedAction === "auto-reply" ||
    normalizedAction === "needs-context" ||
    normalizedAction === "human-review" ||
    normalizedAction === "blocked"
      ? normalizedAction
      : riskLevel === "low"
        ? "auto-reply"
        : "human-review";
  return {
    intent: normalizeString(source.intent, "unknown"),
    riskLevel,
    confidence:
      Number.isFinite(Number(source.confidence)) && Number(source.confidence) >= 0
        ? Math.min(1, Math.max(0, Number(source.confidence)))
        : 0.5,
    nextAction,
    replyDraft: normalizeString(source.replyDraft),
    humanReason: normalizeString(source.humanReason),
    requestedActions: normalizedActions,
    productFacts: Array.isArray(source.productFacts)
      ? source.productFacts.map((entry) => normalizeString(entry)).filter(Boolean)
      : [],
    policyFacts: Array.isArray(source.policyFacts)
      ? source.policyFacts.map((entry) => normalizeString(entry)).filter(Boolean)
      : [],
    createdAt: nowIso(),
  };
}

function saveSupportDecision(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const threadId = normalizeString(payload.threadId);
  const decision = normalizeSupportDecision(payload.decision);
  if (!platformId || !threadId) {
    return { ok: false, error: "missing support decision params" };
  }
  const nextThread = updateThread(platformId, threadId, (current) => ({
    ...current,
    decision,
    riskLevel: decision.riskLevel,
    status:
      decision.nextAction === "auto-reply" && decision.riskLevel === "low"
        ? "triaged"
        : decision.nextAction === "human-review" || decision.riskLevel === "high"
          ? "awaiting-human"
          : "triaged",
    lastDecisionAt: nowIso(),
    updatedAt: nowIso(),
    requestedActions: decision.requestedActions,
    context: {
      ...(isPlainObject(current.context) ? current.context : {}),
      productFacts: decision.productFacts,
      policyFacts: decision.policyFacts,
    },
  }));
  if (!nextThread) {
    return { ok: false, error: "support thread not found" };
  }
  appendAuditRecord({
    platform: platformId,
    threadId,
    type: "triage",
    outcome: "succeeded",
    title: `客服分诊已完成 · ${decision.intent}`,
    detail: `${decision.riskLevel} risk · ${decision.nextAction}`,
  });
  return {
    ok: true,
    thread: nextThread,
    decision,
  };
}

async function sendSupportReply(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const threadId = normalizeString(payload.threadId);
  const message = normalizeString(payload.message);
  if (!platformId || !threadId || !message) {
    return { ok: false, error: "missing support reply params" };
  }
  const record = ensurePlatformRecord(platformId);
  if (!record) {
    return { ok: false, error: "unknown support platform" };
  }
  if (platformId !== "taobao") {
    return {
      ok: false,
      error: "当前平台暂未开放自动回复发送。",
    };
  }
  try {
    const thread = getThreadById(platformId, threadId);
    const sendResult = await sendQianNiuReply({
      threadTitle:
        normalizeString(thread?.threadId) ||
        normalizeString(thread?.buyerName) ||
        normalizeString(thread?.buyerId),
      message,
    });
    if (!sendResult?.ok) {
      throw new Error(sendResult?.error || "千牛桌面回复发送失败。");
    }
    const nextThread = updateThread(platformId, threadId, (current) => ({
      ...current,
      status: "replied",
      lastAutoReplyAt: payload.automated === true ? nowIso() : current.lastAutoReplyAt || "",
      attentionState: "",
      lastAlertAt: current.lastAlertAt || "",
      updatedAt: nowIso(),
      replyLog: [
        ...(Array.isArray(current.replyLog) ? current.replyLog : []),
        {
          id: `reply-${Date.now()}`,
          message,
          automated: payload.automated === true,
          createdAt: nowIso(),
        },
      ],
    }));
    appendAuditRecord({
      platform: platformId,
      threadId,
      type: "reply-send",
      outcome: "succeeded",
      title: payload.automated === true ? "自动回复已发送" : "人工批准回复已发送",
      detail: message,
    });
    return {
      ok: true,
      thread: nextThread,
    };
  } catch (error) {
    appendAuditRecord({
      platform: platformId,
      threadId,
      type: "reply-send",
      outcome: "failed",
      title: "发送回复失败",
      detail: error instanceof Error ? error.message : "发送回复失败",
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : "发送回复失败",
    };
  }
}

function requestSupportAction(payload = {}) {
  const platformId = normalizeString(payload.platform).toLowerCase();
  const threadId = normalizeString(payload.threadId);
  const type = normalizeString(payload.type || payload.actionType);
  if (!platformId || !threadId || !type) {
    return { ok: false, error: "missing support action params" };
  }
  const nextThread = updateThread(platformId, threadId, (current) => ({
    ...current,
    status: "awaiting-human",
    attentionState: "",
    updatedAt: nowIso(),
    requestedActions: [
      ...(Array.isArray(current.requestedActions) ? current.requestedActions : []),
      {
        type,
        reason: normalizeString(payload.reason),
        payload: isPlainObject(payload.payload) ? payload.payload : {},
        approvedAt: nowIso(),
      },
    ],
  }));
  if (!nextThread) {
    return { ok: false, error: "support thread not found" };
  }
  appendAuditRecord({
    platform: platformId,
    threadId,
    type: "action-request",
    outcome: "queued",
    title: type === "handoff" ? "会话已转人工" : `动作已登记 · ${type}`,
    detail: normalizeString(payload.reason, "等待人工处理"),
  });
  return {
    ok: true,
    thread: nextThread,
  };
}

function getSupportAutomationRules() {
  return {
    ok: true,
    rules: readRulesStore(),
  };
}

function setSupportAutomationRules(payload = {}) {
  const current = readRulesStore();
  const nextRules = {
    ...current,
    ...(isPlainObject(payload) ? payload : {}),
    enabled:
      typeof payload.enabled === "boolean" ? payload.enabled : current.enabled,
    autoReplyLowRisk:
      typeof payload.autoReplyLowRisk === "boolean"
        ? payload.autoReplyLowRisk
        : current.autoReplyLowRisk,
    autoRunTriage:
      typeof payload.autoRunTriage === "boolean" ? payload.autoRunTriage : current.autoRunTriage,
    requireHumanForHighRisk:
      typeof payload.requireHumanForHighRisk === "boolean"
        ? payload.requireHumanForHighRisk
        : current.requireHumanForHighRisk,
    pollIntervalMs: normalizeInteger(payload.pollIntervalMs, current.pollIntervalMs),
  };
  writeRulesStore(nextRules);
  appendAuditRecord({
    platform: normalizeString(payload.platform),
    type: "rules-update",
    outcome: "succeeded",
    title: "客服自动化规则已更新",
    detail: `enabled=${String(nextRules.enabled)} · autoReplyLowRisk=${String(
      nextRules.autoReplyLowRisk,
    )} · interval=${String(nextRules.pollIntervalMs)}ms`,
  });
  return {
    ok: true,
    rules: nextRules,
  };
}

module.exports = {
  DEFAULT_SUPPORT_RULES,
  LOCAL_SUPPORT_STATE_DIR,
  SUPPORT_PLATFORM_DEFINITIONS,
  bindSupportStore,
  confirmSupportSetupStep,
  getSupportAutomationRules,
  getSupportPlatformStatus,
  getSupportSetupStatus,
  getSupportThread,
  inspectSupportUI,
  listSupportAudit,
  listSupportPlatforms,
  pullSupportInbox,
  requestSupportAccessibility,
  requestSupportAction,
  saveSupportDecision,
  sendSupportReply,
  setSupportAutomationRules,
  startSupportPlatformMonitor,
  stopSupportPlatformMonitor,
};
