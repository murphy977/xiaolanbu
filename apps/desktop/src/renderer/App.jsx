import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import * as openclawChat from "./chat-core/openclaw-chat.js";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "https://api.xiaolanbu.com/v1").replace(
  /\/+$/,
  "",
);
const SESSION_STORAGE_KEY = "xiaolanbu_session";
const SSH_PASSWORD_STORAGE_KEY = "xiaolanbu_ssh_passwords";
const SSH_PORT_STORAGE_KEY = "xiaolanbu_ssh_ports";
const LOCAL_BOOTSTRAP_STORAGE_KEY = "xiaolanbu_local_bootstraps";
const LOCAL_CLEAR_KEY_ON_LOGOUT_STORAGE_KEY = "xiaolanbu_local_clear_key_on_logout";
const CHAT_SHOW_THINKING_STORAGE_KEY = "xiaolanbu_chat_show_thinking";
const CHAT_SESSION_SELECTION_STORAGE_KEY = "xiaolanbu_chat_session_selection_v1";
const LOCAL_RESPONSES_MODEL_ALIAS = "openclaw";

const VIEW_META = {
  home: {
    eyebrow: "Dashboard",
    title: "首页",
  },
  assistant: {
    eyebrow: "Assistant",
    title: "部署一旦就绪，就直接开始聊天。",
  },
  membership: {
    eyebrow: "Wallet & Billing",
    title: "让余额、用量和服务状态，像账号中心一样清晰而轻松。",
  },
  settings: {
    eyebrow: "Cloud Settings",
    title: "把云端接入和实例状态，整理成真正可控的产品设置。",
  },
};

const NAV_ITEMS = [
  {
    key: "home",
    label: "首页",
    sub: "今天的动态与快速开始",
    icon: "◐",
  },
  {
    key: "assistant",
    label: "小懒布",
    sub: "像聊天一样下达任务",
    icon: "✦",
  },
  {
    key: "membership",
    label: "账单",
    sub: "查看余额、用量与充值",
    icon: "◆",
  },
  {
    key: "settings",
    label: "设置",
    sub: "实例、网关与接入状态",
    icon: "⋯",
  },
];

const QUICK_TOPUPS = [20, 50, 100, 300];
const DEFAULT_DEPLOYMENT_FORM = {
  name: "demo",
  password: "",
  region: "cn-hongkong",
  imageId: "m-j6cbwozw549vb1gv68lv",
  securityGroupId: "sg-j6cc6ew2bqki6ag3y1q4",
  vSwitchId: "vsw-j6cispsiaf2g219a6isht",
  internetMaxBandwidthOut: "5",
  instanceTypes: ["ecs.n1.small", "ecs.n4.small", "ecs.t5-lc1m2.small"],
  modelId: "gpt-5.2",
};
const DEFAULT_LOCAL_DEPLOYMENT_FORM = {
  name: "我的本地助手",
  modelId: "gpt-5.2",
};
const FALLBACK_GATEWAY_MODEL_CATALOG = [
  {
    id: "gpt-5.2",
    label: "OpenAI / gpt-5.2",
    isDefault: true,
    providerId: "openai",
    profileId: "aportal",
  },
  {
    id: "gpt-5.4",
    label: "OpenAI / gpt-5.4",
    isDefault: false,
    providerId: "openai",
    profileId: "aportal",
  },
  {
    id: "gpt-4o",
    label: "OpenAI / gpt-4o",
    isDefault: false,
    providerId: "openai",
    profileId: "aportal",
  },
  {
    id: "qwen35-plus",
    label: "Qwen / qwen35-plus",
    isDefault: false,
    providerId: "openai",
    profileId: "qwen",
  },
];
const CLOUD_TUNNEL_DASHBOARD_PORT = 28789;
const CLOUD_TUNNEL_BROWSER_CONTROL_PORT = 28791;
const BULK_REFRESH_NATIVE_RESPONSES_ACTION_ID = "__bulk_refresh_native_responses__";
const THREAD_AUTO_SCROLL_THRESHOLD_PX = 64;
const SUPPORTED_CHAT_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const CHAT_IMAGE_EXTENSION_TO_MIME = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);
const CHAT_IMAGE_ACCEPT = Array.from(SUPPORTED_CHAT_IMAGE_MIME_TYPES).join(",");
const assistantViewStateCache = new Map();
const CHAT_STALL_RECOVERY_IDLE_MS = 6000;
const CHAT_STALL_RECOVERY_POLL_MS = 2000;
const CHAT_STREAM_SMOOTH_INTERVAL_MS = 18;
const CHAT_STREAM_SMOOTH_MIN_STEP = 2;
const CHAT_STREAM_SMOOTH_MAX_STEP = 24;

function formatGatewayModelGroupName(item) {
  const profileId = typeof item?.profileId === "string" ? item.profileId.trim().toLowerCase() : "";
  const providerId = typeof item?.providerId === "string" ? item.providerId.trim().toLowerCase() : "";

  if (profileId === "qwen" || profileId.includes("dashscope") || profileId.includes("qwen")) {
    return "Qwen";
  }
  if (profileId === "aportal") {
    return "OpenAI";
  }
  if (providerId === "openai") {
    return "OpenAI";
  }

  return profileId || providerId || "Other";
}

function formatGatewayModelLabel(item) {
  const modelId = typeof item?.id === "string" ? item.id.trim() : "";
  const explicitLabel = typeof item?.label === "string" ? item.label.trim() : "";
  const groupName = formatGatewayModelGroupName(item);

  if (explicitLabel && explicitLabel.includes("/")) {
    return explicitLabel;
  }

  return `${groupName} / ${explicitLabel || modelId || "未命名模型"}`;
}

function resolveDeploymentGatewayModelId(deployment, fallbackModelId = "gpt-5.2") {
  const gatewayKey = deployment?.gatewayKey ?? {};
  const metadata = deployment?.metadata ?? {};

  return (
    (typeof gatewayKey.modelId === "string" && gatewayKey.modelId.trim()) ||
    (typeof metadata.modelId === "string" && metadata.modelId.trim()) ||
    fallbackModelId
  );
}

function resolveActiveGatewaySessionModelId(session) {
  if (!session || typeof session !== "object") {
    return "";
  }

  return (
    (typeof session.model === "string" && session.model.trim()) ||
    (typeof session.modelId === "string" && session.modelId.trim()) ||
    ""
  );
}

function findGatewayModelCatalogItem(items, modelId) {
  const normalizedModelId = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalizedModelId) {
    return null;
  }

  return (
    normalizeGatewayModelCatalog(items).find((item) => item.id === normalizedModelId) ?? null
  );
}

function normalizeGatewayModelCatalog(items) {
  const normalized = Array.isArray(items)
    ? items
        .filter((item) => item && typeof item === "object" && typeof item.id === "string")
        .map((item) => ({
          id: item.id.trim(),
          providerId:
            typeof item.providerId === "string" && item.providerId.trim()
              ? item.providerId.trim()
              : "openai",
          profileId:
            typeof item.profileId === "string" && item.profileId.trim()
              ? item.profileId.trim()
              : "default",
          upstreamModelId:
            typeof item.upstreamModelId === "string" && item.upstreamModelId.trim()
              ? item.upstreamModelId.trim()
              : item.id.trim(),
          baseUrl:
            typeof item.baseUrl === "string" && item.baseUrl.trim() ? item.baseUrl.trim() : "",
          isDefault: item.isDefault === true,
        }))
        .filter((item) => item.id)
        .map((item) => ({
          ...item,
          label: formatGatewayModelLabel(item),
        }))
    : [];

  if (!normalized.length) {
    return FALLBACK_GATEWAY_MODEL_CATALOG;
  }

  if (!normalized.some((item) => item.isDefault)) {
    normalized[0] = {
      ...normalized[0],
      isDefault: true,
    };
  }

  return normalized;
}

function resolveDefaultGatewayModelId(items) {
  return (
    normalizeGatewayModelCatalog(items).find((item) => item.isDefault)?.id ||
    normalizeGatewayModelCatalog(items)[0]?.id ||
    "gpt-5.2"
  );
}

function normalizeLocalBootstrapModelCandidate(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return "";
  }

  const lower = normalized.toLowerCase();
  if (lower === LOCAL_RESPONSES_MODEL_ALIAS) {
    return "";
  }
  if (lower === "qwen35-plus" || lower === "qwen3.5-plus") {
    return "qwen35-plus";
  }

  return normalized;
}

function cloneCachedAssistantState(state) {
  if (!state || typeof state !== "object") {
    return null;
  }

  return {
    sourceIdentity: typeof state.sourceIdentity === "string" ? state.sourceIdentity : "",
    requestId: typeof state.requestId === "string" ? state.requestId : "",
    terminalEventSeen: Boolean(state.terminalEventSeen),
    chatRunId: typeof state.chatRunId === "string" ? state.chatRunId : "",
    chatMessages: Array.isArray(state.chatMessages) ? [...state.chatMessages] : [],
    chatDraft: typeof state.chatDraft === "string" ? state.chatDraft : "",
    chatQueue: Array.isArray(state.chatQueue) ? [...state.chatQueue] : [],
    chatLoading: Boolean(state.chatLoading),
    chatSending: Boolean(state.chatSending),
    chatError: typeof state.chatError === "string" ? state.chatError : "",
    chatStream: typeof state.chatStream === "string" ? state.chatStream : "",
    chatStreamStartedAt:
      typeof state.chatStreamStartedAt === "number" ? state.chatStreamStartedAt : null,
    chatStreamSegments: Array.isArray(state.chatStreamSegments) ? [...state.chatStreamSegments] : [],
    chatToolMessages: Array.isArray(state.chatToolMessages) ? [...state.chatToolMessages] : [],
    chatCompactionStatus:
      state.chatCompactionStatus && typeof state.chatCompactionStatus === "object"
        ? { ...state.chatCompactionStatus }
        : null,
    chatFallbackStatus:
      state.chatFallbackStatus && typeof state.chatFallbackStatus === "object"
        ? { ...state.chatFallbackStatus }
        : null,
    chatAttachments: Array.isArray(state.chatAttachments) ? [...state.chatAttachments] : [],
  };
}

function isThreadNearBottom(node) {
  if (!node) {
    return true;
  }

  const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
  return remaining <= THREAD_AUTO_SCROLL_THRESHOLD_PX;
}

function getAppBridge() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.xiaolanbu ?? null;
}

function buildCloudTunnelDashboardUrl(dashboardUrl) {
  const token = getDashboardToken(dashboardUrl);
  return `http://127.0.0.1:${CLOUD_TUNNEL_DASHBOARD_PORT}${token ? `/#token=${token}` : ""}`;
}

function buildCloudTunnelBrowserControlUrl(browserControlUrl = "") {
  const token = getDashboardToken(browserControlUrl);
  return `http://127.0.0.1:${CLOUD_TUNNEL_BROWSER_CONTROL_PORT}${token ? `/#token=${token}` : "/"}`;
}

function shouldReloadHistoryForFinalEvent(payload) {
  if (!payload || payload.state !== "final") {
    return false;
  }
  if (!payload.message || typeof payload.message !== "object") {
    return true;
  }
  const role = typeof payload.message.role === "string" ? payload.message.role.toLowerCase() : "";
  if (role && role !== "assistant") {
    return true;
  }
  return false;
}

function sessionKeysLikelyMatch(expected, actual) {
  const left = typeof expected === "string" ? expected.trim() : "";
  const right = typeof actual === "string" ? actual.trim() : "";

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  if (left === "main" && /(^|:)main$/.test(right)) {
    return true;
  }

  if (right === "main" && /(^|:)main$/.test(left)) {
    return true;
  }

  return false;
}

function loadStoredChatShowThinking() {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    const raw = window.localStorage.getItem(CHAT_SHOW_THINKING_STORAGE_KEY);
    if (raw === null) {
      return true;
    }
    if (raw === "true" || raw === "1") {
      return true;
    }
    if (raw === "false" || raw === "0") {
      return false;
    }
    return Boolean(JSON.parse(raw));
  } catch {
    return true;
  }
}

function persistChatShowThinking(value) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(CHAT_SHOW_THINKING_STORAGE_KEY, value ? "true" : "false");
}

function loadStoredChatSessionSelections() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(CHAT_SESSION_SELECTION_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry) => {
        const [deploymentId, sessionKey] = entry;
        return (
          typeof deploymentId === "string" &&
          deploymentId.trim() &&
          typeof sessionKey === "string" &&
          sessionKey.trim()
        );
      }),
    );
  } catch {
    return {};
  }
}

function resolveStoredChatSessionKey(deploymentId, fallback = "main") {
  const normalizedDeploymentId =
    typeof deploymentId === "string" ? deploymentId.trim() : "";
  if (!normalizedDeploymentId) {
    return fallback;
  }

  const selections = loadStoredChatSessionSelections();
  const stored =
    typeof selections[normalizedDeploymentId] === "string"
      ? selections[normalizedDeploymentId].trim()
      : "";
  return stored || fallback;
}

function persistStoredChatSessionKey(deploymentId, sessionKey) {
  if (typeof window === "undefined") {
    return;
  }

  const normalizedDeploymentId =
    typeof deploymentId === "string" ? deploymentId.trim() : "";
  const normalizedSessionKey =
    typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!normalizedDeploymentId || !normalizedSessionKey) {
    return;
  }

  const next = {
    ...loadStoredChatSessionSelections(),
    [normalizedDeploymentId]: normalizedSessionKey,
  };
  window.localStorage.setItem(CHAT_SESSION_SELECTION_STORAGE_KEY, JSON.stringify(next));
}

function formatGatewaySessionLabel(session) {
  if (!session || typeof session !== "object") {
    return "main";
  }

  const candidates = [
    typeof session.displayName === "string" ? session.displayName.trim() : "",
    typeof session.label === "string" ? session.label.trim() : "",
    typeof session.subject === "string" ? session.subject.trim() : "",
    typeof session.room === "string" ? session.room.trim() : "",
    typeof session.space === "string" ? session.space.trim() : "",
    typeof session.key === "string" ? session.key.trim() : "",
  ].filter(Boolean);

  return candidates[0] || "main";
}

function normalizeGatewaySessionsForChat(sessions, currentKey = "main") {
  const rows = Array.isArray(sessions)
    ? sessions.filter((entry) => entry && typeof entry === "object" && typeof entry.key === "string")
    : [];

  const normalized = [];
  const seen = new Set();

  rows.forEach((entry) => {
    const key = entry.key.trim();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    normalized.push(entry);
  });

  const currentSessionKey = typeof currentKey === "string" ? currentKey.trim() : "";
  if (
    currentSessionKey &&
    !normalized.some((entry) => sessionKeysLikelyMatch(currentSessionKey, entry.key))
  ) {
    normalized.unshift({
      key: currentSessionKey,
      displayName: currentSessionKey,
      label: currentSessionKey,
      reasoningLevel: "off",
      thinkingLevel: "",
    });
  }

  return normalized;
}

async function getTunnelStatus() {
  const bridge = getAppBridge();
  if (!bridge?.getTunnelStatus) {
    return {
      ok: false,
      connected: false,
      dashboardPortOpen: false,
      browserControlPortOpen: false,
    };
  }

  return bridge.getTunnelStatus();
}

async function detectLocalOpenClaw() {
  const bridge = getAppBridge();
  if (!bridge?.detectLocalOpenClaw) {
    return { ok: false, installed: false };
  }

  return bridge.detectLocalOpenClaw();
}

async function getLocalOpenClawStatus() {
  const bridge = getAppBridge();
  if (!bridge?.getLocalOpenClawStatus) {
    return {
      ok: false,
      installed: false,
      ready: false,
      dashboardPortOpen: false,
      browserControlPortOpen: false,
      logPath: "",
      bootstrapStage: "idle",
      bootstrapMessage: "",
      bootstrapLastLine: "",
      localDeviceId: "",
      localDeviceLabel: "",
      bindingLocalDeviceId: "",
      bindingLocalDeviceLabel: "",
      workspaceId: "",
      deploymentId: "",
      bindingUpdatedAt: "",
      bootstrapLogUpdatedAt: 0,
      bindingMissingDuringBootstrap: false,
      localApiKeyConfigured: false,
      currentModelId: "",
      ownerAccountScopeId: "",
      ownerUserId: "",
      ownerDisplayName: "",
      ownerEmail: "",
      authSyncedAt: "",
      dashboardUrl: "",
      browserControlUrl: "",
      baseUrl: "",
    };
  }

  return bridge.getLocalOpenClawStatus();
}

async function syncLocalOpenClawAuth(payload) {
  const bridge = getAppBridge();
  if (!bridge?.syncLocalOpenClawAuth) {
    return { ok: false, error: "当前桌面端不支持同步本地 API Key。" };
  }

  return bridge.syncLocalOpenClawAuth(payload);
}

async function patchLocalOpenClawSessionModel(payload) {
  const bridge = getAppBridge();
  if (!bridge?.patchLocalOpenClawSessionModel) {
    return { ok: false, error: "当前桌面端不支持快速切换本地会话模型。" };
  }

  return bridge.patchLocalOpenClawSessionModel(payload);
}

async function clearLocalOpenClawApiKey() {
  const bridge = getAppBridge();
  if (!bridge?.clearLocalOpenClawApiKey) {
    return { ok: false, error: "当前桌面端不支持清除本地 API Key。" };
  }

  return bridge.clearLocalOpenClawApiKey();
}

async function bootstrapLocalOpenClaw(payload) {
  const bridge = getAppBridge();
  if (!bridge?.bootstrapLocalOpenClaw) {
    return { ok: false, error: "当前桌面端不支持本地一键部署。" };
  }

  return bridge.bootstrapLocalOpenClaw(payload);
}

async function resetLocalOpenClaw(options) {
  const bridge = getAppBridge();
  if (!bridge?.resetLocalOpenClaw) {
    return { ok: false, error: "当前桌面端不支持本地实例重置。" };
  }

  return bridge.resetLocalOpenClaw(options);
}

async function uninstallLocalOpenClaw() {
  const bridge = getAppBridge();
  if (!bridge?.uninstallLocalOpenClaw) {
    return { ok: false, error: "当前桌面端不支持卸载本地 OpenClaw。" };
  }

  return bridge.uninstallLocalOpenClaw();
}

async function getGatewayChatHistory(payload) {
  const bridge = getAppBridge();
  if (!bridge?.getGatewayChatHistory) {
    return { ok: false, error: "当前桌面端不支持原生聊天记录加载。" };
  }

  return bridge.getGatewayChatHistory(payload);
}

async function getGatewaySessions(payload) {
  const bridge = getAppBridge();
  if (!bridge?.getGatewaySessions) {
    return { ok: false, error: "当前桌面端不支持原生会话列表加载。" };
  }

  return bridge.getGatewaySessions(payload);
}

async function abortGatewayChat(payload) {
  const bridge = getAppBridge();
  if (!bridge?.abortGatewayChat) {
    return { ok: false, error: "当前桌面端不支持中止当前对话。" };
  }

  return bridge.abortGatewayChat(payload);
}

async function sendGatewayChatMessage(payload) {
  const bridge = getAppBridge();
  if (!bridge?.sendGatewayChatMessage) {
    return { ok: false, error: "当前桌面端不支持原生聊天发送。" };
  }

  return bridge.sendGatewayChatMessage(payload);
}

function startGatewayChatMessage(payload) {
  const bridge = getAppBridge();
  if (!bridge?.startGatewayChatMessage) {
    throw new Error("当前桌面端不支持流式聊天发送。");
  }

  bridge.startGatewayChatMessage(payload);
}

async function saveMarkdownExport(payload) {
  const bridge = getAppBridge();
  if (!bridge?.saveMarkdownExport) {
    return { ok: false, error: "当前桌面端不支持导出聊天记录。" };
  }

  return bridge.saveMarkdownExport(payload);
}

function subscribeGatewayChatEvents(listener) {
  const bridge = getAppBridge();
  if (!bridge?.subscribeGatewayChatEvents) {
    return () => {};
  }

  return bridge.subscribeGatewayChatEvents(listener);
}

function createAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createQueueItemId() {
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isChatStopCommand(text) {
  const trimmed = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (!trimmed) {
    return false;
  }
  return trimmed === "/stop" || trimmed === "stop" || trimmed === "esc" || trimmed === "abort";
}

function isChatResetCommand(text) {
  const trimmed = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (!trimmed) {
    return false;
  }
  return trimmed === "/new" || trimmed === "/reset" || trimmed.startsWith("/new ") || trimmed.startsWith("/reset ");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(reader.result);
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("读取文件失败"));
    });
    reader.readAsDataURL(file);
  });
}

async function filesToAttachments(files) {
  const list = Array.from(files ?? []);
  const results = [];
  const rejected = [];
  for (const file of list) {
    if (!file) {
      continue;
    }
    const normalizedMimeType =
      typeof file.type === "string" ? file.type.trim().toLowerCase() : "";
    const inferredFromName =
      typeof file.name === "string" && file.name.includes(".")
        ? CHAT_IMAGE_EXTENSION_TO_MIME.get(file.name.split(".").pop().trim().toLowerCase()) || ""
        : "";
    const resolvedMimeType =
      normalizedMimeType && SUPPORTED_CHAT_IMAGE_MIME_TYPES.has(normalizedMimeType)
        ? normalizedMimeType
        : inferredFromName;
    if (!resolvedMimeType) {
      rejected.push(file.name || "未命名文件");
      continue;
    }
    const dataUrl = await fileToDataUrl(file);
    if (typeof dataUrl !== "string" || !dataUrl) {
      continue;
    }
    results.push({
      id: createAttachmentId(),
      dataUrl,
      mimeType: resolvedMimeType,
      name: file.name || "image",
    });
  }
  return { attachments: results, rejected };
}

function mergeAttachments(current, incoming) {
  const merged = [...(Array.isArray(current) ? current : [])];
  for (const entry of incoming ?? []) {
    if (!entry?.dataUrl) {
      continue;
    }
    const exists = merged.some((item) => item.dataUrl === entry.dataUrl);
    if (!exists) {
      merged.push(entry);
    }
  }
  return merged;
}

function adjustComposerTextareaHeight(element) {
  if (!element) {
    return;
  }
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function formatExportTimestamp(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function escapeMarkdownLabel(value) {
  return String(value || "image").replace(/[[\]\\]/g, "\\$&");
}

function buildChatMarkdownExport(messages, options = {}) {
  const lines = ["# Xiaolanbu Chat Export", ""];
  if (options.sessionKey) {
    lines.push(`Session: \`${options.sessionKey}\``);
  }
  lines.push(`Exported At: ${formatExportTimestamp(Date.now()) || new Date().toISOString()}`, "");

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const normalized = openclawChat.normalizeMessage(message);
    const role = openclawChat.normalizeRoleForGrouping(normalized.role);
    const roleLabel =
      role === "user"
        ? "你"
        : role === "assistant"
          ? "OpenClaw"
          : role === "toolresult"
            ? "工具结果"
            : role || "消息";
    const timestampLabel = formatExportTimestamp(normalized.timestamp);

    lines.push(`## ${roleLabel}${timestampLabel ? ` · ${timestampLabel}` : ""}`, "");

    const thinking =
      role === "assistant" ? (openclawChat.extractThinkingCached(message) ?? "").trim() : "";
    if (thinking) {
      lines.push("### Thinking", "", thinking, "");
    }

    const text = (openclawChat.extractTextCached(message) ?? "").trim();
    if (text) {
      lines.push(text, "");
    }

    const images = openclawChat.extractImages(message);
    images.forEach((image, index) => {
      if (!image?.url) {
        return;
      }
      const label = escapeMarkdownLabel(image.alt || `image-${index + 1}`);
      lines.push(`![${label}](${image.url})`, "");
    });
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function getDesktopPlatform() {
  const bridge = getAppBridge();
  return bridge?.platform ?? "";
}

function resolveAuthScopeId(payload) {
  const candidates = [
    payload?.accountScopeId,
    payload?.defaultScopeId,
    payload?.activeWorkspaceId,
    payload?.currentAccountScope?.id,
    payload?.currentWorkspace?.id,
    payload?.user?.accountScopeId,
    payload?.user?.defaultScopeId,
    payload?.user?.activeWorkspaceId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function isTunnelReadyForHost(tunnelStatus, publicIp) {
  if (!tunnelStatus?.connected || !publicIp) {
    return false;
  }

  return (
    tunnelStatus.host === publicIp &&
    Boolean(tunnelStatus.dashboardPortOpen) &&
    Boolean(tunnelStatus.browserControlPortOpen)
  );
}

async function launchTunnelCommand(command) {
  if (!command) {
    return { ok: false };
  }

  const publicIp = getTunnelHost(command);
  const preferredPort = getStoredSshPort(publicIp);
  const normalizedCommand = getNormalizedTunnelCommand(
    applyPreferredTunnelPort(command, preferredPort),
  );
  const bridge = getAppBridge();
  const sshPassword = getStoredSshPassword(publicIp);

  if (bridge?.launchTunnel) {
    return bridge.launchTunnel(normalizedCommand, sshPassword);
  }

  if (bridge?.launchCommand) {
    return bridge.launchCommand(normalizedCommand);
  }

  return { ok: false };
}

async function stopTunnelCommand() {
  const bridge = getAppBridge();
  if (!bridge?.stopTunnel) {
    return { ok: false };
  }

  return bridge.stopTunnel();
}

function getStoredSessionToken() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "";
}

function setStoredSessionToken(value) {
  if (typeof window === "undefined") {
    return;
  }

  if (!value) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, value);
}

function getStoredLocalClearKeyOnLogout() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(LOCAL_CLEAR_KEY_ON_LOGOUT_STORAGE_KEY) === "1";
}

function setStoredLocalClearKeyOnLogout(value) {
  if (typeof window === "undefined") {
    return;
  }

  if (value) {
    window.localStorage.setItem(LOCAL_CLEAR_KEY_ON_LOGOUT_STORAGE_KEY, "1");
    return;
  }

  window.localStorage.removeItem(LOCAL_CLEAR_KEY_ON_LOGOUT_STORAGE_KEY);
}

function getStoredSshPasswords() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(SSH_PASSWORD_STORAGE_KEY) ?? "{}";
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getStoredSshPorts() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(SSH_PORT_STORAGE_KEY) ?? "{}";
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function setStoredSshPassword(publicIp, password) {
  if (typeof window === "undefined" || !publicIp || !password) {
    return;
  }

  const nextPasswords = {
    ...getStoredSshPasswords(),
    [publicIp]: password,
  };
  window.localStorage.setItem(SSH_PASSWORD_STORAGE_KEY, JSON.stringify(nextPasswords));
}

function getStoredSshPassword(publicIp) {
  if (!publicIp) {
    return "";
  }

  return getStoredSshPasswords()[publicIp] ?? "";
}

function setStoredSshPort(publicIp, port) {
  if (typeof window === "undefined" || !publicIp) {
    return;
  }

  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) {
    return;
  }

  const nextPorts = {
    ...getStoredSshPorts(),
    [publicIp]: normalizedPort,
  };
  window.localStorage.setItem(SSH_PORT_STORAGE_KEY, JSON.stringify(nextPorts));
}

function getStoredSshPort(publicIp) {
  if (!publicIp) {
    return null;
  }

  const value = Number(getStoredSshPorts()[publicIp]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function clearStoredSshPort(publicIp) {
  if (typeof window === "undefined" || !publicIp) {
    return;
  }

  const nextPorts = { ...getStoredSshPorts() };
  delete nextPorts[publicIp];
  window.localStorage.setItem(SSH_PORT_STORAGE_KEY, JSON.stringify(nextPorts));
}

function clearStoredSshPassword(publicIp) {
  if (typeof window === "undefined" || !publicIp) {
    return;
  }

  const nextPasswords = { ...getStoredSshPasswords() };
  delete nextPasswords[publicIp];
  window.localStorage.setItem(SSH_PASSWORD_STORAGE_KEY, JSON.stringify(nextPasswords));
  clearStoredSshPort(publicIp);
}

function getStoredLocalBootstraps() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_BOOTSTRAP_STORAGE_KEY) ?? "{}";
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function clearStoredLocalBootstraps() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LOCAL_BOOTSTRAP_STORAGE_KEY);
}

function resolveLocalBootstrapStorageKey(value, payload = null) {
  const explicit =
    typeof value === "string" && value.trim()
      ? value.trim()
      : typeof payload?.accountScopeId === "string" && payload.accountScopeId.trim()
        ? payload.accountScopeId.trim()
        : typeof payload?.workspaceId === "string" && payload.workspaceId.trim()
          ? payload.workspaceId.trim()
          : typeof payload?.deploymentId === "string" && payload.deploymentId.trim()
            ? payload.deploymentId.trim().replace(/^local:/, "")
            : "";
  return explicit.replace(/^local:/, "");
}

function setStoredLocalBootstrap(storageKey, payload) {
  const resolvedKey = resolveLocalBootstrapStorageKey(storageKey, payload);
  if (typeof window === "undefined" || !resolvedKey || !payload) {
    return;
  }

  const current = getStoredLocalBootstraps();
  const next = { ...current };
  next[resolvedKey] = {
    ...payload,
    accountScopeId:
      typeof payload.accountScopeId === "string" && payload.accountScopeId.trim()
        ? payload.accountScopeId.trim()
        : resolvedKey,
    workspaceId:
      typeof payload.workspaceId === "string" && payload.workspaceId.trim()
        ? payload.workspaceId.trim()
        : resolvedKey,
    deploymentId:
      typeof payload.deploymentId === "string" && payload.deploymentId.trim()
        ? payload.deploymentId.trim()
        : `local:${resolvedKey}`,
    storedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(LOCAL_BOOTSTRAP_STORAGE_KEY, JSON.stringify(next));
}

function getStoredLocalBootstrap(storageKey) {
  const resolvedKey = resolveLocalBootstrapStorageKey(storageKey);
  if (!resolvedKey) {
    return null;
  }

  const current = getStoredLocalBootstraps();
  if (current[resolvedKey]) {
    return current[resolvedKey];
  }

  return (
    Object.values(current).find((value) => {
      if (!value || typeof value !== "object") {
        return false;
      }
      const candidateKey = resolveLocalBootstrapStorageKey(null, value);
      const deploymentId =
        typeof value.deploymentId === "string" ? value.deploymentId.trim().replace(/^local:/, "") : "";
      return candidateKey === resolvedKey || deploymentId === resolvedKey;
    }) ?? null
  );
}

function pruneStoredLocalBootstraps() {
  // Local bootstrap state is now account-scope keyed and intentionally independent
  // from backend deployment lists. It is cleared on logout/uninstall instead.
}

function buildLocalBootstrapFromDeployment(deployment) {
  if (!deployment || deployment.mode !== "local" || !deployment.gatewayKey?.secretKey) {
    return null;
  }

  const metadata = deployment.metadata ?? {};
  const access = deployment.access ?? {};
  const platform =
    typeof metadata.platform === "string" && metadata.platform
      ? metadata.platform
      : getDesktopPlatform();
  const gatewayPort = metadata.gatewayPort ?? 18789;
  const browserControlPort = metadata.browserControlPort ?? gatewayPort + 2;
  const gatewayToken =
    metadata.gatewayToken ??
    (typeof access.dashboardUrl === "string" ? access.dashboardUrl.split("#token=")[1] ?? "" : "");
  const dashboardUrl =
    access.dashboardUrl ??
    `http://127.0.0.1:${gatewayPort}${gatewayToken ? `/#token=${gatewayToken}` : ""}`;
  const browserControlUrl = access.browserControlUrl ?? `http://127.0.0.1:${browserControlPort}/`;
  const logPath =
    metadata.logPath ??
    (platform === "win32"
      ? "%LOCALAPPDATA%\\Xiaolanbu\\logs\\local-bootstrap.log"
      : "~/Library/Logs/Xiaolanbu/local-bootstrap.log");
  const modelId = resolveLocalBootstrapModelId(deployment);

  return {
    deploymentId: deployment.id,
    accountScopeId: deployment.workspaceId ?? "",
    workspaceId: deployment.workspaceId ?? "",
    localDeviceId: resolveLocalDeploymentDeviceId(deployment),
    localDeviceLabel: resolveLocalDeploymentDeviceLabel(deployment),
    platform,
    apiKey: deployment.gatewayKey.secretKey,
    providerId: resolveLocalBootstrapProviderId(deployment),
    baseUrl: deployment.gatewayKey.baseUrl,
    modelId,
    concreteModelId: modelId,
    gatewayPort,
    gatewayBind: metadata.gatewayBind ?? "loopback",
    browserControlPort,
    gatewayToken,
    dashboardUrl: dashboardUrl || deployment.consoleUrl || `http://127.0.0.1:${gatewayPort}`,
    browserControlUrl,
    tokenSource: access.tokenSource ?? "desktop-local-bootstrap (gateway.auth.token)",
    logPath,
    runtimePackages: Array.isArray(metadata.runtimePackages) ? metadata.runtimePackages : [],
    allowedModelIds: resolveLocalBootstrapAllowedModelIds(deployment),
    routingMode:
      typeof metadata.localGatewayRoutingMode === "string" && metadata.localGatewayRoutingMode
        ? metadata.localGatewayRoutingMode
        : "direct-model",
    gatewayTunnel:
      metadata.gatewayTunnel && typeof metadata.gatewayTunnel === "object"
        ? metadata.gatewayTunnel
        : undefined,
  };
}

function resolvePreferredStoredLocalBootstrap(localRuntimeStatus, preferredScopeId = "") {
  const current = Object.values(getStoredLocalBootstraps()).filter(
    (value) => value && typeof value === "object",
  );
  if (!current.length) {
    return null;
  }

  const runtimeScopeId =
    typeof (localRuntimeStatus?.ownerAccountScopeId || localRuntimeStatus?.workspaceId) === "string"
      ? String(localRuntimeStatus.ownerAccountScopeId || localRuntimeStatus.workspaceId).trim()
      : "";
  const requestedScopeId =
    typeof preferredScopeId === "string" && preferredScopeId.trim() ? preferredScopeId.trim() : "";
  const preferredKeys = [requestedScopeId, runtimeScopeId].filter(Boolean);

  for (const key of preferredKeys) {
    const match = getStoredLocalBootstrap(key);
    if (match) {
      return match;
    }
  }

  return [...current].sort((left, right) => {
    const leftTime = Date.parse(left?.storedAt || left?.authSyncedAt || "");
    const rightTime = Date.parse(right?.storedAt || right?.authSyncedAt || "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return 0;
  })[0] ?? null;
}

function buildSyntheticLocalDeployment(localRuntimeStatus, preferredScopeId = "") {
  const bootstrapPayload = resolvePreferredStoredLocalBootstrap(localRuntimeStatus, preferredScopeId);
  const localRuntimePresent =
    Boolean(localRuntimeStatus?.installed) ||
    Boolean(localRuntimeStatus?.ready) ||
    Boolean(localRuntimeStatus?.dashboardPortOpen) ||
    Boolean(localRuntimeStatus?.browserControlPortOpen) ||
    Boolean(localRuntimeStatus?.localApiKeyConfigured) ||
    Boolean(bootstrapPayload?.apiKey);

  if (!localRuntimePresent && !bootstrapPayload) {
    return null;
  }

  const scopeId =
    (typeof preferredScopeId === "string" && preferredScopeId.trim()) ||
    (typeof bootstrapPayload?.accountScopeId === "string" && bootstrapPayload.accountScopeId.trim()) ||
    (typeof bootstrapPayload?.workspaceId === "string" && bootstrapPayload.workspaceId.trim()) ||
    (typeof (localRuntimeStatus?.ownerAccountScopeId || localRuntimeStatus?.workspaceId) === "string"
      ? String(localRuntimeStatus.ownerAccountScopeId || localRuntimeStatus.workspaceId).trim()
      : "") ||
    "local";
  const modelId =
    normalizeLocalBootstrapModelCandidate(localRuntimeStatus?.currentModelId) ||
    normalizeLocalBootstrapModelCandidate(bootstrapPayload?.modelId) ||
    normalizeLocalBootstrapModelCandidate(bootstrapPayload?.defaultModelId) ||
    "gpt-5.2";
  const dashboardUrl =
    (typeof localRuntimeStatus?.dashboardUrl === "string" && localRuntimeStatus.dashboardUrl.trim()) ||
    (typeof bootstrapPayload?.dashboardUrl === "string" && bootstrapPayload.dashboardUrl.trim()) ||
    "http://127.0.0.1:18789";
  const browserControlUrl =
    (typeof localRuntimeStatus?.browserControlUrl === "string" && localRuntimeStatus.browserControlUrl.trim()) ||
    (typeof bootstrapPayload?.browserControlUrl === "string" && bootstrapPayload.browserControlUrl.trim()) ||
    "http://127.0.0.1:18791/";
  const providerId =
    (typeof bootstrapPayload?.providerId === "string" && bootstrapPayload.providerId.trim()) || "openai";
  const baseUrl =
    (typeof bootstrapPayload?.baseUrl === "string" && bootstrapPayload.baseUrl.trim()) ||
    (typeof localRuntimeStatus?.baseUrl === "string" && localRuntimeStatus.baseUrl.trim()) ||
    "";
  const allowedModelIds = Array.isArray(bootstrapPayload?.allowedModelIds)
    ? bootstrapPayload.allowedModelIds
        .map((item) => normalizeLocalBootstrapModelCandidate(item))
        .filter(Boolean)
    : [modelId];

  return {
    id: `local:${scopeId}`,
    workspaceId: scopeId,
    ownerUserId:
      (typeof localRuntimeStatus?.ownerUserId === "string" && localRuntimeStatus.ownerUserId.trim()) || "",
    name: "本地 OpenClaw",
    mode: "local",
    status: localRuntimeStatus?.ready
      ? "running"
      : localRuntimeStatus?.installed || localRuntimeStatus?.dashboardPortOpen
        ? "stopped"
        : localRuntimeStatus?.error
          ? "error"
          : "creating",
    provider: "local",
    region: "local-device",
    runtimeVersion:
      typeof localRuntimeStatus?.version === "string" && localRuntimeStatus.version.trim()
        ? localRuntimeStatus.version.trim()
        : "openclaw-local",
    consoleUrl: dashboardUrl,
    gatewayUrl: baseUrl,
    createdAt:
      (typeof bootstrapPayload?.storedAt === "string" && bootstrapPayload.storedAt.trim()) ||
      (typeof localRuntimeStatus?.authSyncedAt === "string" && localRuntimeStatus.authSyncedAt.trim()) ||
      new Date().toISOString(),
    lastHeartbeatAt:
      (typeof localRuntimeStatus?.bindingUpdatedAt === "string" && localRuntimeStatus.bindingUpdatedAt.trim()) ||
      new Date().toISOString(),
    access: {
      dashboardUrl,
      browserControlUrl,
      tokenSource:
        (typeof bootstrapPayload?.tokenSource === "string" && bootstrapPayload.tokenSource.trim()) ||
        "desktop-local-bootstrap (gateway.auth.token)",
    },
    gatewayKey:
      typeof bootstrapPayload?.apiKey === "string" && bootstrapPayload.apiKey.trim()
        ? {
            tokenId: `local:${scopeId}`,
            secretKey: bootstrapPayload.apiKey.trim(),
            modelId,
            baseUrl,
          }
        : undefined,
    metadata: {
      platform:
        (typeof bootstrapPayload?.platform === "string" && bootstrapPayload.platform.trim()) ||
        getDesktopPlatform(),
      gatewayPort: bootstrapPayload?.gatewayPort ?? 18789,
      gatewayBind:
        (typeof bootstrapPayload?.gatewayBind === "string" && bootstrapPayload.gatewayBind.trim()) ||
        "loopback",
      browserControlPort: bootstrapPayload?.browserControlPort ?? 18791,
      localDeviceId:
        (typeof localRuntimeStatus?.localDeviceId === "string" && localRuntimeStatus.localDeviceId.trim()) ||
        bootstrapPayload?.localDeviceId ||
        "",
      localDeviceLabel:
        (typeof localRuntimeStatus?.localDeviceLabel === "string" && localRuntimeStatus.localDeviceLabel.trim()) ||
        bootstrapPayload?.localDeviceLabel ||
        "",
      localGatewayModelId: modelId,
      modelId,
      providerId,
      baseUrl,
      gatewayAllowedModelIds: allowedModelIds,
      runtimePackages: Array.isArray(bootstrapPayload?.runtimePackages) ? bootstrapPayload.runtimePackages : [],
      logPath:
        (typeof bootstrapPayload?.logPath === "string" && bootstrapPayload.logPath.trim()) ||
        localRuntimeStatus?.logPath ||
        "",
      localGatewayRoutingMode:
        (typeof bootstrapPayload?.routingMode === "string" && bootstrapPayload.routingMode.trim()) ||
        "backend-model-routing",
      gatewayTunnel:
        bootstrapPayload?.gatewayTunnel && typeof bootstrapPayload.gatewayTunnel === "object"
          ? bootstrapPayload.gatewayTunnel
          : undefined,
      localRuntime: {
        deviceId:
          (typeof localRuntimeStatus?.localDeviceId === "string" && localRuntimeStatus.localDeviceId.trim()) ||
          bootstrapPayload?.localDeviceId ||
          "",
        deviceLabel:
          (typeof localRuntimeStatus?.localDeviceLabel === "string" && localRuntimeStatus.localDeviceLabel.trim()) ||
          bootstrapPayload?.localDeviceLabel ||
          "",
        currentModelId: modelId,
      },
    },
  };
}

function resolveLocalBootstrapProviderId(deployment, payload = null) {
  const metadata = deployment?.metadata ?? {};

  return (
    (typeof payload?.providerId === "string" && payload.providerId.trim()) ||
    (typeof metadata.localGatewayProviderId === "string" && metadata.localGatewayProviderId.trim()) ||
    (typeof metadata.providerId === "string" && metadata.providerId.trim()) ||
    "openai"
  );
}

function resolveLocalBootstrapModelId(deployment, payload = null) {
  const gatewayKey = deployment?.gatewayKey ?? {};
  const metadata = deployment?.metadata ?? {};

  return (
    normalizeLocalBootstrapModelCandidate(payload?.concreteModelId) ||
    normalizeLocalBootstrapModelCandidate(payload?.requestedModelId) ||
    normalizeLocalBootstrapModelCandidate(payload?.modelId) ||
    normalizeLocalBootstrapModelCandidate(metadata.localGatewayModelId) ||
    normalizeLocalBootstrapModelCandidate(gatewayKey.modelId) ||
    normalizeLocalBootstrapModelCandidate(metadata.modelId) ||
    "gpt-5.2"
  );
}

function resolveLocalBootstrapAllowedModelIds(deployment, payload = null) {
  const metadata = deployment?.metadata ?? {};
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = normalizeLocalBootstrapModelCandidate(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  if (Array.isArray(payload?.allowedModelIds)) {
    payload.allowedModelIds.forEach(push);
  }
  if (Array.isArray(metadata.gatewayAllowedModelIds)) {
    metadata.gatewayAllowedModelIds.forEach(push);
  }
  push(resolveLocalBootstrapModelId(deployment, payload));
  return candidates;
}

function localBootstrapPayloadEquals(left, right) {
  if (!left || !right) {
    return false;
  }

  const normalizeString = (value) =>
    typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  const normalizeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? String(parsed) : "";
  };

  return (
    normalizeString(left.apiKey) === normalizeString(right.apiKey) &&
    normalizeString(left.providerId) === normalizeString(right.providerId) &&
    normalizeString(left.baseUrl) === normalizeString(right.baseUrl) &&
    normalizeString(left.modelId) === normalizeString(right.modelId) &&
    normalizeString(left.gatewayBind) === normalizeString(right.gatewayBind) &&
    normalizeString(left.gatewayToken) === normalizeString(right.gatewayToken) &&
    normalizeNumber(left.gatewayPort) === normalizeNumber(right.gatewayPort) &&
    normalizeNumber(left.browserControlPort) === normalizeNumber(right.browserControlPort)
  );
}

function localBootstrapTransportEquals(left, right) {
  if (!left || !right) {
    return false;
  }

  const normalizeString = (value) =>
    typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  const normalizeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? String(parsed) : "";
  };

  return (
    normalizeString(left.apiKey) === normalizeString(right.apiKey) &&
    normalizeString(left.providerId) === normalizeString(right.providerId) &&
    normalizeString(left.baseUrl) === normalizeString(right.baseUrl) &&
    normalizeString(left.gatewayBind) === normalizeString(right.gatewayBind) &&
    normalizeString(left.gatewayToken) === normalizeString(right.gatewayToken) &&
    normalizeNumber(left.gatewayPort) === normalizeNumber(right.gatewayPort) &&
    normalizeNumber(left.browserControlPort) === normalizeNumber(right.browserControlPort)
  );
}

function enrichLocalBootstrapPayload(payload, deployment, workspaceId) {
  if (!deployment) {
    return payload;
  }

  const gatewayKey = deployment.gatewayKey ?? {};
  const metadata = deployment.metadata ?? {};
  const access = deployment.access ?? {};
  const gatewayPort = metadata.gatewayPort ?? payload?.gatewayPort ?? 18789;
  const browserControlPort =
    metadata.browserControlPort ?? payload?.browserControlPort ?? gatewayPort + 2;
  const metadataGatewayToken =
    typeof metadata.gatewayToken === "string" ? metadata.gatewayToken.trim() : "";
  const payloadGatewayToken =
    typeof payload?.gatewayToken === "string" ? payload.gatewayToken.trim() : "";
  const accessGatewayToken =
    typeof access.dashboardUrl === "string"
      ? access.dashboardUrl.split("#token=")[1]?.trim() ?? ""
      : "";
  const modelId = resolveLocalBootstrapModelId(deployment, payload);
  const allowedModelIds = resolveLocalBootstrapAllowedModelIds(deployment, payload);

  return {
    ...payload,
    deploymentId: deployment.id,
    workspaceId: workspaceId ?? deployment.workspaceId ?? payload.workspaceId ?? "",
    localDeviceId:
      (typeof payload?.localDeviceId === "string" && payload.localDeviceId.trim()) ||
      resolveLocalDeploymentDeviceId(deployment),
    localDeviceLabel:
      (typeof payload?.localDeviceLabel === "string" && payload.localDeviceLabel.trim()) ||
      resolveLocalDeploymentDeviceLabel(deployment),
    apiKey:
      (typeof payload?.apiKey === "string" && payload.apiKey.trim()) ||
      (typeof gatewayKey.secretKey === "string" && gatewayKey.secretKey.trim()) ||
      "",
    providerId: resolveLocalBootstrapProviderId(deployment, payload),
    baseUrl:
      (typeof payload?.baseUrl === "string" && payload.baseUrl.trim()) ||
      (typeof gatewayKey.baseUrl === "string" && gatewayKey.baseUrl.trim()) ||
      (typeof metadata.baseUrl === "string" && metadata.baseUrl.trim()) ||
      "",
    modelId,
    concreteModelId: modelId,
    allowedModelIds,
    gatewayPort,
    browserControlPort,
    gatewayBind:
      (typeof payload?.gatewayBind === "string" && payload.gatewayBind.trim()) ||
      (typeof metadata.gatewayBind === "string" && metadata.gatewayBind.trim()) ||
      "loopback",
    routingMode:
      (typeof payload?.routingMode === "string" && payload.routingMode.trim()) ||
      (typeof metadata.localGatewayRoutingMode === "string" && metadata.localGatewayRoutingMode.trim()) ||
      "direct-model",
    gatewayToken: payloadGatewayToken || metadataGatewayToken || accessGatewayToken,
    dashboardUrl:
      (typeof payload?.dashboardUrl === "string" && payload.dashboardUrl.trim()) ||
      (typeof access.dashboardUrl === "string" && access.dashboardUrl.trim()) ||
      `http://127.0.0.1:${gatewayPort}`,
    browserControlUrl:
      (typeof payload?.browserControlUrl === "string" && payload.browserControlUrl.trim()) ||
      (typeof access.browserControlUrl === "string" && access.browserControlUrl.trim()) ||
      `http://127.0.0.1:${browserControlPort}/`,
  };
}

function getDashboardToken(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }

  return value.split("#token=")[1]?.trim() ?? "";
}

function isLoopbackUrl(value) {
  if (typeof value !== "string" || !value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(value);
  }
}

function ChatAvatar({ role }) {
  const label = role === "user" ? "你" : role === "tool" ? "工" : "懒";
  return <div className={`chat-avatar ${role}`}>{label}</div>;
}

function ChatMessageImages({ images = [] }) {
  if (!images.length) {
    return null;
  }

  return (
    <div className="chat-message-images">
      {images.map((image, index) => (
        <img
          key={`${image.url}-${index}`}
          src={image.url}
          alt={image.alt || "Attached image"}
          className="chat-message-image"
        />
      ))}
    </div>
  );
}

function ComposerIcon({ children }) {
  return <span className="compose-icon" aria-hidden="true">{children}</span>;
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
      <path d="M8 22h8" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4Z" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M9.2 4.8a2.9 2.9 0 0 0-4 2.7v.6a3.4 3.4 0 0 0 .7 6.73H6a3 3 0 0 0 5.5 1.6" />
      <path d="M14.8 4.8a2.9 2.9 0 0 1 4 2.7v.6a3.4 3.4 0 0 1-.7 6.73H18a3 3 0 0 1-5.5 1.6" />
      <path d="M12 3.8v16.4" />
      <path d="M9.1 9.2c.8-.1 1.4-.8 1.4-1.7V6.8" />
      <path d="M14.9 9.2c-.8-.1-1.4-.8-1.4-1.7V6.8" />
      <path d="M8.9 14.3c.9 0 1.6.7 1.6 1.6v.6" />
      <path d="M15.1 14.3c-.9 0-1.6.7-1.6 1.6v.6" />
    </svg>
  );
}

function AttachmentPreview({ attachments = [], onRemove }) {
  if (!attachments.length) {
    return null;
  }

  return (
    <div className="chat-attachments">
      {attachments.map((attachment) => (
        <div className="chat-attachment" key={attachment.id}>
          <img
            src={attachment.dataUrl}
            alt={attachment.name || "Attachment preview"}
            className="chat-attachment__img"
          />
          <button
            className="chat-attachment__remove"
            type="button"
            aria-label="Remove attachment"
            onClick={() => onRemove?.(attachment.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function ChatCopyButton({ markdown, onCopyText }) {
  const [status, setStatus] = useState("idle");

  return (
    <button
      className="chat-copy-btn"
      type="button"
      title={status === "copied" ? "Copied" : status === "error" ? "Copy failed" : "Copy as markdown"}
      aria-label={status === "copied" ? "Copied" : status === "error" ? "Copy failed" : "Copy as markdown"}
      data-copied={status === "copied" ? "1" : undefined}
      data-error={status === "error" ? "1" : undefined}
      data-copying={status === "copying" ? "1" : undefined}
      disabled={status === "copying"}
      onClick={async () => {
        if (!markdown || status === "copying") {
          return;
        }
        setStatus("copying");
        try {
          await onCopyText(markdown, "Markdown 已复制");
          setStatus("copied");
          window.setTimeout(() => setStatus("idle"), 1500);
        } catch {
          setStatus("error");
          window.setTimeout(() => setStatus("idle"), 2000);
        }
      }}
    >
      <span className="chat-copy-btn__icon" aria-hidden="true">
        <span className="chat-copy-btn__icon-copy">⧉</span>
        <span className="chat-copy-btn__icon-check">✓</span>
      </span>
    </button>
  );
}

function ChatToolCard({ card, onOpenSidebar }) {
  const canClick = Boolean(onOpenSidebar && card.clickable);

  return (
    <div
      className={`chat-tool-card${canClick ? " chat-tool-card--clickable" : ""}`}
      role={canClick ? "button" : undefined}
      tabIndex={canClick ? 0 : undefined}
      onClick={canClick ? () => onOpenSidebar(card.sidebarContent) : undefined}
      onKeyDown={
        canClick
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }
              event.preventDefault();
              onOpenSidebar(card.sidebarContent);
            }
          : undefined
      }
    >
      <div className="chat-tool-card__header">
        <div className="chat-tool-card__title">
          <span>{card.title}</span>
        </div>
        {canClick ? <span className="chat-tool-card__action">{card.rawText ? "View" : "Open"}</span> : null}
        {card.completed && !canClick ? <span className="chat-tool-card__status">Done</span> : null}
      </div>
      {card.detailText ? <div className="chat-tool-card__detail">{card.detailText}</div> : null}
      {card.previewOutput ? <div className="chat-tool-card__preview mono">{card.previewOutput}</div> : null}
      {card.inlineOutput ? <div className="chat-tool-card__inline mono">{card.inlineOutput}</div> : null}
      {card.completed ? <div className="chat-tool-card__status-text muted">Completed</div> : null}
    </div>
  );
}

function ChatBubble({ message, onCopyText, onOpenSidebar }) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const bubbleClasses = [
    "chat-bubble",
    message.normalizedRole === "assistant" && message.text ? "has-copy" : "",
    message.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {message.thinkingHtml ? (
        <div
          className="chat-thinking"
          dangerouslySetInnerHTML={{ __html: message.thinkingHtml }}
        />
      ) : null}
      {!message.onlyToolCards && (message.textHtml || message.images.length > 0) ? (
        <div className={bubbleClasses}>
          {message.normalizedRole === "assistant" && message.text ? (
            <ChatCopyButton markdown={message.text} onCopyText={onCopyText} />
          ) : null}
          <ChatMessageImages images={message.images} />
          {message.textHtml ? (
            <div
              className="chat-text"
              dangerouslySetInnerHTML={{ __html: message.textHtml }}
            />
          ) : null}
        </div>
      ) : null}
      {message.toolCards.length > 0 ? (
        <>
          {message.toolCards.map((card) => (
            <ChatToolCard key={card.key} card={card} onOpenSidebar={onOpenSidebar} />
          ))}
        </>
      ) : null}
    </>
  );
}

function ChatReadingIndicator() {
  return (
    <div className="chat-bubble chat-reading-indicator" aria-hidden="true">
      <span className="chat-reading-indicator__dots">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function ChatMessageGroup({ item, onCopyText, onOpenSidebar }) {
  const timestamp = new Date(item.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={`chat-group ${item.role}`} key={item.key}>
      <ChatAvatar role={item.role} />
      <div className="chat-group-messages">
        {item.messages.map((message) => (
          <ChatBubble
            key={message.key}
            message={message}
            onCopyText={onCopyText}
            onOpenSidebar={onOpenSidebar}
          />
        ))}
        <div className="chat-group-footer">
          <span className="chat-sender-name">{item.label}</span>
          <span className="chat-group-timestamp">{timestamp}</span>
        </div>
      </div>
    </div>
  );
}

function MarkdownSidebar({ content, mode, onChangeMode, onClose, onCopyText }) {
  const html = content ? openclawChat.toSanitizedMarkdownHtml(content) : "";

  return (
    <div className="sidebar-panel">
      <div className="sidebar-header">
        <div className="sidebar-title">Tool Output</div>
        <div className="sidebar-header__actions">
          <div className="sidebar-toggle">
            <button
              className={`ghost-button small${mode === "markdown" ? " is-active" : ""}`}
              type="button"
              onClick={() => onChangeMode("markdown")}
            >
              Markdown
            </button>
            <button
              className={`ghost-button small${mode === "raw" ? " is-active" : ""}`}
              type="button"
              onClick={() => onChangeMode("raw")}
            >
              Raw
            </button>
          </div>
          {content ? (
            <button className="ghost-button small" type="button" onClick={() => void onCopyText(content, "工具输出已复制")}>
              复制
            </button>
          ) : null}
          <button className="ghost-button small" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      <div className="sidebar-content">
        {content ? (
          mode === "raw" ? (
            <pre className="sidebar-raw mono">{content}</pre>
          ) : (
            <div
              className="sidebar-markdown"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )
        ) : (
          <div className="assistant-thread__notice">没有可显示的内容。</div>
        )}
      </div>
    </div>
  );
}

function renderChatThreadItem(item, options = {}) {
  if (!item || typeof item !== "object") {
    return null;
  }

  if (item.kind === "divider") {
    return (
      <div className="chat-divider" key={item.key}>
        <span className="chat-divider__line" />
        <span className="chat-divider__label">{item.label}</span>
        <span className="chat-divider__line" />
      </div>
    );
  }

  if (item.kind === "reading-indicator") {
    return (
      <div className="chat-group assistant" key={item.key}>
        <ChatAvatar role="assistant" />
        <div className="chat-group-messages">
          <ChatReadingIndicator />
        </div>
      </div>
    );
  }

  if (item.kind === "stream") {
    return (
      <ChatMessageGroup
        key={item.key}
        item={{
          kind: "group",
          key: item.key,
          role: "assistant",
          label: item.label || "小懒布",
          timestamp: item.timestamp ?? Date.now(),
          messages: [{ key: `${item.key}:stream`, ...item.message }],
        }}
        onCopyText={options.onCopyText}
        onOpenSidebar={options.onOpenSidebar}
      />
    );
  }

  if (item.kind === "group") {
    return (
      <ChatMessageGroup
        key={item.key}
        item={item}
        onCopyText={options.onCopyText}
        onOpenSidebar={options.onOpenSidebar}
      />
    );
  }

  return null;
}

function resolveUserId(user) {
  const candidates = [user?.id, user?.userId, user?.accountUserId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function attachLocalAuthOwner(payload, { accountScopeId, user } = {}) {
  return {
    ...(payload ?? {}),
    accountScopeId:
      typeof accountScopeId === "string" && accountScopeId.trim() ? accountScopeId.trim() : "",
    userId: resolveUserId(user),
    displayName:
      typeof user?.displayName === "string" && user.displayName.trim()
        ? user.displayName.trim()
        : "",
    email:
      typeof user?.email === "string" && user.email.trim() ? user.email.trim() : "",
  };
}

function normalizeLocalDeploymentDeviceValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveRuntimeLocalDeviceId(localRuntimeStatus) {
  return normalizeLocalDeploymentDeviceValue(localRuntimeStatus?.localDeviceId);
}

function resolveRuntimeLocalDeviceLabel(localRuntimeStatus) {
  return normalizeLocalDeploymentDeviceValue(localRuntimeStatus?.localDeviceLabel);
}

function resolveLocalDeploymentMetadata(deployment) {
  return deployment?.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
}

function resolveLocalDeploymentRuntimeMetadata(deployment) {
  const metadata = resolveLocalDeploymentMetadata(deployment);
  return metadata.localRuntime && typeof metadata.localRuntime === "object"
    ? metadata.localRuntime
    : {};
}

function resolveLocalDeploymentDeviceId(deployment) {
  const metadata = resolveLocalDeploymentMetadata(deployment);
  const runtime = resolveLocalDeploymentRuntimeMetadata(deployment);
  return (
    normalizeLocalDeploymentDeviceValue(metadata.localDeviceId) ||
    normalizeLocalDeploymentDeviceValue(runtime.deviceId)
  );
}

function resolveLocalDeploymentDeviceLabel(deployment) {
  const metadata = resolveLocalDeploymentMetadata(deployment);
  const runtime = resolveLocalDeploymentRuntimeMetadata(deployment);
  return (
    normalizeLocalDeploymentDeviceValue(metadata.localDeviceLabel) ||
    normalizeLocalDeploymentDeviceValue(runtime.deviceLabel)
  );
}

function getDeploymentStatusRank(status) {
  if (status === "running") {
    return 0;
  }
  if (status === "creating") {
    return 1;
  }
  if (status === "stopped") {
    return 2;
  }
  if (status === "error") {
    return 3;
  }
  return 4;
}

function compareDeploymentPriority(left, right) {
  const rankDelta = getDeploymentStatusRank(left?.status) - getDeploymentStatusRank(right?.status);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  const leftTime = Date.parse(left?.lastHeartbeatAt || left?.createdAt || "");
  const rightTime = Date.parse(right?.lastHeartbeatAt || right?.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return String(right?.createdAt || "").localeCompare(String(left?.createdAt || ""));
}

function isCurrentDeviceLocalDeployment(deployment, localRuntimeStatus) {
  if (!deployment || deployment.mode !== "local") {
    return false;
  }

  const runtimeDeploymentId = normalizeLocalDeploymentDeviceValue(localRuntimeStatus?.deploymentId);
  if (runtimeDeploymentId && deployment.id === runtimeDeploymentId) {
    return true;
  }

  const runtimeDeviceId = resolveRuntimeLocalDeviceId(localRuntimeStatus);
  const deploymentDeviceId = resolveLocalDeploymentDeviceId(deployment);
  if (runtimeDeviceId && deploymentDeviceId) {
    return runtimeDeviceId === deploymentDeviceId;
  }

  return false;
}

function isForeignDeviceLocalDeployment(deployment, localRuntimeStatus) {
  if (!deployment || deployment.mode !== "local") {
    return false;
  }

  const runtimeDeviceId = resolveRuntimeLocalDeviceId(localRuntimeStatus);
  const deploymentDeviceId = resolveLocalDeploymentDeviceId(deployment);
  if (!runtimeDeviceId || !deploymentDeviceId) {
    return false;
  }

  return runtimeDeviceId !== deploymentDeviceId;
}

function resolveEffectiveDeploymentStatus(deployment, localRuntimeStatus) {
  if (!deployment || deployment.mode !== "local") {
    return deployment?.status || "";
  }

  if (!isCurrentDeviceLocalDeployment(deployment, localRuntimeStatus)) {
    return deployment.status || "";
  }

  if (localRuntimeStatus?.bindingMissingDuringBootstrap) {
    return "creating";
  }

  if (
    localRuntimeStatus?.ready ||
    (localRuntimeStatus?.dashboardPortOpen && localRuntimeStatus?.browserControlPortOpen)
  ) {
    return "running";
  }

  if (typeof localRuntimeStatus?.error === "string" && localRuntimeStatus.error.trim()) {
    return "error";
  }

  if (
    localRuntimeStatus?.installed ||
    localRuntimeStatus?.dashboardPortOpen ||
    localRuntimeStatus?.browserControlPortOpen
  ) {
    return "stopped";
  }

  return deployment.status || "";
}

function findLocalDeployment(deployments, localRuntimeStatus) {
  if (!Array.isArray(deployments)) {
    return buildSyntheticLocalDeployment(localRuntimeStatus);
  }

  const localDeployments = deployments.filter((item) => item?.mode === "local");
  if (!localDeployments.length) {
    return buildSyntheticLocalDeployment(localRuntimeStatus);
  }

  const runtimeDeploymentId = normalizeLocalDeploymentDeviceValue(localRuntimeStatus?.deploymentId);
  if (runtimeDeploymentId) {
    const exactDeployment = localDeployments.find((item) => item?.id === runtimeDeploymentId);
    if (exactDeployment) {
      return exactDeployment;
    }
  }

  const runtimeDeviceId = resolveRuntimeLocalDeviceId(localRuntimeStatus);
  if (runtimeDeviceId) {
    const sameDeviceDeployments = localDeployments.filter(
      (item) => resolveLocalDeploymentDeviceId(item) === runtimeDeviceId,
    );
    if (!sameDeviceDeployments.length) {
      return buildSyntheticLocalDeployment(localRuntimeStatus);
    }

    return [...sameDeviceDeployments].sort(compareDeploymentPriority)[0] ?? null;
  }

  const legacyDeployments = localDeployments.filter((item) => !resolveLocalDeploymentDeviceId(item));
  if (!legacyDeployments.length) {
    return buildSyntheticLocalDeployment(localRuntimeStatus);
  }

  return [...legacyDeployments].sort(compareDeploymentPriority)[0] ?? buildSyntheticLocalDeployment(localRuntimeStatus);
}

function dedupeVisibleDeployments(deployments, localRuntimeStatus) {
  if (!Array.isArray(deployments)) {
    return [];
  }

  const unique = new Map();
  for (const deployment of deployments) {
    if (!deployment || typeof deployment !== "object") {
      continue;
    }

    if (deployment.mode === "cloud") {
      unique.set(`deployment:${deployment.id}`, deployment);
    }
  }

  return Array.from(unique.values());
}

function shouldHideDesktopForeignLocalDeployment(deployment, localRuntimeStatus) {
  void deployment;
  void localRuntimeStatus;
  return false;
}

function resolveDesktopVisibleDeployments(deployments, localRuntimeStatus) {
  return dedupeVisibleDeployments(deployments, localRuntimeStatus).filter(
    (deployment) => !shouldHideDesktopForeignLocalDeployment(deployment, localRuntimeStatus),
  );
}

function countHiddenDesktopForeignLocalDeployments(deployments, localRuntimeStatus) {
  void deployments;
  void localRuntimeStatus;
  return 0;
}

function isUsableDeploymentOnCurrentDesktop(deployment, localRuntimeStatus) {
  if (!deployment || typeof deployment !== "object") {
    return false;
  }

  const effectiveStatus = resolveEffectiveDeploymentStatus(deployment, localRuntimeStatus);
  if (effectiveStatus !== "running") {
    return false;
  }

  if (deployment.mode !== "local") {
    return true;
  }

  return isCurrentDeviceLocalDeployment(deployment, localRuntimeStatus);
}

function getLocalIsolationIssue({
  sessionToken,
  currentScopeId,
  currentUserId,
  deployments,
  localRuntimeStatus,
  authLoading,
  workspaceLoading,
  localDeployPending,
}) {
  if (authLoading) {
    return null;
  }

  if (localDeployPending) {
    return null;
  }

  if (localRuntimeStatus?.bindingMissingDuringBootstrap) {
    return null;
  }

  const ownerUserId = localRuntimeStatus?.ownerUserId ?? "";
  const ownerWorkspaceId =
    localRuntimeStatus?.ownerAccountScopeId ?? localRuntimeStatus?.workspaceId ?? "";
  const localRuntimePresent =
    Boolean(localRuntimeStatus?.ready) ||
    Boolean(localRuntimeStatus?.installed) ||
    Boolean(localRuntimeStatus?.dashboardPortOpen) ||
    Boolean(localRuntimeStatus?.browserControlPortOpen) ||
    Boolean(ownerUserId) ||
    Boolean(ownerWorkspaceId);

  if (!localRuntimePresent || !sessionToken) {
    return null;
  }

  if (workspaceLoading) {
    return null;
  }

  if (localRuntimePresent && !localRuntimeStatus?.localApiKeyConfigured) {
    return {
      code: "missing-local-auth",
      message: "当前本地 OpenClaw 已启动，但本地 API Key 已清空。登录后会自动补回，也可以手动同步。",
    };
  }

  if (localRuntimePresent && !ownerUserId && !ownerWorkspaceId) {
    return {
      code: "legacy-unbound",
      message: "当前本地实例尚未写入账号归属。登录后会自动同步本地 API Key，如仍异常可点“修复本地部署”。",
    };
  }

  const ownerMismatch = currentUserId
    ? ownerUserId
      ? ownerUserId !== currentUserId
      : Boolean(ownerWorkspaceId && currentScopeId && ownerWorkspaceId !== currentScopeId)
    : Boolean(ownerWorkspaceId && currentScopeId && ownerWorkspaceId !== currentScopeId);

  if (ownerMismatch) {
    return {
      code: "workspace-mismatch",
      message: "当前本地实例仍在使用其他账号的本地 API Key。系统会优先自动同步；如仍异常可手动同步或修复。",
    };
  }

  const localDeployment = findLocalDeployment(deployments, localRuntimeStatus);
  const expectedModelId = resolveDeploymentGatewayModelId(localDeployment, "");
  const runtimeModelId = normalizeLocalBootstrapModelCandidate(localRuntimeStatus?.currentModelId);
  if (expectedModelId && runtimeModelId && expectedModelId !== runtimeModelId) {
    return {
      code: "model-mismatch",
      message: "当前本地实例实际运行模型与后台所选模型不一致。系统会自动同步；如仍异常可手动同步。",
    };
  }

  return null;
}

function shouldAutoSyncLocalRuntime({
  sessionToken,
  currentScopeId,
  currentUserId,
  deployments,
  runtimeStatus,
}) {
  if (!sessionToken || (!currentScopeId && !currentUserId) || !runtimeStatus) {
    return false;
  }

  const localRuntimePresent =
    Boolean(runtimeStatus.ready) ||
    Boolean(runtimeStatus.installed) ||
    Boolean(runtimeStatus.dashboardPortOpen) ||
    Boolean(runtimeStatus.browserControlPortOpen) ||
    Boolean(runtimeStatus.workspaceId);

  if (!localRuntimePresent) {
    return false;
  }

  if (!runtimeStatus.localApiKeyConfigured) {
    return true;
  }

  const ownerUserId = runtimeStatus.ownerUserId || "";
  const ownerScopeId = runtimeStatus.ownerAccountScopeId || runtimeStatus.workspaceId || "";
  const ownerMatchesCurrentAccount = currentUserId
    ? ownerUserId
      ? ownerUserId === currentUserId
      : Boolean(ownerScopeId && currentScopeId && ownerScopeId === currentScopeId)
    : Boolean(ownerScopeId && currentScopeId && ownerScopeId === currentScopeId);

  if (!ownerMatchesCurrentAccount) {
    return true;
  }

  const localDeployment = findLocalDeployment(deployments, runtimeStatus);
  if (!localDeployment) {
    return true;
  }
  const expectedModelId = resolveDeploymentGatewayModelId(localDeployment, "");
  const runtimeModelId = normalizeLocalBootstrapModelCandidate(runtimeStatus?.currentModelId);
  return Boolean(expectedModelId && runtimeModelId && expectedModelId !== runtimeModelId);
}

function formatLocalAuthOwner(status) {
  if (!status?.localApiKeyConfigured) {
    return "尚未配置本地 API Key";
  }

  const displayName =
    typeof status?.ownerDisplayName === "string" ? status.ownerDisplayName.trim() : "";
  const email = typeof status?.ownerEmail === "string" ? status.ownerEmail.trim() : "";
  const scopeId =
    typeof (status?.ownerAccountScopeId || status?.workspaceId) === "string"
      ? String(status.ownerAccountScopeId || status.workspaceId).trim()
      : "";

  if (displayName && email) {
    return `${displayName} <${email}>`;
  }

  if (email) {
    return email;
  }

  if (displayName) {
    return displayName;
  }

  if (scopeId) {
    return `${scopeId}（仅记录了账号范围）`;
  }

  return "已配置，但还没有归属信息";
}

function getTunnelHost(command) {
  if (typeof command !== "string") {
    return "";
  }

  const match = command.match(/@([A-Za-z0-9._-]+)\s*$/);
  return match?.[1] ?? "";
}

function applyPreferredTunnelPort(command, preferredPort) {
  if (typeof command !== "string") {
    return "";
  }

  const trimmed = command.trim();
  if (!trimmed.startsWith("ssh ") || /\s-p\s+\d+\b/.test(trimmed)) {
    return trimmed;
  }

  const normalizedPort = Number(preferredPort);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) {
    return trimmed;
  }

  return trimmed.replace(/^ssh\s+/, `ssh -p ${normalizedPort} `);
}

function getNormalizedTunnelCommand(command) {
  if (typeof command !== "string") {
    return "";
  }

  const trimmed = command.trim();
  if (!trimmed.startsWith("ssh ")) {
    return trimmed;
  }

  let normalized = trimmed;
  if (!normalized.includes("StrictHostKeyChecking=")) {
    normalized = normalized.replace(
      /^ssh\s+/,
      "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ",
    );
  }

  if (getDesktopPlatform() !== "win32" && !/\s-f(\s|$)/.test(normalized)) {
    normalized = normalized.replace(/^ssh\s+/, "ssh -f ");
  }

  if (!normalized.includes("ExitOnForwardFailure=")) {
    normalized = normalized.replace(/^ssh\s+/, "ssh -o ExitOnForwardFailure=yes ");
  }

  return normalized;
}

function formatCurrency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: 3,
  }).format(value);
}

function formatNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function fetchJson(path, options) {
  const headers = new Headers(options?.headers ?? {});
  const sessionToken = getStoredSessionToken();
  if (sessionToken) {
    headers.set("x-xlb-session", sessionToken);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.message || `Request failed: ${response.status}`);
    error.details = data;
    error.status = response.status;
    if (
      response.status === 401 &&
      sessionToken &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(
        new CustomEvent("xiaolanbu:session-expired", {
          detail: {
            message: data?.message || "登录状态已失效，请重新登录。",
          },
        }),
      );
    }
    throw error;
  }

  return data;
}

function AuthView({
  authMode,
  authForm,
  authPending,
  authError,
  onAuthFormChange,
  onAuthSubmit,
  onAuthModeChange,
}) {
  const isLogin = authMode === "login";
  const [activeField, setActiveField] = useState("idle");
  const [pointerOffset, setPointerOffset] = useState({ x: 0, y: 0 });
  const stageState = activeField === "idle" ? authMode : activeField;

  return (
    <div className="auth-shell">
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>
      <div className="ambient ambient-c"></div>
      <section className="auth-frame">
        <article className="auth-stage">
          <div
            className={`auth-stage__cluster is-${stageState}`}
            aria-hidden="true"
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
              const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
              setPointerOffset({ x, y });
            }}
            onMouseLeave={() => setPointerOffset({ x: 0, y: 0 })}
            style={{
              "--auth-pointer-x": `${pointerOffset.x.toFixed(3)}`,
              "--auth-pointer-y": `${pointerOffset.y.toFixed(3)}`,
            }}
          >
            <div className="auth-orbit auth-orbit--one">
              <div className="auth-creature auth-creature--coral">
                <div className="auth-creature__face">
                  <span></span>
                  <span></span>
                </div>
                <div className="auth-creature__mouth auth-creature__mouth--coral"></div>
                <div className="auth-creature__cheek auth-creature__cheek--left"></div>
                <div className="auth-creature__cheek auth-creature__cheek--right"></div>
                <div className="auth-creature__arm auth-creature__arm--left"></div>
                <div className="auth-creature__arm auth-creature__arm--right"></div>
              </div>
            </div>
            <div className="auth-orbit auth-orbit--two">
              <div className="auth-creature auth-creature--mint">
                <div className="auth-creature__face">
                  <span></span>
                  <span></span>
                </div>
                <div className="auth-creature__mouth auth-creature__mouth--mint"></div>
                <div className="auth-creature__arm auth-creature__arm--mint-left"></div>
                <div className="auth-creature__arm auth-creature__arm--mint-right"></div>
                <div className="auth-creature__antenna auth-creature__antenna--left"></div>
                <div className="auth-creature__antenna auth-creature__antenna--right"></div>
              </div>
            </div>
            <div className="auth-orbit auth-orbit--three">
              <div className="auth-creature auth-creature--cream">
                <div className="auth-creature__face">
                  <span></span>
                  <span></span>
                </div>
                <div className="auth-creature__mouth auth-creature__mouth--cream"></div>
                <div className="auth-creature__paw auth-creature__paw--left"></div>
                <div className="auth-creature__paw auth-creature__paw--right"></div>
              </div>
            </div>
            <button
              className={`auth-float-chip auth-float-chip--one ${stageState === "email" ? "is-active" : ""}`}
              type="button"
              aria-label="Cloud"
            >
              ☁
            </button>
            <button
              className={`auth-float-chip auth-float-chip--two ${
                stageState === "displayName" || stageState === "register" ? "is-active" : ""
              }`}
              type="button"
              aria-label="Identity"
            >
              ◆
            </button>
            <button
              className={`auth-float-chip auth-float-chip--three ${stageState === "login" ? "is-active" : ""}`}
              type="button"
              aria-label="Chat"
            >
              ✦
            </button>
            <button
              className={`auth-float-chip auth-float-chip--four ${stageState === "password" ? "is-active" : ""}`}
              type="button"
              aria-label="Tunnel"
            >
              ↗
            </button>
            <div className="auth-stage__floor"></div>
          </div>
        </article>

        <article className={`auth-card ${isLogin ? "is-login" : "is-register"}`}>
          <div className="auth-card__header">
            <div className="auth-mark">
              <span className="auth-mark__dot"></span>
              小懒布
            </div>
            <h2 className="auth-title">{isLogin ? "欢迎回来" : "创建账号"}</h2>
          </div>

          <div className="auth-switch">
            <button
              className={`ghost-button small ${authMode === "login" ? "is-selected" : ""}`}
              onClick={() => onAuthModeChange("login")}
            >
              登录
            </button>
            <button
              className={`ghost-button small ${authMode === "register" ? "is-selected" : ""}`}
              onClick={() => onAuthModeChange("register")}
            >
              注册
            </button>
          </div>

          {authError ? <div className="inline-notice inline-notice--error">{authError}</div> : null}

          <div className="auth-form">
            {!isLogin ? (
              <label className="field field--minimal">
                <span className="sr-only">昵称</span>
                <input
                  type="text"
                  value={authForm.displayName}
                  onChange={(event) => onAuthFormChange("displayName", event.target.value)}
                  onFocus={() => setActiveField("displayName")}
                  onBlur={() => setActiveField("idle")}
                  placeholder="昵称"
                />
              </label>
            ) : null}
            <label className="field field--minimal">
              <span className="sr-only">邮箱</span>
              <input
                type="email"
                value={authForm.email}
                onChange={(event) => onAuthFormChange("email", event.target.value)}
                onFocus={() => setActiveField("email")}
                onBlur={() => setActiveField("idle")}
                placeholder="邮箱"
              />
            </label>
            <label className="field field--minimal">
              <span className="sr-only">{isLogin ? "密码" : "设置密码"}</span>
              <input
                type="password"
                value={authForm.password}
                onChange={(event) => onAuthFormChange("password", event.target.value)}
                onFocus={() => setActiveField("password")}
                onBlur={() => setActiveField("idle")}
                placeholder={isLogin ? "密码" : "设置密码"}
              />
            </label>
            <button className="primary-button auth-submit" onClick={onAuthSubmit} disabled={authPending}>
              {authPending ? "处理中..." : isLogin ? "进入" : "创建并进入"}
            </button>
          </div>
        </article>
      </section>
    </div>
  );
}

function NavButton({ active, label, sub, icon, onClick }) {
  return (
    <button className={`nav-item ${active ? "is-active" : ""}`} onClick={onClick}>
      <span className="nav-item__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="nav-item__copy">
        <span className="nav-item__label">{label}</span>
        <span className="nav-item__sub">{sub}</span>
      </span>
    </button>
  );
}

function AppSidebar({ currentView, setCurrentView, wallet, activeDeploymentCount }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">小</div>
        <div>
          <div className="brand-title">
            <span>小懒布</span>
            <span className="brand-title__suffix">x OpenClaw</span>
          </div>
          <div className="brand-subtitle">你的 AI 助手，已经准备好上班。</div>
        </div>
      </div>

      <div className="persona-card">
        <div className="persona-art">
          <div className="persona-core"></div>
          <div className="persona-ring"></div>
          <div className="persona-spark persona-spark--a"></div>
          <div className="persona-spark persona-spark--b"></div>
        </div>
        <div className="persona-copy">
          <div className="persona-name">今日状态：轻快待命</div>
          <div className="persona-sub">云端已连接，本地模式可随时接管。</div>
        </div>
      </div>

      <div className="nav-section">Explore</div>
      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.key}
            active={currentView === item.key}
            label={item.label}
            sub={item.sub}
            icon={item.icon}
            onClick={() => setCurrentView(item.key)}
          />
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="status-card">
          <div className="status-card__title">实例状态</div>
          <div className="status-row">
            <span className="status-dot"></span>
            已连接 {activeDeploymentCount} 台可用实例
          </div>
          <div className="status-row">
            <span className="status-dot"></span>
            当前余额 {formatCurrency(wallet?.balanceCny)}
          </div>
          <div className="status-row">
            <span className="status-dot"></span>
            网关入口 {API_BASE.replace(/^https?:\/\//, "")}
          </div>
        </div>
      </div>
    </aside>
  );
}

function HomeView({ go, wallet, usageSummary, activeDeploymentCount, onLogout }) {
  const summaryCards = [
    {
      label: "在线实例",
      value: `${activeDeploymentCount}`,
      hint: activeDeploymentCount > 0 ? "可以直接进入聊天" : "还没有可用实例",
      tone: "coral",
    },
    {
      label: "当前余额",
      value: formatCurrency(wallet?.balanceCny),
      hint: "模型调用统一从账户余额扣费",
      tone: "gold",
    },
    {
      label: "今日请求",
      value: formatNumber(usageSummary?.requestCount ?? 0),
      hint: "今天累计发起的请求数",
      tone: "mint",
    },
    {
      label: "今日 Token",
      value: formatNumber(usageSummary?.totalTokens ?? 0),
      hint: "今天累计模型消耗",
      tone: "ink",
    },
  ];

  return (
    <section className="view view--home is-visible">
      <article className="card home-dashboard">
        <div className="home-hero-shell">
          <div className="home-hero-copy">
            <div className="eyebrow">Xiaolanbu x OpenClaw</div>
            <h2>小懒布工作台</h2>
            <p>把本地实例、云端入口和账户体系收进同一个桌面里，让聊天、部署和日常使用回到一套统一界面里。</p>
            <div className="home-hero-actions">
              <button className="primary-button" onClick={() => go("assistant")}>
                开始聊天
              </button>
              <button className="ghost-button" onClick={() => go("settings")}>
                管理部署
              </button>
              <button className="ghost-button" onClick={onLogout}>
                退出
              </button>
            </div>
            <div className="home-trust-row">
              <span className="chip">本地一键部署</span>
              <span className="chip">云端托管接入</span>
              <span className="chip">统一账户计费</span>
              <span className="chip">OpenClaw 驱动</span>
            </div>
            <div className="home-hero-ribbon">
              <div className="home-ribbon-card">
                <span className="home-ribbon-card__dot"></span>
                本地和云端实例在同一个界面里切换
              </div>
              <div className="home-ribbon-card">
                <span className="home-ribbon-card__dot home-ribbon-card__dot--mint"></span>
                聊天入口、工作区状态和账户体系统一收口
              </div>
            </div>
          </div>
          <div className="preview-card home-visual-card" aria-hidden="true">
            <div className="home-showcase">
              <div className="home-showcase__bg">
                <div className="home-visual-orb home-visual-orb--coral"></div>
                <div className="home-visual-orb home-visual-orb--mint"></div>
                <div className="home-visual-ring"></div>
                <div className="companion-aura"></div>
                <div className="floating-card floating-card--prompt">
                  <div className="floating-card__label">Workspace</div>
                  <div className="floating-card__text">本地与云端实例都收进同一个桌面入口。</div>
                </div>
                <div className="companion">
                  <div className="companion__halo"></div>
                  <div className="companion__body">
                    <div className="companion__face">
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
                <div className="floating-card floating-card--reply">
                  <div className="floating-card__label">Ready</div>
                  <div className="floating-card__text">聊天、部署和账户状态被整理成一套顺手的工作流。</div>
                </div>
                <div className="floating-chip-row">
                  <span className="floating-chip">Local runtime</span>
                  <span className="floating-chip">Cloud tunnel</span>
                  <span className="floating-chip">Account billing</span>
                </div>
              </div>
              <div className="home-accent-panel">
                <div className="home-accent-panel__halo"></div>
                <div className="home-accent-panel__spark home-accent-panel__spark--one"></div>
                <div className="home-accent-panel__spark home-accent-panel__spark--two"></div>
                <div className="home-accent-panel__spark home-accent-panel__spark--three"></div>
                <div className="home-accent-panel__blob home-accent-panel__blob--peach"></div>
                <div className="home-accent-panel__blob home-accent-panel__blob--mint"></div>
                <div className="home-accent-panel__cloud home-accent-panel__cloud--one"></div>
                <div className="home-accent-panel__cloud home-accent-panel__cloud--two"></div>
                <div className="home-accent-panel__ribbon"></div>
                <div className="home-accent-panel__mascot">
                  <div className="home-accent-panel__mascot-ring"></div>
                  <div className="home-accent-panel__mascot-body">
                    <div className="home-accent-panel__mascot-face">
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
                <div className="home-accent-panel__sticker home-accent-panel__sticker--heart">
                  <span></span>
                  <span></span>
                </div>
                <div className="home-accent-panel__sticker home-accent-panel__sticker--star"></div>
                <div className="home-accent-panel__sticker home-accent-panel__sticker--flower">
                  <span></span>
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                <div className="home-accent-panel__orbit">
                  <span className="home-accent-panel__orbit-dot home-accent-panel__orbit-dot--peach"></span>
                  <span className="home-accent-panel__orbit-dot home-accent-panel__orbit-dot--gold"></span>
                  <span className="home-accent-panel__orbit-dot home-accent-panel__orbit-dot--mint"></span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="home-bridge" aria-hidden="true">
          <div className="home-bridge__card home-bridge__card--left">
            <div className="home-bridge__glow home-bridge__glow--peach"></div>
            <div className="home-bridge__planet">
              <div className="home-bridge__planet-core"></div>
              <div className="home-bridge__planet-ring"></div>
            </div>
            <div className="home-bridge__spark home-bridge__spark--left"></div>
            <div className="home-bridge__spark home-bridge__spark--center"></div>
          </div>
          <div className="home-bridge__trail">
            <span className="home-bridge__trail-line"></span>
            <span className="home-bridge__trail-dot home-bridge__trail-dot--peach"></span>
            <span className="home-bridge__trail-dot home-bridge__trail-dot--gold"></span>
            <span className="home-bridge__trail-dot home-bridge__trail-dot--mint"></span>
          </div>
          <div className="home-bridge__card home-bridge__card--right">
            <div className="home-bridge__glow home-bridge__glow--mint"></div>
            <div className="home-bridge__flower">
              <span></span>
              <span></span>
              <span></span>
              <span></span>
            </div>
            <div className="home-bridge__orbit home-bridge__orbit--one"></div>
            <div className="home-bridge__orbit home-bridge__orbit--two"></div>
          </div>
        </div>

        <div className="home-summary-shell">
          <div className="home-summary-shell__head">
            <div className="eyebrow">Today Overview</div>
            <div className="home-summary-shell__title">当前工作区概览</div>
          </div>
          <div className="home-summary-grid">
            {summaryCards.map((item) => (
              <article className={`home-summary-card home-summary-card--${item.tone}`} key={item.label}>
                <div className="home-summary-card__top">
                  <div className="home-summary-card__label">{item.label}</div>
                  <span className="home-summary-card__spark"></span>
                </div>
                <div className="home-summary-card__value">{item.value}</div>
                <div className="home-summary-card__hint">{item.hint}</div>
              </article>
            ))}
          </div>
          <div className="home-summary-decor" aria-hidden="true">
            <div className="home-summary-decor__pebble">
              <div className="home-summary-decor__pebble-core"></div>
              <div className="home-summary-decor__pebble-bubble"></div>
            </div>
            <div className="home-summary-decor__trail">
              <span className="home-summary-decor__trail-line"></span>
              <span className="home-summary-decor__trail-dots">
                <span className="home-summary-decor__trail-dot home-summary-decor__trail-dot--peach"></span>
                <span className="home-summary-decor__trail-dot home-summary-decor__trail-dot--gold"></span>
                <span className="home-summary-decor__trail-dot home-summary-decor__trail-dot--mint"></span>
              </span>
            </div>
            <div className="home-summary-decor__ribbon">
              <span className="home-summary-decor__ribbon-loop home-summary-decor__ribbon-loop--left"></span>
              <span className="home-summary-decor__ribbon-loop home-summary-decor__ribbon-loop--right"></span>
              <span className="home-summary-decor__ribbon-tail home-summary-decor__ribbon-tail--left"></span>
              <span className="home-summary-decor__ribbon-tail home-summary-decor__ribbon-tail--right"></span>
            </div>
            <div className="home-summary-decor__spark home-summary-decor__spark--one"></div>
            <div className="home-summary-decor__spark home-summary-decor__spark--two"></div>
          </div>
        </div>
      </article>
    </section>
  );
}

function AssistantView({
  deployments,
  preferredDeploymentId,
  modelCatalog,
  onLaunchTunnel,
  onStopTunnel,
  onOpenExternal,
  onCopyText,
  onBootstrapLocal,
  onRepairLocal,
  onDeploymentModelChange,
  go,
  tunnelStatus,
  localRuntimeStatus,
  workspaceFeedback,
  workspaceError,
  cloudConnectPending,
  actionPendingId,
  actionPendingType,
  onClearWorkspaceFeedback,
}) {
  const threadRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const chatRequestIdRef = useRef("");
  const chatStreamRef = useRef("");
  const chatStreamTargetRef = useRef("");
  const chatStreamFlushTimerRef = useRef(0);
  const chatTerminalEventSeenRef = useRef(false);
  const chatLastActivityAtRef = useRef(0);
  const chatRecoveryInFlightRef = useRef(false);
  const toolStreamRef = useRef(openclawChat.createToolStreamHost("main"));
  const runtimeNoticeTimerRef = useRef(0);
  const historyRefreshTimersRef = useRef([]);
  const historyLoadVersionRef = useRef(0);
  const chatSourceIdentityRef = useRef("");
  const lastKnownLocalChatAccessRef = useRef({
    deploymentId: "",
    dashboardUrl: "",
    browserControlUrl: "",
  });
  const shouldAutoScrollRef = useRef(true);
  const latestAssistantStateRef = useRef(null);
  const activeSessionSelectionDeploymentIdRef = useRef("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatQueue, setChatQueue] = useState([]);
  const [chatSessionKey, setChatSessionKey] = useState("main");
  const [chatShowThinking, setChatShowThinking] = useState(loadStoredChatShowThinking);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [chatThinkingLevel, setChatThinkingLevel] = useState(null);
  const [chatStream, setChatStream] = useState("");
  const [chatStreamStartedAt, setChatStreamStartedAt] = useState(null);
  const [chatStreamSegments, setChatStreamSegments] = useState([]);
  const [chatToolMessages, setChatToolMessages] = useState([]);
  const [chatRuntimeNotice, setChatRuntimeNotice] = useState("");
  const [chatCompactionStatus, setChatCompactionStatus] = useState(null);
  const [chatFallbackStatus, setChatFallbackStatus] = useState(null);
  const [chatSidebarContent, setChatSidebarContent] = useState(null);
  const [chatSidebarMode, setChatSidebarMode] = useState("markdown");
  const [chatAttachments, setChatAttachments] = useState([]);
  const [chatVoiceListening, setChatVoiceListening] = useState(false);
  const [gatewaySessions, setGatewaySessions] = useState([]);
  const [gatewaySessionModelOverrides, setGatewaySessionModelOverrides] = useState({});
  const availableGatewayModels = useMemo(
    () => normalizeGatewayModelCatalog(modelCatalog),
    [modelCatalog],
  );
  const normalizedGatewaySessions = useMemo(
    () => normalizeGatewaySessionsForChat(gatewaySessions, chatSessionKey),
    [gatewaySessions, chatSessionKey],
  );
  const activeGatewaySession =
    normalizedGatewaySessions.find((entry) => sessionKeysLikelyMatch(chatSessionKey, entry.key)) ?? null;
  const activeGatewaySessionLabel = formatGatewaySessionLabel(
    activeGatewaySession ?? {
      key: chatSessionKey,
      displayName: chatSessionKey,
      label: chatSessionKey,
    },
  );
  const activeGatewayReasoningLevel =
    typeof activeGatewaySession?.reasoningLevel === "string"
      ? activeGatewaySession.reasoningLevel.trim().toLowerCase()
      : "off";
  const showThinking =
    chatShowThinking && activeGatewayReasoningLevel !== "off";

  const runningDeployments = deployments.filter(
    (item) => resolveEffectiveDeploymentStatus(item, localRuntimeStatus) === "running",
  );
  const localDeployment = findLocalDeployment(deployments, localRuntimeStatus);
  const cloudDeployment =
    runningDeployments.find((item) => item.mode === "cloud") ??
    deployments.find((item) => item.mode === "cloud") ??
    null;
  const localDeploymentReady = Boolean(localDeployment && localRuntimeStatus?.dashboardPortOpen);
  const cloudDashboardUrl = cloudDeployment?.access?.dashboardUrl ?? cloudDeployment?.consoleUrl ?? "";
  const cloudDirectReady = Boolean(cloudDashboardUrl && !isLoopbackUrl(cloudDashboardUrl));
  const cloudPublicIp = cloudDeployment?.publicIpAddress?.[0] ?? "";
  const cloudTunnelReady = isTunnelReadyForHost(tunnelStatus, cloudPublicIp);
  const activeCloudDeployment =
    cloudTunnelReady && cloudDeployment ? cloudDeployment : null;
  const preferredDeploymentCandidate =
    typeof preferredDeploymentId === "string" && preferredDeploymentId
      ? deployments.find((item) => item.id === preferredDeploymentId) ??
        (localDeployment?.id === preferredDeploymentId ? localDeployment : null)
      : null;
  const preferredDeployment =
    preferredDeploymentCandidate?.mode === "local" &&
    !isCurrentDeviceLocalDeployment(preferredDeploymentCandidate, localRuntimeStatus)
      ? null
      : preferredDeploymentCandidate;
  const nonForeignFallbackDeployment =
    cloudDeployment ??
    localDeployment ??
    deployments.find(
      (item) => item.mode !== "local" || isCurrentDeviceLocalDeployment(item, localRuntimeStatus),
    ) ??
    null;
  const primaryDeployment =
    preferredDeployment ??
    activeCloudDeployment ??
    (localDeploymentReady ? localDeployment : null) ??
    (cloudDirectReady || cloudTunnelReady ? cloudDeployment : null) ??
    nonForeignFallbackDeployment ??
    null;
  const publicIp = primaryDeployment?.publicIpAddress?.[0] ?? "";
  const isLocalDeployment = primaryDeployment?.mode === "local";
  const modelSwitchPending =
    Boolean(primaryDeployment?.id) &&
    actionPendingId === primaryDeployment.id &&
    actionPendingType === "switchModel";
  const remoteDashboardUrl = primaryDeployment?.access?.dashboardUrl ?? primaryDeployment?.consoleUrl ?? "";
  const rawTransportReady = isLocalDeployment
    ? Boolean(localRuntimeStatus?.dashboardPortOpen)
    : isLoopbackUrl(remoteDashboardUrl)
      ? isTunnelReadyForHost(tunnelStatus, publicIp)
      : Boolean(remoteDashboardUrl);
  const tunnelCommand = getNormalizedTunnelCommand(
    publicIp
      ? `ssh -N -L ${CLOUD_TUNNEL_DASHBOARD_PORT}:127.0.0.1:18789 -L ${CLOUD_TUNNEL_BROWSER_CONTROL_PORT}:127.0.0.1:18791 root@${publicIp}`
      : primaryDeployment?.access?.sshTunnel ?? "",
  );
  const localDashboardUrl = buildCloudTunnelDashboardUrl(remoteDashboardUrl);
  const remoteBrowserControlUrl = primaryDeployment?.access?.browserControlUrl ?? "";
  const rawDashboardUrl = isLocalDeployment
    ? remoteDashboardUrl || localDashboardUrl
    : isLoopbackUrl(remoteDashboardUrl)
      ? rawTransportReady
        ? localDashboardUrl
        : ""
      : remoteDashboardUrl;
  const rawBrowserControlUrl = isLocalDeployment
    ? remoteBrowserControlUrl || "http://127.0.0.1:18791/"
    : isLoopbackUrl(remoteBrowserControlUrl)
      ? rawTransportReady
        ? buildCloudTunnelBrowserControlUrl(remoteBrowserControlUrl)
        : ""
      : remoteBrowserControlUrl ||
        (rawTransportReady ? buildCloudTunnelBrowserControlUrl(remoteBrowserControlUrl) : "");
  const stickyLocalChatAccess =
    isLocalDeployment &&
    lastKnownLocalChatAccessRef.current.deploymentId === primaryDeployment?.id
      ? lastKnownLocalChatAccessRef.current
      : null;
  const dashboardUrl = isLocalDeployment
    ? rawDashboardUrl || stickyLocalChatAccess?.dashboardUrl || ""
    : rawDashboardUrl;
  const browserControlUrl = isLocalDeployment
    ? rawBrowserControlUrl || stickyLocalChatAccess?.browserControlUrl || "http://127.0.0.1:18791/"
    : rawBrowserControlUrl;
  const transportReady = isLocalDeployment
    ? Boolean(localRuntimeStatus?.dashboardPortOpen) || Boolean(stickyLocalChatAccess?.dashboardUrl)
    : rawTransportReady;
  const primaryDeploymentStatus = resolveEffectiveDeploymentStatus(
    primaryDeployment,
    localRuntimeStatus,
  );
  const canOpenNativeChat =
    primaryDeploymentStatus === "running" && Boolean(dashboardUrl) && transportReady;
  const needsTunnel =
    primaryDeploymentStatus === "running" &&
    !isLocalDeployment &&
    isLoopbackUrl(remoteDashboardUrl) &&
    !canOpenNativeChat &&
    Boolean(tunnelCommand);
  const localActionLabel = localDeployment ? "修复并启动本地部署" : "一键部署到本机";
  const activeChatUrl = canOpenNativeChat ? dashboardUrl : "";
  const chatSourceIdentity = primaryDeployment?.id
    ? `${primaryDeployment.mode}:${primaryDeployment.id}:${chatSessionKey}`
    : "";
  const threadItems = useMemo(
    () =>
      openclawChat.buildRenderableChatItems({
        sessionKey: chatSessionKey,
        messages: chatMessages,
        toolMessages: chatToolMessages,
        streamSegments: chatStreamSegments,
        stream: chatSending ? chatStream : null,
        streamStartedAt: chatStreamStartedAt,
        showThinking,
        assistantLabel: "小懒布",
        userLabel: "你",
        toolLabel: "工具",
      }),
    [
      chatMessages,
      chatSending,
      chatSessionKey,
      chatStream,
      chatStreamSegments,
      chatStreamStartedAt,
      chatToolMessages,
      showThinking,
    ],
  );
  const canAbortChat = chatSending || Boolean(toolStreamRef.current.chatRunId);
  const activeGatewaySessionModelOverride =
    typeof gatewaySessionModelOverrides?.[chatSessionKey] === "string" &&
    gatewaySessionModelOverrides[chatSessionKey].trim()
      ? gatewaySessionModelOverrides[chatSessionKey].trim()
      : "";
  const activeGatewaySessionModelId =
    activeGatewaySessionModelOverride || resolveActiveGatewaySessionModelId(activeGatewaySession);
  const localRuntimeModelId = isLocalDeployment
    ? normalizeLocalBootstrapModelCandidate(localRuntimeStatus?.currentModelId)
    : "";
  const currentDeploymentModelId =
    activeGatewaySessionModelId ||
    localRuntimeModelId ||
    resolveDeploymentGatewayModelId(
      primaryDeployment,
      resolveDefaultGatewayModelId(availableGatewayModels),
    );
  const currentDeploymentModel =
    findGatewayModelCatalogItem(availableGatewayModels, currentDeploymentModelId) ?? null;
  const currentDeploymentModelLabel = currentDeploymentModel
    ? formatGatewayModelLabel(currentDeploymentModel)
    : currentDeploymentModelId || "未识别模型";
  const [assistantModelDraft, setAssistantModelDraft] = useState(currentDeploymentModelId);
  const pendingDeploymentModel =
    findGatewayModelCatalogItem(availableGatewayModels, assistantModelDraft) ?? null;
  const pendingDeploymentModelLabel = pendingDeploymentModel
    ? formatGatewayModelLabel(pendingDeploymentModel)
    : assistantModelDraft || currentDeploymentModelLabel;
  const composePlaceholder = chatAttachments.length
    ? "Add a message or paste more images..."
    : "Message (↩ to send, Shift+↩ for line breaks, paste images)";

  latestAssistantStateRef.current = {
    sourceIdentity: chatSourceIdentity,
    requestId: chatRequestIdRef.current,
    terminalEventSeen: chatTerminalEventSeenRef.current,
    chatRunId: toolStreamRef.current.chatRunId,
    chatMessages,
    chatDraft,
    chatQueue,
    chatLoading,
    chatSending,
    chatError,
    chatStream,
    chatStreamStartedAt,
    chatStreamSegments,
    chatToolMessages,
    chatCompactionStatus,
    chatFallbackStatus,
    chatAttachments,
  };

  const clearRuntimeNotice = () => {
    if (runtimeNoticeTimerRef.current) {
      window.clearTimeout(runtimeNoticeTimerRef.current);
      runtimeNoticeTimerRef.current = 0;
    }
    setChatRuntimeNotice("");
  };

  const clearScheduledHistoryRefreshes = () => {
    for (const timer of historyRefreshTimersRef.current) {
      window.clearTimeout(timer);
    }
    historyRefreshTimersRef.current = [];
  };

  const scheduleSilentHistoryRefresh = (delays = [220, 900]) => {
    clearScheduledHistoryRefreshes();
    historyRefreshTimersRef.current = delays.map((delay) =>
      window.setTimeout(() => {
        void loadNativeChatHistory({ silent: true });
      }, delay),
    );
  };

  const copyChatText = async (value, successMessage = "已复制") => {
    if (!value) {
      return;
    }

    const bridge = getAppBridge();
    if (bridge?.copyText) {
      await bridge.copyText(value);
    } else if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      throw new Error("Clipboard is not available");
    }

    showRuntimeNotice(successMessage, 2500);
  };

  const handleExportChatMarkdown = async () => {
    const exportMessages = [...chatMessages];
    const pendingStream = getPendingChatStreamText();
    if (chatSending && pendingStream && !openclawChat.isSilentReply(pendingStream)) {
      exportMessages.push(openclawChat.createAssistantTextMessage(pendingStream));
    }

    const content = buildChatMarkdownExport(exportMessages, {
      sessionKey: chatSessionKey,
    });
    const result = await saveMarkdownExport({
      suggestedName: `xiaolanbu-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`,
      content,
    });

    if (result?.ok) {
      showRuntimeNotice("聊天记录已导出为 Markdown。", 2500);
      return;
    }

    if (result?.canceled) {
      return;
    }

    showRuntimeNotice(result?.error || "导出聊天记录失败。", 3000);
  };

  const showRuntimeNotice = (message, durationMs = 5000) => {
    clearRuntimeNotice();
    if (!message) {
      return;
    }
    setChatRuntimeNotice(message);
    runtimeNoticeTimerRef.current = window.setTimeout(() => {
      runtimeNoticeTimerRef.current = 0;
      setChatRuntimeNotice("");
    }, durationMs);
  };

  const clearSmoothChatStreamTimer = () => {
    if (chatStreamFlushTimerRef.current) {
      window.clearTimeout(chatStreamFlushTimerRef.current);
      chatStreamFlushTimerRef.current = 0;
    }
  };

  const getPendingChatStreamText = () => {
    const liveText = typeof chatStreamRef.current === "string" ? chatStreamRef.current.trim() : "";
    const targetText =
      typeof chatStreamTargetRef.current === "string" ? chatStreamTargetRef.current.trim() : "";
    return targetText.length >= liveText.length ? targetText : liveText;
  };

  const commitDisplayedChatStream = (nextText) => {
    const normalizedText = typeof nextText === "string" ? nextText : "";
    if (!toolStreamRef.current.chatStreamStartedAt && normalizedText) {
      toolStreamRef.current.chatStreamStartedAt = Date.now();
    }
    toolStreamRef.current.chatStream = normalizedText;
    chatStreamRef.current = normalizedText;
    setChatStreamStartedAt(toolStreamRef.current.chatStreamStartedAt);
    setChatStream(normalizedText);
  };

  const scheduleSmoothChatStreamFlush = () => {
    if (chatStreamFlushTimerRef.current) {
      return;
    }

    const flush = () => {
      chatStreamFlushTimerRef.current = 0;
      const targetText = chatStreamTargetRef.current;
      const currentText = chatStreamRef.current;
      if (!targetText || targetText.length <= currentText.length) {
        return;
      }

      const remaining = targetText.length - currentText.length;
      const step = Math.max(
        CHAT_STREAM_SMOOTH_MIN_STEP,
        Math.min(CHAT_STREAM_SMOOTH_MAX_STEP, Math.ceil(remaining / 12)),
      );
      const nextText = targetText.slice(0, currentText.length + step);
      commitDisplayedChatStream(nextText);

      if (nextText.length < targetText.length) {
        chatStreamFlushTimerRef.current = window.setTimeout(
          flush,
          CHAT_STREAM_SMOOTH_INTERVAL_MS,
        );
      }
    };

    chatStreamFlushTimerRef.current = window.setTimeout(flush, CHAT_STREAM_SMOOTH_INTERVAL_MS);
  };

  const syncToolHostState = () => {
    const snapshot = openclawChat.snapshotToolStream(toolStreamRef.current);
    chatStreamRef.current = snapshot.chatStream ?? "";
    chatStreamTargetRef.current = snapshot.chatStream ?? "";
    setChatStream(snapshot.chatStream ?? "");
    setChatStreamStartedAt(snapshot.chatStreamStartedAt ?? null);
    setChatStreamSegments(snapshot.chatStreamSegments);
    setChatToolMessages(snapshot.chatToolMessages);
    setChatCompactionStatus(snapshot.compactionStatus);
    setChatFallbackStatus(snapshot.fallbackStatus);
  };

  const restoreCachedAssistantState = (cachedState) => {
    const snapshot = cloneCachedAssistantState(cachedState);
    if (!snapshot) {
      return false;
    }

    chatRequestIdRef.current = snapshot.requestId;
    chatTerminalEventSeenRef.current = snapshot.terminalEventSeen;
    chatStreamRef.current = snapshot.chatStream ?? "";
    chatStreamTargetRef.current = snapshot.chatStream ?? "";
    toolStreamRef.current.chatRunId = snapshot.chatRunId || null;
    toolStreamRef.current.chatStream = snapshot.chatStream || null;
    toolStreamRef.current.chatStreamStartedAt = snapshot.chatStreamStartedAt ?? null;
    toolStreamRef.current.chatStreamSegments = [...snapshot.chatStreamSegments];
    toolStreamRef.current.chatToolMessages = [...snapshot.chatToolMessages];
    toolStreamRef.current.compactionStatus = snapshot.chatCompactionStatus;
    toolStreamRef.current.fallbackStatus = snapshot.chatFallbackStatus;

    setChatMessages(snapshot.chatMessages);
    setChatDraft(snapshot.chatDraft);
    setChatQueue(snapshot.chatQueue);
    setChatLoading(false);
    setChatSending(snapshot.chatSending);
    setChatError(snapshot.chatError);
    setChatStream(snapshot.chatStream);
    setChatStreamStartedAt(snapshot.chatStreamStartedAt);
    setChatStreamSegments(snapshot.chatStreamSegments);
    setChatToolMessages(snapshot.chatToolMessages);
    setChatCompactionStatus(snapshot.chatCompactionStatus);
    setChatFallbackStatus(snapshot.chatFallbackStatus);
    setChatAttachments(snapshot.chatAttachments);
    shouldAutoScrollRef.current = true;
    return true;
  };

  const resetTransientState = ({ clearRunId = true } = {}) => {
    if (clearRunId) {
      toolStreamRef.current.chatRunId = null;
    }
    clearSmoothChatStreamTimer();
    chatStreamTargetRef.current = "";
    openclawChat.resetToolStream(toolStreamRef.current);
    syncToolHostState();
    clearRuntimeNotice();
  };

  const buildMessageDedupKey = (message) => {
    if (!message || typeof message !== "object") {
      return "";
    }
    const toolCallId =
      typeof message.toolCallId === "string"
        ? message.toolCallId
        : typeof message.tool_call_id === "string"
          ? message.tool_call_id
          : "";
    if (toolCallId) {
      return `tool:${toolCallId}`;
    }
    const id =
      typeof message.id === "string"
        ? message.id
        : typeof message.messageId === "string"
          ? message.messageId
          : "";
    if (id) {
      return `msg:${id}`;
    }
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "unknown";
    const text = openclawChat.extractTextCached(message) ?? "";
    const thinking = openclawChat.extractThinkingCached(message) ?? "";
    const toolCards = openclawChat.extractToolCards(message)
      .map((card) =>
        JSON.stringify({
          kind: card.kind ?? "",
          name: card.name ?? "",
          args: card.args ?? null,
          text: card.text ?? "",
        }),
      )
      .join("|");
    return `${role}|${text}|${thinking}|${toolCards}`;
  };

  const buildMessageSemanticKey = (message) => {
    if (!message || typeof message !== "object") {
      return "";
    }
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "unknown";
    const text = openclawChat.extractTextCached(message) ?? "";
    const thinking = openclawChat.extractThinkingCached(message) ?? "";
    const toolCards = openclawChat.extractToolCards(message)
      .map((card) =>
        JSON.stringify({
          kind: card.kind ?? "",
          name: card.name ?? "",
          args: card.args ?? null,
          text: card.text ?? "",
        }),
      )
      .join("|");
    const images = openclawChat.extractImages(message)
      .map((image) =>
        JSON.stringify({
          url: image.url ?? image.dataUrl ?? "",
          mediaType: image.mediaType ?? "",
        }),
      )
      .join("|");
    const visibleThinking =
      !text && !toolCards && !images ? thinking : "";
    return `${role}|${text}|${visibleThinking}|${toolCards}|${images}`;
  };

  const normalizeMessageRole = (message) => {
    if (!message || typeof message !== "object") {
      return "";
    }
    return openclawChat.normalizeRoleForGrouping(message.role ?? "");
  };

  const findRecoverableAssistantMessageFromHistory = (historyMessages) => {
    const localMessages = openclawChat.normalizeHistoryMessages(chatMessages);
    const normalizedHistory = openclawChat.normalizeHistoryMessages(historyMessages);

    if (localMessages.length === 0 || normalizedHistory.length === 0) {
      return null;
    }

    let localUserMessage = null;
    for (let index = localMessages.length - 1; index >= 0; index -= 1) {
      const message = localMessages[index];
      if (normalizeMessageRole(message) === "user") {
        localUserMessage = message;
        break;
      }
    }

    if (!localUserMessage) {
      return null;
    }

    const strictKey = buildMessageDedupKey(localUserMessage);
    const semanticKey = buildMessageSemanticKey(localUserMessage);
    let matchedUserIndex = -1;

    for (let index = normalizedHistory.length - 1; index >= 0; index -= 1) {
      const message = normalizedHistory[index];
      if (normalizeMessageRole(message) !== "user") {
        continue;
      }

      if (
        (strictKey && buildMessageDedupKey(message) === strictKey) ||
        (semanticKey && buildMessageSemanticKey(message) === semanticKey)
      ) {
        matchedUserIndex = index;
        break;
      }
    }

    if (matchedUserIndex < 0) {
      return null;
    }

    const activeStreamText = getPendingChatStreamText();

    for (let index = normalizedHistory.length - 1; index > matchedUserIndex; index -= 1) {
      const message = normalizedHistory[index];
      if (normalizeMessageRole(message) !== "assistant") {
        continue;
      }
      if (!openclawChat.shouldRenderMessage(message)) {
        continue;
      }

      const candidateText = (openclawChat.extractTextCached(message) ?? "").trim();
      if (!activeStreamText) {
        return message;
      }
      if (!candidateText) {
        continue;
      }
      if (
        candidateText.length >= activeStreamText.length &&
        (candidateText.includes(activeStreamText) || activeStreamText.includes(candidateText))
      ) {
        return message;
      }
    }

    return null;
  };

  const mergeSilentHistoryMessages = (currentMessages, nextMessages) => {
    const current = openclawChat.normalizeHistoryMessages(currentMessages);
    const next = openclawChat.normalizeHistoryMessages(nextMessages);

    if (current.length === 0) {
      return next;
    }
    if (next.length === 0) {
      return current;
    }

    const nextStrictSeen = new Set(next.map((message) => buildMessageDedupKey(message)).filter(Boolean));
    const nextSemanticSeen = new Set(
      next.map((message) => buildMessageSemanticKey(message)).filter(Boolean),
    );
    const currentFullyCovered = current.every((message) => {
      const strictKey = buildMessageDedupKey(message);
      const semanticKey = buildMessageSemanticKey(message);
      return (
        (strictKey && nextStrictSeen.has(strictKey)) ||
        (semanticKey && nextSemanticSeen.has(semanticKey))
      );
    });

    if (currentFullyCovered) {
      return next;
    }

    const merged = [...current];
    const strictSeen = new Set(current.map((message) => buildMessageDedupKey(message)).filter(Boolean));
    const semanticSeen = new Set(
      current.map((message) => buildMessageSemanticKey(message)).filter(Boolean),
    );

    for (const message of next) {
      const strictKey = buildMessageDedupKey(message);
      const semanticKey = buildMessageSemanticKey(message);
      if ((strictKey && strictSeen.has(strictKey)) || (semanticKey && semanticSeen.has(semanticKey))) {
        continue;
      }
      merged.push(message);
      if (strictKey) {
        strictSeen.add(strictKey);
      }
      if (semanticKey) {
        semanticSeen.add(semanticKey);
      }
    }

    return merged;
  };

  const appendAssistantMessageIfDistinct = (message) => {
    if (!message || !openclawChat.shouldRenderMessage(message)) {
      return;
    }
    setChatMessages((current) => {
      const last = current[current.length - 1] ?? null;
      if (!last || typeof last !== "object") {
        return [...current, message];
      }
      const lastRole = typeof last.role === "string" ? last.role.toLowerCase() : "";
      const nextRole = typeof message.role === "string" ? message.role.toLowerCase() : "";
      if (lastRole !== "assistant" || nextRole !== "assistant") {
        return [...current, message];
      }
      const strictMatch = buildMessageDedupKey(last) === buildMessageDedupKey(message);
      const semanticMatch = buildMessageSemanticKey(last) === buildMessageSemanticKey(message);
      return strictMatch || semanticMatch ? current : [...current, message];
    });
  };

  const hasLiveToolEvents = () =>
    toolStreamRef.current.toolStreamOrder.length > 0 ||
    toolStreamRef.current.chatStreamSegments.length > 0;

  const addAttachments = async (files) => {
    const { attachments: nextAttachments, rejected } = await filesToAttachments(files);
    if (rejected.length > 0) {
      const summary =
        rejected.length === 1
          ? `未添加 ${rejected[0]}。暂不支持 SVG 等格式，请改成 PNG、JPG、GIF、WebP、HEIC 或 HEIF 后再上传。`
          : `有 ${rejected.length} 个文件未添加。暂不支持 SVG 等格式，请改成 PNG、JPG、GIF、WebP、HEIC 或 HEIF 后再上传。`;
      showRuntimeNotice(summary, 4200);
    }
    if (nextAttachments.length === 0) {
      return;
    }
    setChatAttachments((current) => mergeAttachments(current, nextAttachments));
  };

  const handleAttachmentPicker = () => {
    fileInputRef.current?.click();
  };

  const handleAttachmentChange = async (event) => {
    try {
      await addAttachments(event.target.files);
    } catch (error) {
      showRuntimeNotice(error instanceof Error ? error.message : "图片添加失败。", 3000);
    } finally {
      if (event.target) {
        event.target.value = "";
      }
    }
  };

  const handleComposerPaste = async (event) => {
    const items = event.clipboardData?.items;
    if (!items?.length) {
      return;
    }
    const imageFiles = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.type?.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    try {
      await addAttachments(imageFiles);
      showRuntimeNotice("已添加剪贴板图片。", 2500);
    } catch (error) {
      showRuntimeNotice(error instanceof Error ? error.message : "粘贴图片失败。", 3000);
    }
  };

  const handleClipboardImport = async () => {
    if (!navigator?.clipboard?.read) {
      showRuntimeNotice("当前环境不支持直接读取剪贴板图片。", 3000);
      return;
    }
    try {
      const clipboardItems = await navigator.clipboard.read();
      const imageFiles = [];
      for (const item of clipboardItems) {
        const type = item.types.find((entry) => entry.startsWith("image/"));
        if (!type) {
          continue;
        }
        const blob = await item.getType(type);
        imageFiles.push(new File([blob], `clipboard-${Date.now()}.png`, { type }));
      }
      if (imageFiles.length === 0) {
        showRuntimeNotice("剪贴板里没有图片。", 2500);
        return;
      }
      await addAttachments(imageFiles);
      showRuntimeNotice("已从剪贴板导入图片。", 2500);
    } catch (error) {
      showRuntimeNotice(error instanceof Error ? error.message : "导入剪贴板图片失败。", 3000);
    }
  };

  const handleToggleVoiceInput = () => {
    const SpeechRecognition =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;
    if (!SpeechRecognition) {
      showRuntimeNotice("当前环境不支持语音输入。", 3000);
      return;
    }

    if (speechRecognitionRef.current && chatVoiceListening) {
      speechRecognitionRef.current.stop();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onstart = () => {
      setChatVoiceListening(true);
      showRuntimeNotice("正在听你说话…", 2000);
    };
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? "";
      }
      if (transcript) {
        setChatDraft((current) => `${current}${current ? " " : ""}${transcript.trim()}`.trim());
      }
    };
    recognition.onerror = () => {
      setChatVoiceListening(false);
      speechRecognitionRef.current = null;
      showRuntimeNotice("语音输入失败，请再试一次。", 3000);
    };
    recognition.onend = () => {
      setChatVoiceListening(false);
      speechRecognitionRef.current = null;
    };
    speechRecognitionRef.current = recognition;
    recognition.start();
  };

  const handleOpenSidebar = (content) => {
    if (!content) {
      return;
    }
    setChatSidebarMode("markdown");
    setChatSidebarContent(content);
  };

  const handleCloseSidebar = () => {
    setChatSidebarContent(null);
  };

  const loadNativeChatHistory = async ({ silent = false, allowStallRecovery = false } = {}) => {
    if (!activeChatUrl) {
      historyLoadVersionRef.current += 1;
      setChatMessages([]);
      setGatewaySessions([]);
      setChatThinkingLevel(null);
      setChatSidebarContent(null);
      setChatSidebarMode("markdown");
      setChatAttachments([]);
      resetTransientState();
      return;
    }

    const historyLoadVersion = historyLoadVersionRef.current + 1;
    historyLoadVersionRef.current = historyLoadVersion;
    if (!silent) {
      setChatLoading(true);
    }
    setChatError("");

    try {
      const [historyResult, sessionsResult] = await Promise.allSettled([
        getGatewayChatHistory({
          dashboardUrl: activeChatUrl,
          sessionKey: chatSessionKey,
          limit: 200,
        }),
        getGatewaySessions({
          dashboardUrl: activeChatUrl,
          includeGlobal: true,
          includeUnknown: true,
          limit: 200,
        }),
      ]);

      const result = historyResult.status === "fulfilled" ? historyResult.value : null;
      const sessionsPayload = sessionsResult.status === "fulfilled" ? sessionsResult.value : null;

      if (!result?.ok) {
        if (historyLoadVersion !== historyLoadVersionRef.current) {
          return;
        }
        setChatError(result?.error || "聊天记录加载失败。");
        if (!silent) {
          setChatLoading(false);
        }
        return;
      }

      if (historyLoadVersion !== historyLoadVersionRef.current) {
        return;
      }

      if (sessionsPayload?.ok) {
        const nextSessions = Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [];
        setGatewaySessions(nextSessions);
        setGatewaySessionModelOverrides((current) => {
          if (!current || typeof current !== "object") {
            return current;
          }

          let changed = false;
          const next = { ...current };
          for (const [key, overriddenModelId] of Object.entries(current)) {
            const normalizedKey = typeof key === "string" ? key.trim() : "";
            const normalizedOverride =
              typeof overriddenModelId === "string" ? overriddenModelId.trim() : "";
            if (!normalizedKey || !normalizedOverride) {
              delete next[key];
              changed = true;
              continue;
            }

            const matchingSession =
              nextSessions.find((entry) => sessionKeysLikelyMatch(normalizedKey, entry?.key)) ?? null;
            const actualModelId = resolveActiveGatewaySessionModelId(matchingSession);
            if (actualModelId && actualModelId === normalizedOverride) {
              delete next[key];
              changed = true;
            }
          }

          return changed ? next : current;
        });
      }
      setChatThinkingLevel(
        typeof result?.thinkingLevel === "string" && result.thinkingLevel.trim()
          ? result.thinkingLevel.trim()
          : null,
      );

      const normalizedMessages = openclawChat.normalizeHistoryMessages(result.messages);
      const canRecoverStalledChat =
        silent &&
        allowStallRecovery &&
        chatSending &&
        !chatTerminalEventSeenRef.current &&
        Date.now() - chatLastActivityAtRef.current >= CHAT_STALL_RECOVERY_IDLE_MS;
      const recoveredAssistantMessage = canRecoverStalledChat
        ? findRecoverableAssistantMessageFromHistory(normalizedMessages)
        : null;
      startTransition(() => {
        setChatMessages((current) =>
          silent ? mergeSilentHistoryMessages(current, normalizedMessages) : normalizedMessages,
        );
      });
      const keepTransientState =
        silent && (chatSending || Boolean(toolStreamRef.current.chatRunId));
      if (!keepTransientState) {
        resetTransientState({ clearRunId: false });
      }
      if (recoveredAssistantMessage) {
        chatTerminalEventSeenRef.current = true;
        chatRequestIdRef.current = "";
        chatLastActivityAtRef.current = Date.now();
        setChatError("");
        setChatSending(false);
        resetTransientState();
      }
      if (!silent) {
        setChatLoading(false);
      }
    } catch (error) {
      if (historyLoadVersion !== historyLoadVersionRef.current) {
        return;
      }
      setChatError(error instanceof Error ? error.message : "聊天记录加载失败。");
      if (!silent) {
        setChatLoading(false);
      }
    }
  };

  const handleIncomingChatEvent = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    chatLastActivityAtRef.current = Date.now();

    if (payload.state === "delta") {
      const nextText = openclawChat.extractTextCached(payload.message);
      if (!nextText || openclawChat.isSilentReply(nextText)) {
        return;
      }

      setChatSending(true);
      const targetText =
        nextText.length >= chatStreamTargetRef.current.length ? nextText : chatStreamTargetRef.current;
      chatStreamTargetRef.current = targetText;
      if (!chatStreamRef.current) {
        commitDisplayedChatStream("");
      }
      scheduleSmoothChatStreamFlush();
      return;
    }

    if (payload.state === "final") {
      const hadToolEvents = hasLiveToolEvents();
      chatTerminalEventSeenRef.current = true;
      if (openclawChat.shouldRenderMessage(payload.message)) {
        appendAssistantMessageIfDistinct(payload.message);
      } else if (getPendingChatStreamText() && !openclawChat.isSilentReply(getPendingChatStreamText())) {
        appendAssistantMessageIfDistinct(
          openclawChat.createAssistantTextMessage(getPendingChatStreamText()),
        );
      }
      chatRequestIdRef.current = "";
      setChatSending(false);
      resetTransientState();
      if (hadToolEvents || shouldReloadHistoryForFinalEvent(payload)) {
        scheduleSilentHistoryRefresh();
      }
      return;
    }

    if (payload.state === "aborted") {
      chatTerminalEventSeenRef.current = true;
      if (openclawChat.shouldRenderMessage(payload.message)) {
        appendAssistantMessageIfDistinct(payload.message);
      }
      chatRequestIdRef.current = "";
      setChatSending(false);
      resetTransientState();
      return;
    }

    if (payload.state === "error") {
      chatTerminalEventSeenRef.current = true;
      setChatError(
        typeof payload.errorMessage === "string" && payload.errorMessage.trim()
          ? payload.errorMessage.trim()
          : "消息发送失败。",
      );
      if (getPendingChatStreamText() && !openclawChat.isSilentReply(getPendingChatStreamText())) {
        appendAssistantMessageIfDistinct(
          openclawChat.createAssistantTextMessage(getPendingChatStreamText()),
        );
      }
      chatRequestIdRef.current = "";
      setChatSending(false);
      resetTransientState();
    }
  };

  const handleIncomingAgentEvent = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    chatLastActivityAtRef.current = Date.now();

    if (payload.stream === "compaction") {
      openclawChat.handleAgentEvent(toolStreamRef.current, payload);
      syncToolHostState();
      if (toolStreamRef.current.compactionStatus?.active) {
        showRuntimeNotice("正在整理上下文…", 5000);
      } else if (toolStreamRef.current.compactionStatus?.completedAt) {
        showRuntimeNotice("上下文已整理完成。", 5000);
      }
      return;
    }

    if (payload.stream === "fallback" || payload.stream === "lifecycle" || payload.stream === "tool") {
      openclawChat.handleAgentEvent(toolStreamRef.current, payload);
      syncToolHostState();
      if (payload.stream === "tool" && payload?.data?.phase === "result") {
        scheduleSilentHistoryRefresh([180, 900, 1800]);
      }
      const fallbackPhase = toolStreamRef.current.fallbackStatus?.phase;
      if (fallbackPhase === "active") {
        showRuntimeNotice("已切换到备用模型继续生成。", 8000);
      } else if (fallbackPhase === "cleared") {
        showRuntimeNotice("模型已恢复到首选配置。", 5000);
      }
      return;
    }
  };

  const handlePrimaryAction = () => {
    if (canOpenNativeChat) {
      return;
    }

    if (isLocalDeployment) {
      if (localDeployment && onRepairLocal) {
        onRepairLocal(primaryDeployment);
        return;
      }

      onBootstrapLocal();
      return;
    }

    if (needsTunnel) {
      onLaunchTunnel(tunnelCommand);
      return;
    }

    go("settings");
  };

  const handleAssistantModelChange = (event) => {
    const nextModelId = event.target.value;
    if (!primaryDeployment || !nextModelId) {
      return;
    }

    const previousModelId = currentDeploymentModelId;
    setGatewaySessionModelOverrides((current) => ({
      ...(current && typeof current === "object" ? current : {}),
      [chatSessionKey || "main"]: nextModelId,
    }));
    setAssistantModelDraft(nextModelId);
    Promise.resolve(
      onDeploymentModelChange?.(primaryDeployment, nextModelId, {
        sessionKey: chatSessionKey || "main",
        currentSessionModelId: currentDeploymentModelId,
      }),
    )
      .then((result) => {
        if (result?.ok === false) {
          setGatewaySessionModelOverrides((current) => {
            if (!current || typeof current !== "object") {
              return current;
            }
            const next = { ...current };
            delete next[chatSessionKey || "main"];
            return next;
          });
          setAssistantModelDraft(previousModelId);
          return;
        }

        scheduleSilentHistoryRefresh([80, 320, 900]);
      })
      .catch(() => {
        setGatewaySessionModelOverrides((current) => {
          if (!current || typeof current !== "object") {
            return current;
          }
          const next = { ...current };
          delete next[chatSessionKey || "main"];
          return next;
        });
        setAssistantModelDraft(previousModelId);
      });
  };

  const handleChatSessionChange = (event) => {
    const nextSessionKey =
      typeof event?.target?.value === "string" ? event.target.value.trim() : "";
    if (!nextSessionKey || sessionKeysLikelyMatch(chatSessionKey, nextSessionKey) || chatSending) {
      return;
    }

    clearScheduledHistoryRefreshes();
    setChatSessionKey(nextSessionKey);
    setChatSidebarContent(null);
    setChatSidebarMode("markdown");
    setChatError("");
    shouldAutoScrollRef.current = true;
  };

  const handleToggleThinkingVisibility = () => {
    setChatShowThinking((current) => !current);
  };

  const handleThreadScroll = () => {
    shouldAutoScrollRef.current = isThreadNearBottom(threadRef.current);
  };

  const handleAbortChat = async () => {
    if (!activeChatUrl) {
      return;
    }

    setChatDraft("");
    setChatAttachments([]);
    setChatError("");

    const result = await abortGatewayChat({
      dashboardUrl: activeChatUrl,
      sessionKey: chatSessionKey,
      runId: toolStreamRef.current.chatRunId || undefined,
    });

    if (!result?.ok) {
      setChatError(result?.error || "中止当前对话失败。");
      return;
    }

    chatRequestIdRef.current = "";
    chatTerminalEventSeenRef.current = true;
    setChatSending(false);
    resetTransientState();
  };

  const handleSendChat = async (messageOverride, options = {}) => {
    if (!activeChatUrl) {
      return;
    }

    const previousDraft = chatDraft;
    const previousAttachments = [...chatAttachments];
    const message =
      typeof messageOverride === "string" ? messageOverride.trim() : chatDraft.trim();
    const attachmentsToSend =
      messageOverride == null ? [...chatAttachments] : [...(options.attachments ?? [])];
    const hasAttachments = attachmentsToSend.length > 0;

    if (!message && !hasAttachments) {
      return;
    }

    if (isChatStopCommand(message)) {
      await handleAbortChat();
      return;
    }

    const refreshHistory = isChatResetCommand(message);
    if (chatSending && !options.fromQueue) {
      setChatQueue((current) => [
        ...current,
        {
          id: createQueueItemId(),
          text: message,
          attachments: attachmentsToSend,
          refreshHistory,
        },
      ]);
      return;
    }

    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    clearScheduledHistoryRefreshes();
    historyLoadVersionRef.current += 1;
    if (messageOverride == null) {
      setChatDraft("");
      setChatAttachments([]);
    }
    setChatSending(true);
    setChatError("");
    shouldAutoScrollRef.current = true;
    chatRequestIdRef.current = requestId;
    chatTerminalEventSeenRef.current = false;
    chatLastActivityAtRef.current = Date.now();
    resetTransientState();
    toolStreamRef.current.chatRunId = runId;
    setChatMessages((current) => [
      ...current,
      openclawChat.createUserTextMessage(message, attachmentsToSend),
    ]);

    try {
      startGatewayChatMessage({
        dashboardUrl: activeChatUrl,
        sessionKey: chatSessionKey,
        message,
        attachments: attachmentsToSend,
        requestId,
        runId,
        timeoutMs: 180000,
      });
    } catch (error) {
      chatRequestIdRef.current = "";
      setChatSending(false);
      setChatError(error instanceof Error ? error.message : "消息发送失败。");
      if (messageOverride != null && options.restoreDraft) {
        setChatDraft(previousDraft);
        setChatAttachments(previousAttachments);
      }
      resetTransientState();
      return;
    }

    if (messageOverride != null && options.restoreDraft) {
      setChatDraft(previousDraft);
      setChatAttachments(previousAttachments);
    }
  };

  const handleRemoveQueuedMessage = (queueId) => {
    setChatQueue((current) => current.filter((item) => item.id !== queueId));
  };

  useEffect(() => {
    if (!activeChatUrl || chatSending || chatQueue.length === 0) {
      return;
    }

    const [next, ...rest] = chatQueue;
    setChatQueue(rest);
    void handleSendChat(next.text, {
      attachments: next.attachments,
      fromQueue: true,
    });
  }, [activeChatUrl, chatQueue, chatSending]);

  useEffect(() => {
    if (!activeChatUrl || !chatSending || chatTerminalEventSeenRef.current) {
      chatRecoveryInFlightRef.current = false;
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (chatRecoveryInFlightRef.current) {
        return;
      }
      if (Date.now() - chatLastActivityAtRef.current < CHAT_STALL_RECOVERY_IDLE_MS) {
        return;
      }

      chatRecoveryInFlightRef.current = true;
      void loadNativeChatHistory({
        silent: true,
        allowStallRecovery: true,
      }).finally(() => {
        chatRecoveryInFlightRef.current = false;
      });
    }, CHAT_STALL_RECOVERY_POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeChatUrl, chatSending]);

  useEffect(() => () => {
    clearSmoothChatStreamTimer();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeGatewayChatEvents((frame) => {
      if (!frame || typeof frame !== "object") {
        return;
      }

      const activeRequestId = chatRequestIdRef.current;
      const activeRunId = toolStreamRef.current.chatRunId;
      const frameRequestId =
        typeof frame.requestId === "string" && frame.requestId.trim() ? frame.requestId.trim() : "";
      const frameRunId =
        typeof frame.runId === "string" && frame.runId.trim() ? frame.runId.trim() : "";
      const requestMatches = Boolean(activeRequestId) && frameRequestId === activeRequestId;
      const runMatches = Boolean(activeRunId) && frameRunId === activeRunId;

      if (!requestMatches && !runMatches) {
        return;
      }

      if (
        !toolStreamRef.current.chatRunId &&
        typeof frame.runId === "string" &&
        frame.runId.trim()
      ) {
        toolStreamRef.current.chatRunId = frame.runId.trim();
      }

      if (frame.event === "chat") {
        handleIncomingChatEvent(frame.payload);
        return;
      }

      if (frame.event === "agent") {
        handleIncomingAgentEvent(frame.payload);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    clearScheduledHistoryRefreshes();
    historyLoadVersionRef.current += 1;
    const previousSourceIdentity = chatSourceIdentityRef.current;
    const identityChanged =
      Boolean(previousSourceIdentity) &&
      Boolean(chatSourceIdentity) &&
      previousSourceIdentity !== chatSourceIdentity;

    if (!activeChatUrl) {
      setChatLoading(false);
      setChatSending(false);
      setChatError("");
      setChatQueue([]);
      shouldAutoScrollRef.current = true;
      chatRequestIdRef.current = "";
      chatTerminalEventSeenRef.current = false;
      chatLastActivityAtRef.current = 0;
      resetTransientState();
      if (identityChanged) {
        setChatSidebarContent(null);
        setChatSidebarMode("markdown");
        setChatAttachments([]);
      }
      return;
    }

    chatSourceIdentityRef.current = chatSourceIdentity;
    const cachedState = cloneCachedAssistantState(assistantViewStateCache.get(chatSourceIdentity));
    setChatQueue([]);
    shouldAutoScrollRef.current = true;
    setChatSidebarContent(null);
    setChatSidebarMode("markdown");

    if (cachedState && !identityChanged) {
      restoreCachedAssistantState(cachedState);
      void loadNativeChatHistory({ silent: true });
      return;
    }

    chatRequestIdRef.current = "";
    chatTerminalEventSeenRef.current = false;
    chatLastActivityAtRef.current = 0;
    setChatAttachments([]);
    resetTransientState();
    void loadNativeChatHistory();
  }, [activeChatUrl, chatSourceIdentity]);

  useEffect(() => {
    setAssistantModelDraft(currentDeploymentModelId);
  }, [currentDeploymentModelId, primaryDeployment?.id]);

  useEffect(() => {
    const nextDeploymentId =
      typeof primaryDeployment?.id === "string" ? primaryDeployment.id.trim() : "";
    const previousDeploymentId = activeSessionSelectionDeploymentIdRef.current;

    if (previousDeploymentId && previousDeploymentId !== nextDeploymentId) {
      persistStoredChatSessionKey(previousDeploymentId, chatSessionKey);
    }

    activeSessionSelectionDeploymentIdRef.current = nextDeploymentId;

    if (!nextDeploymentId) {
      setChatSessionKey("main");
      return;
    }

    const preferredSessionKey = resolveStoredChatSessionKey(nextDeploymentId, "main");
    setChatSessionKey((current) =>
      sessionKeysLikelyMatch(current, preferredSessionKey) ? current : preferredSessionKey,
    );
  }, [primaryDeployment?.id]);

  useEffect(() => {
    toolStreamRef.current.sessionKey = chatSessionKey;
  }, [chatSessionKey]);

  useEffect(() => {
    const deploymentId = activeSessionSelectionDeploymentIdRef.current;
    if (!deploymentId) {
      return;
    }

    persistStoredChatSessionKey(deploymentId, chatSessionKey);
  }, [chatSessionKey]);

  useEffect(() => {
    persistChatShowThinking(chatShowThinking);
  }, [chatShowThinking]);

  useEffect(() => {
    if (!isLocalDeployment || !primaryDeployment?.id || !canOpenNativeChat || !dashboardUrl) {
      return;
    }

    lastKnownLocalChatAccessRef.current = {
      deploymentId: primaryDeployment.id,
      dashboardUrl,
      browserControlUrl,
    };
  }, [browserControlUrl, canOpenNativeChat, dashboardUrl, isLocalDeployment, primaryDeployment?.id]);

  useEffect(() => {
    if (!threadRef.current) {
      return;
    }

    if (!shouldAutoScrollRef.current) {
      return;
    }

    const node = threadRef.current;
    const scrollToBottom = () => {
      node.scrollTop = node.scrollHeight;
      shouldAutoScrollRef.current = true;
    };

    const rafA = window.requestAnimationFrame(() => {
      scrollToBottom();
      window.requestAnimationFrame(scrollToBottom);
    });
    const timeout = window.setTimeout(scrollToBottom, 90);

    return () => {
      window.cancelAnimationFrame(rafA);
      window.clearTimeout(timeout);
    };
  }, [chatLoading, threadItems, chatSidebarContent]);

  useEffect(() => {
    if (
      canOpenNativeChat &&
      workspaceFeedback &&
      /云端连接已在后台建立|当前云端连接已经就绪|已切换到当前云端实例/.test(workspaceFeedback)
    ) {
      onClearWorkspaceFeedback?.();
    }
  }, [canOpenNativeChat, onClearWorkspaceFeedback, workspaceFeedback]);

  useEffect(() => {
    adjustComposerTextareaHeight(textareaRef.current);
  }, [chatDraft]);

  useEffect(
    () => () => {
      const latestState = cloneCachedAssistantState(latestAssistantStateRef.current);
      const sourceIdentity = latestState?.sourceIdentity?.trim() ?? "";
      if (sourceIdentity) {
        assistantViewStateCache.set(sourceIdentity, latestState);
      }
      speechRecognitionRef.current?.stop?.();
      clearRuntimeNotice();
      clearScheduledHistoryRefreshes();
    },
    [],
  );

  return (
    <section className="view view--assistant is-visible">
      <article className="chat-surface assistant-workspace">
        {workspaceError ? (
          <div className="inline-notice inline-notice--error">{workspaceError}</div>
        ) : null}
        {!workspaceError && workspaceFeedback ? (
          <div className="inline-notice inline-notice--info">{workspaceFeedback}</div>
        ) : null}
        {primaryDeployment ? (
          <>
            {canOpenNativeChat ? (
              <div className="assistant-native-chat">
                <div className={`chat-split-container${chatSidebarContent ? " chat-split-container--open" : ""}`}>
                  <div className="chat-main">
                    <div className="assistant-session-bar">
                      <div className="assistant-session-bar__meta">
                        <strong>{primaryDeployment?.name || "当前实例"}</strong>
                        <span>
                          {isLocalDeployment ? "本地部署" : "云端托管"}
                          {primaryDeployment?.status ? ` · ${primaryDeployment.status}` : ""}
                        </span>
                        <div className="assistant-session-bar__active-model">
                          <div className="assistant-session-bar__active-model-copy">
                            <span className="assistant-session-bar__active-model-label">
                              {modelSwitchPending ? "正在切换到" : "当前会话生效模型"}
                            </span>
                            <strong>{modelSwitchPending ? pendingDeploymentModelLabel : currentDeploymentModelLabel}</strong>
                          </div>
                          <div className="assistant-session-bar__active-model-badges">
                            <span className={`assistant-model-badge${modelSwitchPending ? " is-pending" : ""}`}>
                              {modelSwitchPending ? "切换中" : "已生效"}
                            </span>
                            <span className="assistant-model-badge assistant-model-badge--mono">
                              {modelSwitchPending ? assistantModelDraft : currentDeploymentModelId}
                            </span>
                          </div>
                        </div>
                      </div>
                      <label className="assistant-session-bar__model">
                        <span>会话</span>
                        <select
                          value={chatSessionKey}
                          onChange={handleChatSessionChange}
                          disabled={!activeChatUrl || chatSending || normalizedGatewaySessions.length === 0}
                        >
                          {normalizedGatewaySessions.map((item) => (
                            <option key={item.key} value={item.key}>
                              {formatGatewaySessionLabel(item)}
                            </option>
                          ))}
                        </select>
                        <span className="assistant-session-bar__model-hint">
                          当前聊天会直接绑定到这个 OpenClaw 会话。
                          {activeGatewaySession?.reasoningLevel
                            ? ` reasoning=${activeGatewaySession.reasoningLevel}`
                            : ""}
                          {activeGatewaySession?.thinkingLevel
                            ? ` · thinking=${activeGatewaySession.thinkingLevel}`
                            : chatThinkingLevel
                              ? ` · thinking=${chatThinkingLevel}`
                              : ""}
                        </span>
                      </label>
                      <label className="assistant-session-bar__model">
                        <span>模型</span>
                        <select
                          value={assistantModelDraft}
                          onChange={handleAssistantModelChange}
                          disabled={
                            !primaryDeployment ||
                            availableGatewayModels.length === 0 ||
                            chatSending ||
                            modelSwitchPending
                          }
                        >
                          {availableGatewayModels.map((item) => (
                            <option key={item.id} value={item.id}>
                              {formatGatewayModelLabel(item)}
                            </option>
                          ))}
                        </select>
                        <span className="assistant-session-bar__model-hint">
                          {modelSwitchPending
                            ? "正在切换当前会话模型，聊天入口会保持在当前实例上。"
                            : "这里显示的是当前会话实际使用的模型；切换不会重新部署本地 OpenClaw。"}
                        </span>
                      </label>
                    </div>
                    <div className="assistant-thread" ref={threadRef} onScroll={handleThreadScroll}>
                      {chatLoading ? (
                        <div className="assistant-thread__notice">正在加载聊天记录...</div>
                      ) : null}
                      {!chatLoading && chatMessages.length === 0 ? (
                        <div className="assistant-thread__notice">
                          可以直接开始聊天了。你的消息会发到当前 OpenClaw 会话：{activeGatewaySessionLabel}。
                        </div>
                      ) : null}
                      {threadItems.map((item) =>
                        renderChatThreadItem(item, {
                          onCopyText: copyChatText,
                          onOpenSidebar: handleOpenSidebar,
                        }),
                      )}
                    </div>

                    {chatQueue.length ? (
                      <div className="chat-queue" role="status" aria-live="polite">
                        <div className="chat-queue__title">Queued ({chatQueue.length})</div>
                        <div className="chat-queue__list">
                          {chatQueue.map((item) => (
                            <div className="chat-queue__item" key={item.id}>
                              <div className="chat-queue__text">
                                {item.text || (item.attachments?.length ? `Image (${item.attachments.length})` : "")}
                              </div>
                              <button
                                className="chat-queue__remove"
                                type="button"
                                aria-label="Remove queued message"
                                onClick={() => handleRemoveQueuedMessage(item.id)}
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="chat-compose">
                      <input
                        ref={fileInputRef}
                        className="assistant-file-input"
                        type="file"
                        accept={CHAT_IMAGE_ACCEPT}
                        multiple
                        onChange={(event) => void handleAttachmentChange(event)}
                      />
                      {chatError ? <div className="assistant-error">{chatError}</div> : null}
                      <AttachmentPreview
                        attachments={chatAttachments}
                        onRemove={(id) =>
                          setChatAttachments((current) => current.filter((entry) => entry.id !== id))
                        }
                      />
                      <div className="assistant-composer">
                        <label className="chat-compose__field">
                          <span>Message</span>
                          <textarea
                            ref={textareaRef}
                            className="assistant-textarea"
                            value={chatDraft}
                            placeholder={composePlaceholder}
                            dir="auto"
                            onChange={(event) => {
                              adjustComposerTextareaHeight(event.target);
                              setChatDraft(event.target.value);
                            }}
                            onPaste={(event) => void handleComposerPaste(event)}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") {
                                return;
                              }
                              if (event.isComposing || event.keyCode === 229) {
                                return;
                              }
                              if (event.shiftKey) {
                                return;
                              }
                              event.preventDefault();
                              void handleSendChat();
                            }}
                            disabled={!activeChatUrl}
                          />
                        </label>
                        <div className="assistant-composer__toolbar">
                          <div className="assistant-composer__toolbar-group">
                            <button
                              className="assistant-tool-button"
                              type="button"
                              title="添加图片"
                              aria-label="添加图片"
                              onClick={handleAttachmentPicker}
                              disabled={!activeChatUrl}
                            >
                              <ComposerIcon>
                                <PaperclipIcon />
                              </ComposerIcon>
                            </button>
                            <button
                              className={`assistant-tool-button${chatVoiceListening ? " is-active" : ""}`}
                              type="button"
                              title={chatVoiceListening ? "停止语音输入" : "语音输入"}
                              aria-label={chatVoiceListening ? "停止语音输入" : "语音输入"}
                              onClick={handleToggleVoiceInput}
                              disabled={!activeChatUrl}
                            >
                              <ComposerIcon>
                                <MicIcon />
                              </ComposerIcon>
                            </button>
                            <button
                              className={`assistant-tool-button${chatShowThinking ? " is-active" : ""}`}
                              type="button"
                              title={chatShowThinking ? "隐藏工作细节" : "显示工作细节"}
                              aria-label={chatShowThinking ? "隐藏工作细节" : "显示工作细节"}
                              onClick={handleToggleThinkingVisibility}
                              disabled={!activeChatUrl}
                            >
                              <ComposerIcon>
                                <BrainIcon />
                              </ComposerIcon>
                            </button>
                          </div>
                          <div className="assistant-composer__toolbar-group assistant-composer__toolbar-group--right">
                            <button
                              className="assistant-tool-button"
                              type="button"
                              title={canAbortChat ? "停止生成" : "新建会话"}
                              aria-label={canAbortChat ? "停止生成" : "新建会话"}
                              onClick={() =>
                                canAbortChat
                                  ? void handleAbortChat()
                                  : void handleSendChat("/new", { restoreDraft: true })
                              }
                              disabled={!activeChatUrl}
                            >
                              <ComposerIcon>
                                {canAbortChat ? <StopIcon /> : <PlusIcon />}
                              </ComposerIcon>
                            </button>
                            <button
                              className="assistant-tool-button"
                              type="button"
                              title="导出聊天记录为 Markdown"
                              aria-label="导出聊天记录为 Markdown"
                              onClick={() => void handleExportChatMarkdown()}
                              disabled={!activeChatUrl || (chatMessages.length === 0 && !getPendingChatStreamText())}
                            >
                              <ComposerIcon>
                                <UploadIcon />
                              </ComposerIcon>
                            </button>
                            <button
                              className={`assistant-send-button${chatSending ? " is-queueing" : ""}`}
                              type="button"
                              title={chatSending ? "加入发送队列" : "发送消息"}
                              aria-label={chatSending ? "加入发送队列" : "发送消息"}
                              onClick={() => void handleSendChat()}
                              disabled={!activeChatUrl}
                            >
                              <ComposerIcon>
                                <SendIcon />
                              </ComposerIcon>
                              {chatSending ? (
                                <span className="assistant-send-button__badge">
                                  {chatQueue.length + 1}
                                </span>
                              ) : null}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {chatSidebarContent ? (
                    <div className="chat-sidebar">
                      <MarkdownSidebar
                        content={chatSidebarContent}
                        mode={chatSidebarMode}
                        onChangeMode={setChatSidebarMode}
                        onClose={handleCloseSidebar}
                        onCopyText={copyChatText}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
                <div className="assistant-blocking-state">
                  <div className="bubble bubble--assistant">
                  {isLocalDeployment
                    ? modelSwitchPending
                      ? "正在切换当前会话模型，聊天入口恢复后会继续停留在这里。"
                      : "本地实例已经登记，但 OpenClaw 还没完全起来。修复后会自动恢复聊天入口。"
                    : needsTunnel
                      ? "这台云端实例会先在桌面端后台自动建立连接，连通后这里会直接进入聊天。"
                      : "当前实例还没准备出可用的聊天入口。"}
                </div>
                <div className="composer assistant-actions">
                  <button
                    className="primary-button small-cta"
                    onClick={handlePrimaryAction}
                    disabled={
                      isLocalDeployment
                        ? modelSwitchPending
                        : needsTunnel
                          ? !tunnelCommand || cloudConnectPending
                          : false
                    }
                  >
                    {isLocalDeployment
                      ? modelSwitchPending
                        ? "正在切换模型..."
                        : localActionLabel
                      : needsTunnel
                        ? cloudConnectPending
                          ? "正在连接云端..."
                          : "连接云端并开始聊天"
                        : "去管理部署"}
                  </button>
                  {!needsTunnel || isLocalDeployment ? (
                    <button
                      className="ghost-button small"
                      onClick={() => go("settings")}
                    >
                      管理部署
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="assistant-empty-state">
            <div className="bubble bubble--assistant">
              你当前还没有可用实例，所以这里不会再展示一整页说明。
            </div>
            <div className="bubble bubble--assistant">
              去设置页完成本地一键部署，或者开通一台云端实例。部署好之后，这里会直接变成聊天界面。
            </div>
            <div className="composer assistant-actions">
              <button className="primary-button small-cta" onClick={() => go("settings")}>
                去管理部署
              </button>
              <button className="ghost-button small" onClick={() => go("membership")}>
                先去充值
              </button>
            </div>
          </div>
        )}
      </article>
    </section>
  );
}

function MembershipView({
  wallet,
  usageSummary,
  deploymentSummaries,
  transactions,
  loading,
  error,
  topupAmount,
  setTopupAmount,
  topupPending,
  syncPending,
  onTopup,
  onRefresh,
}) {
  const totalRequestCount = deploymentSummaries.reduce((sum, item) => sum + item.requestCount, 0);
  const totalDeploymentCost = deploymentSummaries.reduce((sum, item) => sum + item.totalCostCny, 0);
  const activeCloudInstances = deploymentSummaries.filter((item) => item.status === "running").length;
  const selectedTopupAmount = Number(topupAmount || 0);

  return (
    <section className="view view--membership is-visible">
      {error ? <div className="inline-notice inline-notice--error">{error}</div> : null}
      {wallet && wallet.balanceCny <= 0 ? (
        <div className="inline-notice inline-notice--warn">
          当前余额不足，新的模型调用会被自动限制。先充值，再同步账单就能恢复。
        </div>
      ) : null}

      <div className="membership-grid">
        <article className="card">
          <div className="card-heading">
            <div>
              <div className="card-title">账单概览</div>
              <div className="card-subtitle">只保留余额、同步和最关键的今日统计。</div>
            </div>
            <div className="result-actions">
              <button className="ghost-button small" onClick={onRefresh} disabled={syncPending}>
                {syncPending ? "同步中..." : "同步账单"}
              </button>
            </div>
          </div>
          <div className="plan-grid plan-grid--stats">
            {[
              ["当前余额", formatCurrency(wallet?.balanceCny), "可用于继续调用"],
              ["今日费用", formatCurrency(usageSummary?.totalCostCny), "今日累计扣费"],
              ["在线实例", `${activeCloudInstances}`, "当前运行中的实例"],
              ["今日请求", formatNumber(totalRequestCount), "今天累计请求数"],
            ].map(([label, value, hint]) => (
              <article className="plan-card stat-plan-card" key={label}>
                <div className="plan-name">{label}</div>
                <div className="plan-price stat-plan-card__value">{value}</div>
                <div className="plan-list">
                  <div>{hint}</div>
                </div>
              </article>
            ))}
          </div>
          <div className="usage-footnote">
            今日实例费用合计 {formatCurrency(totalDeploymentCost)}，实际扣费会同步到当前余额。
          </div>
        </article>

        <article className="card balance-card">
          <div className="card-heading">
            <div>
              <div className="card-title">快速充值</div>
              <div className="card-subtitle">不再展示套餐推荐，直接输入金额充值。</div>
            </div>
          </div>
          <div className="quick-topup-grid">
            {QUICK_TOPUPS.map((amount) => (
              <button
                key={amount}
                className={`quick-topup ${selectedTopupAmount === amount ? "is-selected" : ""}`}
                onClick={() => setTopupAmount(String(amount))}
              >
                +{formatCurrency(amount)}
              </button>
            ))}
          </div>
          <div className="topup-form">
            <label className="field">
              <span>充值金额</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={topupAmount}
                onChange={(event) => setTopupAmount(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              onClick={() => onTopup(selectedTopupAmount)}
              disabled={topupPending || !selectedTopupAmount}
            >
              {topupPending ? "充值中..." : `充值 ${formatCurrency(selectedTopupAmount)}`}
            </button>
          </div>
        </article>
      </div>

      <article className="card">
        <div className="card-heading">
          <div>
            <div className="card-title">最近流水</div>
            <div className="card-subtitle">这里只保留充值、扣费和调整记录。</div>
          </div>
        </div>
        <div className="transaction-list">
          {(transactions.length ? transactions : [{ id: "empty", title: "暂时还没有流水", amountCny: 0, createdAt: new Date().toISOString(), type: "topup" }]).map((item) => (
            <div className="transaction-item" key={item.id}>
              <div>
                <div className="transaction-item__title">{item.title}</div>
                <div className="transaction-item__meta">{formatDateTime(item.createdAt)}</div>
              </div>
              <div
                className={`transaction-item__amount ${
                  item.amountCny >= 0 ? "is-positive" : "is-negative"
                }`}
              >
                {item.amountCny >= 0 ? "+" : ""}
                {formatCurrency(item.amountCny)}
              </div>
            </div>
          ))}
        </div>
        {loading ? <div className="section-note">正在刷新线上账单数据...</div> : null}
      </article>
    </section>
  );
}

function SettingsView({
  currentUser,
  deployments,
  modelCatalog,
  wallet,
  syncing,
  onRefresh,
  currentScopeId,
  createForm,
  onFormChange,
  onInstanceTypeChange,
  createPending,
  createError,
  createResult,
  createDiagnostics,
  onCreate,
  createFeedback,
  operationNotice,
  onOpenExternal,
  onCopyText,
  onLaunchTunnel,
  onConnectCloudChat,
  onStopTunnel,
  onGoAssistant,
  onGoMembership,
  cloudConnectPending,
  actionPendingId,
  actionPendingType,
  onDeploymentAction,
  onDeploymentModelChange,
  profileForm,
  profilePending,
  profileError,
  passwordForm,
  passwordPending,
  passwordError,
  onProfileFieldChange,
  onPasswordFieldChange,
  onProfileSave,
  onPasswordSave,
  sshPasswordDrafts,
  onDeploymentPasswordDraftChange,
  onDeploymentPasswordSave,
  onDeploymentPasswordClear,
  tunnelStatus,
  localDeploymentForm,
  onLocalDeploymentFormChange,
  localRuntimeStatus,
  localDeployPending,
  localCredentialPending,
  localDeployError,
  localDeployFeedback,
  localDeployResult,
  onCreateLocalDeployment,
  onSyncLocalApiKey,
  onClearLocalApiKey,
  onRepairLocalDeployment,
  onBulkRefreshNativeResponses,
  onUninstallLocalDeployment,
  localClearKeyOnLogout,
  onToggleLocalClearKeyOnLogout,
}) {
  const visibleDeployments = useMemo(
    () => resolveDesktopVisibleDeployments(deployments, localRuntimeStatus),
    [deployments, localRuntimeStatus],
  );
  const hiddenForeignLocalDeploymentCount = useMemo(
    () => countHiddenDesktopForeignLocalDeployments(deployments, localRuntimeStatus),
    [deployments, localRuntimeStatus],
  );
  const availableGatewayModels = useMemo(
    () => normalizeGatewayModelCatalog(modelCatalog),
    [modelCatalog],
  );
  const groupedGatewayModels = useMemo(() => {
    const groups = new Map();
    for (const item of availableGatewayModels) {
      const groupName = formatGatewayModelGroupName(item);
      const existing = groups.get(groupName);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(groupName, [item]);
      }
    }
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
  }, [availableGatewayModels]);
  const desktopPlatform = getDesktopPlatform();
  const localDeployment = findLocalDeployment(deployments, localRuntimeStatus);
  const activeActionDeployment = actionPendingId
    ? visibleDeployments.find((item) => item.id === actionPendingId)
    : null;
  const createAccess = createResult?.deployment?.access ?? null;
  const createPublicIp = createResult?.deployment?.publicIpAddress?.[0] ?? "";
  const derivedTunnelCommand = getNormalizedTunnelCommand(
    createPublicIp
      ? `ssh -N -L ${CLOUD_TUNNEL_DASHBOARD_PORT}:127.0.0.1:18789 -L ${CLOUD_TUNNEL_BROWSER_CONTROL_PORT}:127.0.0.1:18791 root@${createPublicIp}`
      : createAccess?.sshTunnel ?? "",
  );
  const localDashboardUrl = buildCloudTunnelDashboardUrl(createAccess?.dashboardUrl ?? "");
  const createTunnelReady = isTunnelReadyForHost(tunnelStatus, createPublicIp);
  const walletBalance = typeof wallet?.balanceCny === "number" ? wallet.balanceCny : 0;
  const createBlockedByBalance = walletBalance <= 0;
  const lowBalanceWarning = walletBalance > 0 && walletBalance < 10;
  const currentUserId = resolveUserId(currentUser);
  const runningCloudDeploymentCount = visibleDeployments.filter(
    (item) => item.mode === "cloud" && resolveEffectiveDeploymentStatus(item, localRuntimeStatus) === "running",
  ).length;
  const localAuthOwnerLabel = formatLocalAuthOwner(localRuntimeStatus);
  const localAuthOwnerMatchesCurrentUser = currentUserId
    ? localRuntimeStatus?.ownerUserId
      ? localRuntimeStatus.ownerUserId === currentUserId
      : Boolean(currentScopeId) &&
        (localRuntimeStatus?.ownerAccountScopeId || localRuntimeStatus?.workspaceId || "") ===
          currentScopeId
    : false;
  const localAuthMatchesCurrentAccount =
    Boolean(localRuntimeStatus?.localApiKeyConfigured) &&
    (currentUserId
      ? localAuthOwnerMatchesCurrentUser
      : Boolean(currentScopeId) &&
        (localRuntimeStatus?.ownerAccountScopeId || localRuntimeStatus?.workspaceId || "") ===
          currentScopeId);
  const localIsolationMessage =
    localRuntimeStatus?.localApiKeyConfigured &&
    ((currentUserId &&
      localRuntimeStatus?.ownerUserId &&
      localRuntimeStatus.ownerUserId !== currentUserId) ||
      (!currentUserId &&
        (localRuntimeStatus?.ownerAccountScopeId || localRuntimeStatus?.workspaceId) &&
        currentScopeId &&
        (localRuntimeStatus.ownerAccountScopeId || localRuntimeStatus.workspaceId) !== currentScopeId))
      ? `当前本地实例仍在使用其他账号的本地 API Key（${localAuthOwnerLabel}）。登录后会自动同步；如果还没切过来，可以手动同步。`
      : localRuntimeStatus?.ready && !localRuntimeStatus?.localApiKeyConfigured
        ? "当前本地 OpenClaw 正在运行，但本地 API Key 已被清空。登录后会自动补回，也可以手动同步。"
      : localRuntimeStatus?.ready &&
          !localRuntimeStatus?.ownerUserId &&
          !localRuntimeStatus?.ownerAccountScopeId &&
          !localRuntimeStatus?.workspaceId
        ? "当前本地实例缺少账号归属。建议先同步本地 API Key，必要时再修复本地部署。"
        : "";
  const localBootstrapLogPath =
    localDeployResult?.bootstrap?.logPath ??
    localDeployment?.metadata?.logPath ??
    localRuntimeStatus?.logPath ??
    (desktopPlatform === "win32"
      ? "%LOCALAPPDATA%\\Xiaolanbu\\logs\\local-bootstrap.log"
      : "~/Library/Logs/Xiaolanbu/local-bootstrap.log");
  const localRuntimeStageMessage =
    localRuntimeStatus?.bootstrapMessage ||
    (localRuntimeStatus?.ready
      ? "本地控制台已就绪。"
      : localRuntimeStatus?.installed
        ? "运行时已安装，等待初始化。"
        : "尚未安装 OpenClaw 运行时。");
  const localDeployButtonLabel = localDeployPending
    ? localRuntimeStatus?.bootstrapStage === "runtime-download"
      ? typeof localRuntimeStatus?.bootstrapProgressPercent === "number"
        ? `下载运行时中 ${localRuntimeStatus.bootstrapProgressPercent}%`
        : "下载运行时中..."
      : localRuntimeStatus?.bootstrapStage === "onboarding"
        ? "初始化中..."
        : localRuntimeStatus?.bootstrapStage === "service-start"
          ? "启动控制台中..."
          : "部署中..."
    : "立即部署到本机";
  const canRepairLocalDeployment =
    Boolean(localDeployment) ||
    Boolean(localRuntimeStatus?.installed) ||
    Boolean(localRuntimeStatus?.ready) ||
    Boolean(localRuntimeStatus?.dashboardPortOpen) ||
    Boolean(localRuntimeStatus?.browserControlPortOpen) ||
    Boolean(localRuntimeStatus?.deploymentId);

  return (
    <section className="view view--settings is-visible">
      <div className="settings-layout">
        <article className="card settings-card settings-card--account">
          <div className="card-heading">
            <div>
              <div className="card-title">账号与安全</div>
              <div className="card-subtitle">更新昵称和登录密码，这些是用户侧最常用的基础设置。</div>
            </div>
          </div>
          <div className="settings-account-layout">
            <section className="settings-subsection">
              <div className="settings-subsection__head">
                <div className="settings-subsection__title">资料信息</div>
                <div className="settings-subsection__desc">邮箱只读展示，昵称可以直接更新。</div>
              </div>
              <div className="create-grid">
                <label className="field">
                  <span>当前邮箱</span>
                  <input type="email" value={currentUser?.email ?? ""} disabled />
                </label>
                <label className="field">
                  <span>昵称</span>
                  <input
                    type="text"
                    value={profileForm.displayName}
                    onChange={(event) => onProfileFieldChange("displayName", event.target.value)}
                    placeholder="修改你在小懒布里的显示名称"
                  />
                </label>
              </div>
              <div className="settings-subsection__actions">
                <button className="primary-button small" onClick={onProfileSave} disabled={profilePending}>
                  {profilePending ? "保存中..." : "保存昵称"}
                </button>
              </div>
              {profileError ? <div className="inline-notice inline-notice--error">{profileError}</div> : null}
            </section>

            <section className="settings-subsection">
              <div className="settings-subsection__head">
                <div className="settings-subsection__title">登录密码</div>
                <div className="settings-subsection__desc">修改后会立即应用到当前账号。</div>
              </div>
              <div className="create-grid create-grid--triple">
                <label className="field">
                  <span>当前密码</span>
                  <input
                    type="password"
                    value={passwordForm.currentPassword}
                    onChange={(event) => onPasswordFieldChange("currentPassword", event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>新密码</span>
                  <input
                    type="password"
                    value={passwordForm.newPassword}
                    onChange={(event) => onPasswordFieldChange("newPassword", event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>确认新密码</span>
                  <input
                    type="password"
                    value={passwordForm.confirmPassword}
                    onChange={(event) => onPasswordFieldChange("confirmPassword", event.target.value)}
                  />
                </label>
              </div>
              <div className="settings-subsection__actions">
                <button className="ghost-button small" onClick={onPasswordSave} disabled={passwordPending}>
                  {passwordPending ? "更新中..." : "更新密码"}
                </button>
              </div>
              {passwordError ? <div className="inline-notice inline-notice--error">{passwordError}</div> : null}
            </section>
          </div>
        </article>

        <article className="card settings-card settings-card--local">
          <div className="card-heading">
            <div>
              <div className="card-title">一键部署到本机</div>
              <div className="card-subtitle">
                小懒布会在你的电脑上安装并初始化 OpenClaw，本地运行控制台，模型调用仍然走你的线上网关计费。
              </div>
            </div>
            <button
              className="primary-button small"
              onClick={onCreateLocalDeployment}
              disabled={localDeployPending}
            >
              {localDeployButtonLabel}
            </button>
          </div>

          {localDeployError ? (
            <div className="inline-notice inline-notice--error">{localDeployError}</div>
          ) : null}
          {localIsolationMessage ? (
            <div className="inline-notice inline-notice--warn">{localIsolationMessage}</div>
          ) : null}
          {localDeployPending && localRuntimeStageMessage ? (
            <div className="inline-notice inline-notice--info">{localRuntimeStageMessage}</div>
          ) : null}
          {localDeployFeedback ? (
            <div className="inline-notice inline-notice--info">{localDeployFeedback}</div>
          ) : null}

          <div className="create-grid">
            <label className="field">
              <span>本地实例名称</span>
              <input
                type="text"
                value={localDeploymentForm.name}
                onChange={(event) => onLocalDeploymentFormChange("name", event.target.value)}
                placeholder="例如：我的本地助手"
              />
            </label>
            <label className="field">
              <span>OpenClaw 模型</span>
              <select
                value={localDeploymentForm.modelId}
                onChange={(event) => onLocalDeploymentFormChange("modelId", event.target.value)}
              >
                {groupedGatewayModels.map((group) => (
                  <optgroup key={`local-model-group-${group.label}`} label={group.label}>
                    {group.items.map((item) => (
                      <option key={`local-model-${item.id}`} value={item.id}>
                        {item.id}
                        {item.isDefault ? " · 默认" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="field">
              <span>运行时状态</span>
              <input
                type="text"
                value={localRuntimeStageMessage}
                disabled
              />
            </label>
          </div>

          <div className="pref-list">
            <div className="pref-row">
              <span>本地网关</span>
              <strong>{localRuntimeStatus.dashboardPortOpen ? "127.0.0.1:18789 已连通" : "127.0.0.1:18789 待启动"}</strong>
            </div>
            <div className="pref-row">
              <span>本地运行时</span>
              <strong>
                {localRuntimeStatus.installed
                  ? `${localRuntimeStatus.binaryPath || "openclaw"}${localRuntimeStatus.version ? ` · ${localRuntimeStatus.version}` : ""}`
                  : "尚未检测到 OpenClaw"}
              </strong>
            </div>
            <div className="pref-row">
              <span>本地认证状态</span>
              <strong>
                {localRuntimeStatus.localApiKeyConfigured
                  ? localAuthMatchesCurrentAccount
                    ? "已配置，且与当前账号一致"
                    : "已配置"
                  : "未配置 / 已清除"}
              </strong>
            </div>
            <div className="pref-row">
              <span>当前本地 Key 归属</span>
              <strong>{localAuthOwnerLabel}</strong>
            </div>
            {localRuntimeStatus?.authSyncedAt ? (
              <div className="pref-row">
                <span>最近同步时间</span>
                <strong>{formatDateTime(localRuntimeStatus.authSyncedAt)}</strong>
              </div>
            ) : null}
            <div className="pref-row">
              <span>日志路径</span>
              <strong>{localBootstrapLogPath}</strong>
            </div>
            {localRuntimeStatus?.bootstrapLastLine ? (
              <div className="pref-row">
                <span>最近进度</span>
                <strong>{localRuntimeStatus.bootstrapLastLine}</strong>
              </div>
            ) : null}
          </div>

          <div className="toggle-group">
            <button
              type="button"
              className="toggle-item"
              onClick={() => onToggleLocalClearKeyOnLogout(!localClearKeyOnLogout)}
            >
              <div>
                <strong>退出登录时自动清除本地 API Key</strong>
                <span>适合多人共用一台电脑；开启后，重新登录会自动重新同步当前账号。</span>
              </div>
              <div
                className={`toggle-indicator ${localClearKeyOnLogout ? "" : "toggle-indicator--off"}`}
              ></div>
            </button>
          </div>

          <div className="result-actions">
            <button
              className="ghost-button small"
              onClick={() => onOpenExternal(localDeployment?.access?.dashboardUrl ?? "http://127.0.0.1:18789")}
              disabled={!localRuntimeStatus.dashboardPortOpen}
            >
              打开本地控制台
            </button>
            <button
              className="ghost-button small"
              onClick={() => onCopyText(localBootstrapLogPath, "日志路径已复制")}
            >
              复制日志路径
            </button>
            <button
              className="ghost-button small"
              onClick={() => onSyncLocalApiKey(localDeployment)}
              disabled={localDeployPending || localCredentialPending}
            >
              {localCredentialPending ? "处理中..." : "同步本地 API Key"}
            </button>
            <button
              className="ghost-button small"
              onClick={onClearLocalApiKey}
              disabled={localDeployPending || localCredentialPending}
            >
              {localCredentialPending ? "处理中..." : "清除本地 API Key"}
            </button>
            <button
              className="ghost-button small"
              onClick={() => onRepairLocalDeployment(localDeployment)}
              disabled={localDeployPending || localCredentialPending || !canRepairLocalDeployment}
            >
              修复本地部署
            </button>
            <button
              className="ghost-button small"
              onClick={() => onUninstallLocalDeployment(localDeployment)}
              disabled={localDeployPending || localCredentialPending}
            >
              卸载本地 OpenClaw
            </button>
          </div>
        </article>

        <article className="card settings-card settings-card--cloud-create">
          <div className="card-heading">
            <div>
              <div className="card-title">开通云端实例</div>
              <div className="card-subtitle">
                用户只需要填写实例名称和登录密码，小懒布会按香港地域的默认资源自动完成创建，并按规格顺序兜底重试。
              </div>
            </div>
            <button className="primary-button small" onClick={onCreate} disabled={createPending || createBlockedByBalance}>
              {createPending ? "创建中..." : createBlockedByBalance ? "请先充值" : "立即开通"}
            </button>
          </div>

          {createBlockedByBalance ? (
            <div className="inline-notice inline-notice--warn">
              <strong>当前余额不足，暂时无法开通新的云端实例。</strong>
              <span>云端实例开通后会持续产生托管和模型调用费用，建议先充值再继续。</span>
              <div className="inline-notice__actions">
                <button className="primary-button small" onClick={onGoMembership}>
                  去会员与充值
                </button>
              </div>
            </div>
          ) : null}
          {lowBalanceWarning ? (
            <div className="inline-notice inline-notice--warn">
              <strong>当前余额偏低：¥{walletBalance.toFixed(2)}</strong>
              <span>可以继续开通实例，但建议先补充余额，避免实例创建后很快因为余额不足而被限制调用。</span>
            </div>
          ) : null}
          {operationNotice ? (
            <div className="inline-notice inline-notice--info">
              <strong>{operationNotice.title}</strong>
              <span>{operationNotice.body}</span>
            </div>
          ) : null}
          {createError ? <div className="inline-notice inline-notice--error">{createError}</div> : null}
          {createResult ? (
            <div className="inline-notice inline-notice--success">
              已创建实例 {createResult.deployment?.name}，公网 IP {createResult.deployment?.publicIpAddress?.[0] ?? "--"}。
            </div>
          ) : null}

          <div className="create-grid">
            <label className="field">
              <span>实例名称</span>
              <input
                type="text"
                value={createForm.name}
                onChange={(event) => onFormChange("name", event.target.value)}
                placeholder="例如：客服值守"
              />
            </label>
            <label className="field">
              <span>实例登录密码</span>
              <input
                type="password"
                value={createForm.password}
                onChange={(event) => onFormChange("password", event.target.value)}
                placeholder="用于桌面端后台自动连接云端实例"
              />
            </label>
            <label className="field">
              <span>地域</span>
              <input type="text" value={createForm.region} onChange={(event) => onFormChange("region", event.target.value)} />
            </label>
            <label className="field">
              <span>默认模型</span>
              <select
                value={createForm.modelId}
                onChange={(event) => onFormChange("modelId", event.target.value)}
              >
                {groupedGatewayModels.map((group) => (
                  <optgroup key={`cloud-model-group-${group.label}`} label={group.label}>
                    {group.items.map((item) => (
                      <option key={`cloud-model-${item.id}`} value={item.id}>
                        {item.id}
                        {item.isDefault ? " · 默认" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="field">
              <span>公网带宽(Mbps)</span>
              <input
                type="number"
                min="0"
                step="1"
                value={createForm.internetMaxBandwidthOut}
                onChange={(event) => onFormChange("internetMaxBandwidthOut", event.target.value)}
              />
            </label>
          </div>

          <div className="create-instance-types">
            <div className="create-section-title">实例规格兜底顺序</div>
            <div className="create-grid create-grid--triple">
              {createForm.instanceTypes.map((instanceType, index) => (
                <label className="field" key={`instance-type-${index}`}>
                  <span>第 {index + 1} 选择</span>
                  <input
                    type="text"
                    value={instanceType}
                    onChange={(event) => onInstanceTypeChange(index, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="create-grid create-grid--advanced">
            <label className="field">
              <span>镜像 ID</span>
              <input type="text" value={createForm.imageId} onChange={(event) => onFormChange("imageId", event.target.value)} />
            </label>
            <label className="field">
              <span>安全组 ID</span>
              <input
                type="text"
                value={createForm.securityGroupId}
                onChange={(event) => onFormChange("securityGroupId", event.target.value)}
              />
            </label>
            <label className="field">
              <span>交换机 ID</span>
              <input type="text" value={createForm.vSwitchId} onChange={(event) => onFormChange("vSwitchId", event.target.value)} />
            </label>
          </div>

          {createPending ? (
            <div className="create-progress-card">
              <div className="create-section-title">创建进度</div>
              <div className="progress-line">
                <div className="progress-line__item is-active">
                  <strong>提交资源申请</strong>
                  <span>正在向阿里云提交实例创建请求。</span>
                </div>
                <div className="progress-line__item is-active">
                  <strong>按规格自动兜底</strong>
                  <span>{createForm.instanceTypes.filter(Boolean).join(" → ")}</span>
                </div>
                <div className="progress-line__item">
                  <strong>等待实例 Running</strong>
                  <span>预计需要 20 到 90 秒，期间会自动刷新状态。</span>
                </div>
                <div className="progress-line__item">
                  <strong>启动 OpenClaw 网关</strong>
                  <span>实例准备好后，桌面端会自动接管云端连接并准备聊天入口。</span>
                </div>
              </div>
            </div>
          ) : null}

          {createDiagnostics?.length ? (
            <div className="create-trace-card">
              <div className="create-section-title">规格尝试轨迹</div>
              <div className="trace-list">
                {createDiagnostics.map((item, index) => (
                  <div className="trace-item" key={`${item.instanceType}-${index}`}>
                    <div className={`trace-item__dot ${item.status === "success" ? "is-success" : "is-error"}`}></div>
                    <div className="trace-item__copy">
                      <strong>{item.instanceType}</strong>
                      <span>
                        {item.status === "success"
                          ? `创建成功${item.requestId ? ` · 请求号 ${item.requestId}` : ""}`
                          : item.message ?? "尝试失败"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="create-result-card">
            <div className="create-section-title">创建结果与后续操作</div>
            <div className="pref-list">
              <div className="pref-row">
                <span>公网 IP</span>
                <strong>{createPublicIp || "--"}</strong>
              </div>
              <div className="pref-row">
                <span>连接方式</span>
                <strong>桌面端后台自动建立云端连接</strong>
              </div>
              <div className="pref-row">
                <span>聊天入口</span>
                <strong>{createTunnelReady ? "已就绪，可直接进入聊天" : "点击后自动连接并进入聊天"}</strong>
              </div>
              <div className="pref-row">
                <span>最终规格</span>
                <strong>{createResult?.deployment?.metadata?.instanceType ?? "--"}</strong>
              </div>
              <div className="pref-row">
                <span>等待耗时</span>
                <strong>
                  {createResult?.wait?.waitedMs ? `${Math.round(createResult.wait.waitedMs / 1000)} 秒` : "--"}
                </strong>
              </div>
              <div className="pref-row">
                <span>请求编号</span>
                <strong>{createResult?.vendor?.requestId ?? "--"}</strong>
              </div>
            </div>
            <div className="result-actions">
              <button
                className="primary-button small"
                onClick={() =>
                  createTunnelReady
                    ? onGoAssistant(createResult?.deployment?.id)
                    : onConnectCloudChat(derivedTunnelCommand, createResult?.deployment?.id)
                }
                disabled={createTunnelReady ? false : !derivedTunnelCommand || cloudConnectPending}
              >
                {createTunnelReady
                  ? "进入聊天"
                  : cloudConnectPending
                    ? "正在连接云端..."
                    : "连接云端并开始聊天"}
              </button>
              <button
                className="ghost-button small"
                onClick={() => onOpenExternal(localDashboardUrl)}
                disabled={!localDashboardUrl || !createTunnelReady}
              >
                打开本地控制台
              </button>
              <button
                className="ghost-button small"
                onClick={() => onCopyText(createPublicIp, "公网 IP 已复制")}
                disabled={!createPublicIp}
              >
                复制公网 IP
              </button>
              <button
                className="ghost-button small"
                onClick={() => onCopyText(createResult?.vendor?.requestId ?? "", "请求编号已复制")}
                disabled={!createResult?.vendor?.requestId}
              >
                复制请求号
              </button>
            </div>
            {!createAccess ? (
              <div className="section-note">实例创建成功后，上面的入口会自动解锁，不需要再额外找按钮。</div>
            ) : null}
            {createFeedback ? <div className="section-note">{createFeedback}</div> : null}
          </div>
        </article>

        <article className="card settings-card settings-card--instances">
          <div className="card-heading">
            <div>
              <div className="card-title">当前实例</div>
              <div className="card-subtitle">看看现在有哪些云端实例、它们是否在线，以及控制入口在哪里。</div>
            </div>
            <button
              className="ghost-button small"
              onClick={onBulkRefreshNativeResponses}
              disabled={actionPendingId != null || runningCloudDeploymentCount === 0}
            >
              {actionPendingId === BULK_REFRESH_NATIVE_RESPONSES_ACTION_ID
                ? "刷新中..."
                : "批量刷新原生 Responses"}
            </button>
          </div>
          {hiddenForeignLocalDeploymentCount > 0 ? (
            <div className="section-note">
              已隐藏 {hiddenForeignLocalDeploymentCount} 条来自其他设备的本地实例记录，避免干扰当前这台电脑的本地部署入口。
            </div>
          ) : null}
          <div className="deployment-grid">
            {visibleDeployments.length === 0 ? (
              <div className="section-note">
                当前这台电脑还没有可直接使用的实例。你可以直接一键部署到本机，或者先创建云端实例。
              </div>
            ) : visibleDeployments.map((deployment) => {
              const deploymentPublicIp = deployment.publicIpAddress?.[0] ?? "";
              const deploymentDashboardUrl = deployment.access?.dashboardUrl ?? deployment.consoleUrl ?? "";
              const deploymentEffectiveStatus = resolveEffectiveDeploymentStatus(
                deployment,
                localRuntimeStatus,
              );
              const currentDeviceLocalDeployment =
                deployment.mode === "local" &&
                isCurrentDeviceLocalDeployment(deployment, localRuntimeStatus);
              const foreignDeviceLocalDeployment =
                deployment.mode === "local" &&
                isForeignDeviceLocalDeployment(deployment, localRuntimeStatus);
              const foreignDeviceLabel =
                resolveLocalDeploymentDeviceLabel(deployment) ||
                resolveLocalDeploymentDeviceId(deployment) ||
                "另一台设备";
              const deploymentLocalDashboardUrl =
                deployment.mode === "cloud"
                  ? buildCloudTunnelDashboardUrl(deploymentDashboardUrl)
                  : deploymentDashboardUrl || "http://127.0.0.1:18789";
              const deploymentTunnelCommand = getNormalizedTunnelCommand(
                deploymentPublicIp
                  ? `ssh -N -L ${CLOUD_TUNNEL_DASHBOARD_PORT}:127.0.0.1:18789 -L ${CLOUD_TUNNEL_BROWSER_CONTROL_PORT}:127.0.0.1:18791 root@${deploymentPublicIp}`
                  : deployment.access?.sshTunnel ?? "",
              );
              const deploymentTunnelReady =
                deployment.mode === "local"
                  ? currentDeviceLocalDeployment && Boolean(localRuntimeStatus?.dashboardPortOpen)
                  : isTunnelReadyForHost(tunnelStatus, deploymentPublicIp);
              const deploymentStoredPassword = getStoredSshPassword(deploymentPublicIp);
              const deploymentPasswordDraft =
                sshPasswordDrafts[deployment.id] ?? deploymentStoredPassword;
              const localDeploymentReady =
                deployment.mode === "local" &&
                currentDeviceLocalDeployment &&
                Boolean(localRuntimeStatus?.ready);
              const deploymentModeLabel =
                deployment.mode === "cloud"
                  ? "云端托管"
                  : foreignDeviceLocalDeployment
                    ? "本地部署（其他设备）"
                    : "本地部署（当前设备）";
              const deploymentStatusLabel =
                deploymentEffectiveStatus === "running"
                  ? "运行中"
                  : deploymentEffectiveStatus === "stopped"
                    ? "已停止"
                    : deploymentEffectiveStatus || "--";
              const deploymentAddressLabel =
                deployment.mode === "cloud" ? "公网 IP" : "本地网关";
              const deploymentAddressValue =
                deployment.mode === "cloud"
                  ? deploymentPublicIp || "--"
                  : currentDeviceLocalDeployment && localRuntimeStatus.dashboardPortOpen
                    ? "127.0.0.1:18789"
                    : foreignDeviceLocalDeployment
                      ? `${foreignDeviceLabel} 上的本地实例`
                      : "127.0.0.1:18789 待启动";
              const deploymentEntryValue =
                deployment.mode === "local"
                  ? currentDeviceLocalDeployment
                    ? deploymentDashboardUrl || "http://127.0.0.1:18789"
                    : "仅可在对应设备本地使用"
                  : deploymentLocalDashboardUrl;
              const deploymentModelId = resolveDeploymentGatewayModelId(
                deployment,
                resolveDefaultGatewayModelId(availableGatewayModels),
              );
              const deploymentModelSwitchPending =
                actionPendingId === deployment.id && actionPendingType === "switchModel";

              return (
                <div className="deployment-card" key={deployment.id}>
                  <div className="deployment-card__head">
                    <strong>{deployment.name}</strong>
                    <span
                      className={`deployment-badge ${
                        deploymentEffectiveStatus === "running" ? "is-running" : ""
                      }`}
                    >
                      {deploymentEffectiveStatus || deployment.status}
                    </span>
                  </div>
                  {activeActionDeployment?.id === deployment.id ? (
                    <div className="deployment-card__status">
                      正在执行实例操作，界面会自动刷新到最新状态。
                    </div>
                  ) : foreignDeviceLocalDeployment ? (
                    <div className="deployment-card__status">
                      这条本地部署属于 {foreignDeviceLabel}，当前这台电脑不会直接接管它。
                    </div>
                  ) : null}
                  <div className="deployment-meta-grid">
                    <div className="deployment-meta-card">
                      <span className="deployment-meta-card__label">模式</span>
                      <strong className="deployment-meta-card__value">{deploymentModeLabel}</strong>
                    </div>
                    <div className="deployment-meta-card">
                      <span className="deployment-meta-card__label">状态</span>
                      <strong className="deployment-meta-card__value">{deploymentStatusLabel}</strong>
                    </div>
                    <div className="deployment-meta-card">
                      <span className="deployment-meta-card__label">{deploymentAddressLabel}</span>
                      <strong className="deployment-meta-card__value">{deploymentAddressValue}</strong>
                    </div>
                    <div className="deployment-meta-card">
                      <span className="deployment-meta-card__label">控制入口</span>
                      <strong className="deployment-meta-card__value">{deploymentEntryValue}</strong>
                    </div>
                  </div>
                  <div className="deployment-model-row">
                    <label className="field deployment-model-field">
                      <span>当前模型</span>
                      <select
                        value={deploymentModelId}
                        onChange={(event) => onDeploymentModelChange(deployment, event.target.value)}
                        disabled={
                          deploymentModelSwitchPending ||
                          availableGatewayModels.length === 0 ||
                          deploymentEffectiveStatus !== "running" ||
                          foreignDeviceLocalDeployment
                        }
                      >
                        {availableGatewayModels.map((item) => (
                          <option key={item.id} value={item.id}>
                            {formatGatewayModelLabel(item)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="deployment-model-row__hint">
                      {deploymentModelSwitchPending
                        ? deployment.mode === "local"
                          ? "正在切换当前会话模型..."
                          : "正在切换实例模型..."
                        : deployment.mode === "local"
                          ? foreignDeviceLocalDeployment
                            ? "这条本地部署属于其他设备，当前机器不能直接切换它。"
                            : "切换后会直接更新当前聊天会话模型，不会重启本地 OpenClaw。"
                          : "切换后会由后端把当前实例切到对应模型。"}
                    </div>
                  </div>
                  {deployment.mode === "cloud" && deploymentPublicIp ? (
                    <div className="member-invite deployment-password-box">
                      <label className="field">
                        <span>云端连接密码</span>
                        <input
                          type="password"
                          value={deploymentPasswordDraft}
                          onChange={(event) =>
                            onDeploymentPasswordDraftChange(deployment.id, event.target.value)
                          }
                          placeholder={
                            deploymentStoredPassword
                              ? "已记录，可直接更新"
                              : "补录一次，后续连接云端会自动完成"
                          }
                        />
                      </label>
                      <div className="result-actions">
                        <button
                          className="ghost-button small"
                          onClick={() => onDeploymentPasswordSave(deployment.id, deploymentPublicIp)}
                          disabled={!deploymentPasswordDraft.trim()}
                        >
                          保存密码
                        </button>
                        <button
                          className="ghost-button small"
                          onClick={() => onDeploymentPasswordClear(deployment.id, deploymentPublicIp)}
                          disabled={!deploymentStoredPassword}
                        >
                          清除连接密码
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className="deployment-action-groups">
                    <section className="deployment-action-group">
                      <div className="deployment-action-group__title">进入</div>
                      <div className="result-actions">
                        <button
                          className="primary-button small"
                          onClick={() =>
                            deployment.mode === "local"
                              ? onGoAssistant(deployment.id)
                              : deploymentTunnelReady
                                ? onGoAssistant(deployment.id)
                                : onConnectCloudChat(deploymentTunnelCommand, deployment.id)
                          }
                          disabled={
                            deployment.mode === "local"
                              ? !localDeploymentReady || foreignDeviceLocalDeployment
                              : deploymentTunnelReady
                                ? false
                                : !deploymentTunnelCommand || cloudConnectPending
                          }
                        >
                          {deployment.mode === "local"
                            ? localDeploymentReady
                              ? "进入聊天"
                              : "等待本地部署完成"
                            : deploymentTunnelReady
                              ? "进入聊天"
                              : cloudConnectPending
                                ? "正在连接云端..."
                                : "连接云端并开始聊天"}
                        </button>
                        <button
                          className="ghost-button small"
                          onClick={() =>
                            onOpenExternal(
                              deployment.mode === "local"
                                ? deploymentDashboardUrl
                                : deploymentLocalDashboardUrl,
                            )
                          }
                          disabled={
                            deployment.mode === "local"
                              ? !deploymentDashboardUrl ||
                                !localDeploymentReady ||
                                foreignDeviceLocalDeployment
                              : !deploymentLocalDashboardUrl || !deploymentTunnelReady
                          }
                        >
                          打开控制台
                        </button>
                      </div>
                    </section>

                    {deployment.mode === "cloud" ? (
                      <>
                        <section className="deployment-action-group">
                          <div className="deployment-action-group__title">维护</div>
                          <div className="result-actions">
                            <button
                              className="ghost-button small"
                              onClick={() => onDeploymentAction(deployment.id, "refreshResponses")}
                              disabled={actionPendingId === deployment.id || deployment.status !== "running"}
                            >
                              {actionPendingId === deployment.id ? "处理中..." : "刷新原生 Responses"}
                            </button>
                            <button
                              className="ghost-button small"
                              onClick={onStopTunnel}
                              disabled={!deploymentTunnelReady}
                            >
                              断开当前连接
                            </button>
                            <button
                              className="ghost-button small"
                              onClick={() => onCopyText(deploymentPublicIp, "公网 IP 已复制")}
                              disabled={!deploymentPublicIp}
                            >
                              复制公网 IP
                            </button>
                            <button
                              className="ghost-button small"
                              onClick={() => onDeploymentAction(deployment.id, "start")}
                              disabled={actionPendingId === deployment.id || deployment.status === "running"}
                            >
                              {actionPendingId === deployment.id ? "处理中..." : "启动"}
                            </button>
                            <button
                              className="ghost-button small"
                              onClick={() => onDeploymentAction(deployment.id, "stop")}
                              disabled={actionPendingId === deployment.id || deployment.status === "stopped"}
                            >
                              {actionPendingId === deployment.id ? "处理中..." : "停止"}
                            </button>
                            <button
                              className="ghost-button small"
                              onClick={() => onDeploymentAction(deployment.id, "restart")}
                              disabled={actionPendingId === deployment.id || deployment.status !== "running"}
                            >
                              {actionPendingId === deployment.id ? "处理中..." : "重启"}
                            </button>
                          </div>
                        </section>

                        <section className="deployment-action-group deployment-action-group--danger">
                          <div className="deployment-action-group__title">销毁</div>
                          <div className="result-actions">
                            <button
                              className="ghost-button small"
                              onClick={() => onDeploymentAction(deployment.id, "destroy")}
                              disabled={actionPendingId === deployment.id}
                            >
                              {actionPendingId === deployment.id ? "处理中..." : "销毁实例"}
                            </button>
                          </div>
                        </section>
                      </>
                    ) : (
                      <section className="deployment-action-group">
                        <div className="deployment-action-group__title">维护</div>
                        <div className="result-actions">
                          <button
                            className="ghost-button small"
                            onClick={() => onCopyText(localBootstrapLogPath, "日志路径已复制")}
                          >
                            复制日志路径
                          </button>
                          <button
                            className="ghost-button small"
                            onClick={() => onRepairLocalDeployment(deployment)}
                            disabled={localDeployPending || foreignDeviceLocalDeployment}
                          >
                            {localDeployPending ? "刷新中..." : "刷新原生 Responses"}
                          </button>
                        </div>
                      </section>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </section>
  );
}

export function App() {
  const [currentView, setCurrentView] = useState("home");
  const [preferredAssistantDeploymentId, setPreferredAssistantDeploymentId] = useState("");
  const [topupAmount, setTopupAmount] = useState("50");
  const [profileForm, setProfileForm] = useState({
    displayName: "",
  });
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [authState, setAuthState] = useState({
    user: null,
    accountScopeId: "",
    sessionToken: getStoredSessionToken(),
    loading: true,
    authMode: "login",
    authPending: false,
    authError: "",
    authForm: {
      displayName: "",
      email: "",
      password: "",
    },
  });
  const [createForm, setCreateForm] = useState(DEFAULT_DEPLOYMENT_FORM);
  const [localDeploymentForm, setLocalDeploymentForm] = useState(DEFAULT_LOCAL_DEPLOYMENT_FORM);
  const [modelCatalog, setModelCatalog] = useState(FALLBACK_GATEWAY_MODEL_CATALOG);
  const [localClearKeyOnLogout, setLocalClearKeyOnLogout] = useState(
    getStoredLocalClearKeyOnLogout(),
  );
  const [workspaceState, setWorkspaceState] = useState({
    wallet: null,
    usageSummary: null,
    deploymentSummaries: [],
    deployments: [],
    transactions: [],
    loading: true,
    syncing: false,
    topupPending: false,
    profilePending: false,
    passwordPending: false,
    createPending: false,
    actionPendingId: null,
    actionPendingType: "",
    error: "",
    profileError: "",
    passwordError: "",
    createError: "",
    createResult: null,
    createDiagnostics: [],
    createFeedback: "",
    cloudConnectPending: false,
    localDeployPending: false,
    localCredentialPending: false,
    localDeployError: "",
    localDeployFeedback: "",
    localDeployResult: null,
  });
  const [sshPasswordDrafts, setSshPasswordDrafts] = useState({});
  const [tunnelStatus, setTunnelStatus] = useState({
    connected: false,
    dashboardPortOpen: false,
    browserControlPortOpen: false,
    host: "",
    pid: null,
  });
  const [localRuntimeStatus, setLocalRuntimeStatus] = useState({
    ok: false,
    installed: false,
    ready: false,
    dashboardPortOpen: false,
    browserControlPortOpen: false,
    binaryPath: "",
    version: "",
    logPath: "",
    error: "",
    bootstrapStage: "idle",
    bootstrapMessage: "",
    bootstrapLastLine: "",
    bootstrapProgressPercent: null,
    bootstrapProgressDetail: "",
    localDeviceId: "",
    localDeviceLabel: "",
    bindingLocalDeviceId: "",
    bindingLocalDeviceLabel: "",
    workspaceId: "",
    deploymentId: "",
    bindingUpdatedAt: "",
    bootstrapLogUpdatedAt: 0,
    bindingMissingDuringBootstrap: false,
    localApiKeyConfigured: false,
    currentModelId: "",
    ownerAccountScopeId: "",
    ownerUserId: "",
    ownerDisplayName: "",
    ownerEmail: "",
    authSyncedAt: "",
    dashboardUrl: "",
    browserControlUrl: "",
    baseUrl: "",
  });
  const localRuntimeAutoSyncSignatureRef = useRef("");

  const currentScopeId = resolveAuthScopeId(authState);
  const currentLocalIsolationIssue = getLocalIsolationIssue({
    sessionToken: authState.sessionToken,
    currentScopeId,
    currentUserId: resolveUserId(authState.user),
    deployments: workspaceState.deployments,
    localRuntimeStatus,
    authLoading: authState.loading,
    workspaceLoading: workspaceState.loading,
    localDeployPending: workspaceState.localDeployPending,
  });

  const syncLocalRuntimeStatus = async (nextStatus) => {
    const resolvedStatus = nextStatus ?? (await getLocalOpenClawStatus());
    if (resolvedStatus) {
      setLocalRuntimeStatus(resolvedStatus);
    }
    return resolvedStatus;
  };

  const buildDefaultLocalDeploymentName = (user) => {
    const displayName =
      typeof user?.displayName === "string" ? user.displayName.trim() : "";
    return displayName ? `${displayName} 的本地助手` : DEFAULT_LOCAL_DEPLOYMENT_FORM.name;
  };

  const resolveLocalBootstrapPayloadForDeployment = async ({
    deployment,
    targetScopeId,
  }) => {
    const runtimeStatus = await syncLocalRuntimeStatus();
    const localDeviceId = resolveRuntimeLocalDeviceId(runtimeStatus);
    const localDeviceLabel = resolveRuntimeLocalDeviceLabel(runtimeStatus);
    const bootstrapResult = await fetchJson("/runtime/local/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountScopeId: targetScopeId || deployment?.workspaceId || "",
        platform: getDesktopPlatform(),
        localDeviceId,
        localDeviceLabel,
      }),
    });

    const resolvedScopeId =
      typeof bootstrapResult?.accountScopeId === "string" && bootstrapResult.accountScopeId.trim()
        ? bootstrapResult.accountScopeId.trim()
        : targetScopeId || deployment?.workspaceId || "";
    const existingBootstrap =
      getStoredLocalBootstrap(resolvedScopeId) ??
      (deployment ? buildLocalBootstrapFromDeployment(deployment) : null);
    const defaultModelId =
      normalizeLocalBootstrapModelCandidate(existingBootstrap?.modelId) ||
      normalizeLocalBootstrapModelCandidate(bootstrapResult?.defaultModelId) ||
      resolveDefaultGatewayModelId(modelCatalog);
    const gatewayToken =
      getDashboardToken(runtimeStatus?.dashboardUrl) ||
      getDashboardToken(existingBootstrap?.dashboardUrl) ||
      "";
    const bootstrapPayload = attachLocalAuthOwner(
      {
        ...existingBootstrap,
        accountScopeId: resolvedScopeId,
        workspaceId: resolvedScopeId,
        deploymentId: `local:${resolvedScopeId}`,
        localDeviceId: localDeviceId || existingBootstrap?.localDeviceId || "",
        localDeviceLabel: localDeviceLabel || existingBootstrap?.localDeviceLabel || "",
        platform: getDesktopPlatform(),
        apiKey:
          typeof bootstrapResult?.apiKey === "string" ? bootstrapResult.apiKey.trim() : "",
        providerId:
          typeof bootstrapResult?.providerId === "string"
            ? bootstrapResult.providerId.trim()
            : "openai",
        baseUrl:
          typeof bootstrapResult?.baseUrl === "string" ? bootstrapResult.baseUrl.trim() : "",
        modelId: defaultModelId,
        concreteModelId: defaultModelId,
        requestedModelId: defaultModelId,
        allowedModelIds: Array.isArray(bootstrapResult?.allowedModelIds)
          ? bootstrapResult.allowedModelIds
          : existingBootstrap?.allowedModelIds ?? [defaultModelId],
        gatewayPort: existingBootstrap?.gatewayPort ?? 18789,
        gatewayBind: existingBootstrap?.gatewayBind ?? "loopback",
        browserControlPort: existingBootstrap?.browserControlPort ?? 18791,
        gatewayToken,
        dashboardUrl:
          (typeof runtimeStatus?.dashboardUrl === "string" && runtimeStatus.dashboardUrl.trim()) ||
          existingBootstrap?.dashboardUrl ||
          `http://127.0.0.1:18789${gatewayToken ? `/#token=${gatewayToken}` : ""}`,
        browserControlUrl:
          (typeof runtimeStatus?.browserControlUrl === "string" &&
          runtimeStatus.browserControlUrl.trim()) ||
          existingBootstrap?.browserControlUrl ||
          "http://127.0.0.1:18791/",
        tokenSource:
          existingBootstrap?.tokenSource ?? "desktop-local-bootstrap (gateway.auth.token)",
        logPath:
          runtimeStatus?.logPath ||
          existingBootstrap?.logPath ||
          (getDesktopPlatform() === "win32"
            ? "%LOCALAPPDATA%\\Xiaolanbu\\logs\\local-bootstrap.log"
            : "~/Library/Logs/Xiaolanbu/local-bootstrap.log"),
        runtimePackages: Array.isArray(bootstrapResult?.runtimePackages)
          ? bootstrapResult.runtimePackages
          : existingBootstrap?.runtimePackages ?? [],
        routingMode: "backend-model-routing",
      },
      {
        accountScopeId: resolvedScopeId,
        user: authState.user,
      },
    );

    if (!bootstrapPayload?.apiKey) {
      throw new Error("当前账号缺少可用的本地计费密钥，请稍后再试。");
    }

    setStoredLocalBootstrap(resolvedScopeId, bootstrapPayload);
    const resolvedDeployment =
      buildSyntheticLocalDeployment(
        {
          ...runtimeStatus,
          ownerAccountScopeId: resolvedScopeId,
          workspaceId: resolvedScopeId,
          ownerUserId:
            typeof bootstrapResult?.ownerUserId === "string"
              ? bootstrapResult.ownerUserId
              : runtimeStatus?.ownerUserId ?? "",
          localApiKeyConfigured: true,
          currentModelId: bootstrapPayload.modelId,
          dashboardUrl: bootstrapPayload.dashboardUrl,
          browserControlUrl: bootstrapPayload.browserControlUrl,
          baseUrl: bootstrapPayload.baseUrl,
        },
        resolvedScopeId,
      ) ?? deployment;

    return {
      deployment: resolvedDeployment,
      bootstrapPayload,
    };
  };

  const syncLocalRuntimeForAccount = async ({
    targetScopeId,
    deployments = workspaceState.deployments,
    user = authState.user,
    deployment = null,
    allowCreate = true,
  } = {}) => {
    if (!targetScopeId) {
      return null;
    }

    const runtimeStatus = await syncLocalRuntimeStatus();
    const localDeviceId = resolveRuntimeLocalDeviceId(runtimeStatus);
    const localDeviceLabel = resolveRuntimeLocalDeviceLabel(runtimeStatus);
    const localRuntimePresent =
      Boolean(runtimeStatus?.installed) ||
      Boolean(runtimeStatus?.ready) ||
      Boolean(runtimeStatus?.workspaceId) ||
      Boolean(runtimeStatus?.deploymentId);

    if (!localRuntimePresent) {
      return null;
    }

    let targetDeployment = deployment ?? findLocalDeployment(deployments, runtimeStatus);
    let bootstrapPayload = null;
    let createdDeployment = false;

    if (!targetDeployment && !allowCreate) {
      return null;
    }

    if (!bootstrapPayload?.apiKey) {
      const resolved = await resolveLocalBootstrapPayloadForDeployment({
        deployment: targetDeployment,
        targetScopeId,
      });
      targetDeployment = resolved.deployment;
      bootstrapPayload = attachLocalAuthOwner(resolved.bootstrapPayload, {
        accountScopeId: targetScopeId,
        user,
      });
      createdDeployment = !deployment;
    }

    const syncResult = await syncLocalOpenClawAuth(bootstrapPayload);
    const nextStatus = await syncLocalRuntimeStatus(syncResult?.status);
    if (!syncResult?.ok) {
      throw new Error(
        syncResult?.error ||
          nextStatus?.bootstrapLastLine ||
          "同步本地 API Key 失败，请稍后再试。",
      );
    }

    setWorkspaceState((current) => ({
      ...current,
      localDeployError: "",
      localDeployFeedback: createdDeployment
        ? "检测到本机已有 OpenClaw，已自动为当前账号补回本地 API Key。"
        : "当前账号的本地 API Key 已同步到本机 OpenClaw。",
      localDeployResult: {
        deployment: targetDeployment,
        bootstrap: bootstrapPayload,
        runtime: syncResult,
      },
    }));

    return {
      deployment: targetDeployment,
      bootstrapPayload,
      runtimeStatus: nextStatus,
      createdDeployment,
    };
  };

  const patchDeploymentStatus = async (deploymentId, status) => {
    if (!deploymentId) {
      return;
    }

    await fetchJson(`/deployments/${deploymentId}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status }),
    });
  };

  const patchDeploymentStatusSafely = async (deploymentId, status) => {
    if (!deploymentId || !getStoredSessionToken()) {
      return;
    }

    try {
      await patchDeploymentStatus(deploymentId, status);
    } catch {
      // Ignore cleanup-time patch failures for stale or inaccessible deployments.
    }
  };

  const resetLocalRuntimeBinding = async ({
    message = "",
    clearBinding = true,
    syncDeploymentStatus = true,
  } = {}) => {
    const boundDeploymentId = localRuntimeStatus?.deploymentId ?? "";
    if (syncDeploymentStatus && clearBinding && boundDeploymentId) {
      await patchDeploymentStatusSafely(boundDeploymentId, "stopped");
    }

    clearStoredLocalBootstraps();
    const result = await resetLocalOpenClaw({ clearBinding });
    const nextStatus = await syncLocalRuntimeStatus(result?.status);

    if (message) {
      setWorkspaceState((current) => ({
        ...current,
        localDeployPending: false,
        localCredentialPending: false,
        localDeployError: message,
        localDeployFeedback: "",
        localDeployResult: null,
      }));
    }

    return {
      result,
      status: nextStatus,
    };
  };

  useEffect(() => {
    setProfileForm({
      displayName: authState.user?.displayName ?? "",
    });
  }, [authState.user?.displayName]);

  useEffect(() => {
    const defaultModelId = resolveDefaultGatewayModelId(modelCatalog);
    const availableIds = new Set(normalizeGatewayModelCatalog(modelCatalog).map((item) => item.id));

    setCreateForm((current) =>
      current.modelId && availableIds.has(current.modelId)
        ? current
        : {
            ...current,
            modelId: defaultModelId,
          },
    );
    setLocalDeploymentForm((current) =>
      current.modelId && availableIds.has(current.modelId)
        ? current
        : {
            ...current,
            modelId: defaultModelId,
          },
    );
  }, [modelCatalog]);

  const refreshAuthState = async () => {
    const storedToken = getStoredSessionToken();
    if (!storedToken) {
      clearStoredLocalBootstraps();
      setAuthState((current) => ({
        ...current,
        user: null,
        accountScopeId: "",
        sessionToken: "",
        loading: false,
      }));
      setWorkspaceState((current) => ({
        ...current,
        loading: false,
        syncing: false,
        localCredentialPending: false,
      }));
      return null;
    }

    const authResult = await fetchJson("/auth/me");
    setAuthState({
      user: authResult.user ?? null,
      accountScopeId: resolveAuthScopeId(authResult),
      sessionToken: storedToken,
      loading: false,
      authMode: "login",
      authPending: false,
      authError: "",
      authForm: {
        displayName: "",
        email: authResult.user?.email ?? "",
        password: "",
      },
    });
    setWorkspaceState((current) => ({
      ...current,
      profilePending: false,
      passwordPending: false,
      profileError: "",
      passwordError: "",
    }));
    return authResult;
  };

  const refreshWorkspaceDeployments = async ({ silent = false } = {}) => {
    if (!getStoredSessionToken()) {
      return null;
    }

    try {
      const deploymentsResult = await fetchJson("/deployments");
      const deployments = deploymentsResult.items ?? [];
      pruneStoredLocalBootstraps(deployments.map((item) => item?.id));
      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          deployments,
          ...(silent
            ? {}
            : {
                error: "",
              }),
        }));
      });
      return deployments;
    } catch (error) {
      if (!silent) {
        startTransition(() => {
          setWorkspaceState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "实例列表暂时不可用",
          }));
        });
      }
      return null;
    }
  };

  const refreshWorkspaceData = async ({ withSync = false } = {}) => {
    if (!getStoredSessionToken()) {
      return null;
    }

    startTransition(() => {
      setWorkspaceState((current) => ({
        ...current,
        loading: true,
        syncing: withSync || current.syncing,
        error: "",
      }));
    });

    try {
      if (withSync) {
        await fetchJson("/billing/me/sync", { method: "POST" });
      }

      const [
        walletResult,
        usageResult,
        summaryResult,
        transactionsResult,
        deploymentsResult,
        modelCatalogResult,
      ] =
        await Promise.all([
          fetchJson("/billing/me/wallet"),
          fetchJson("/billing/me/usage?period=today"),
          fetchJson("/billing/me/deployments/summary?period=today"),
          fetchJson("/billing/me/transactions?limit=8"),
          fetchJson("/deployments"),
          fetchJson("/deployments/model-catalog").catch(() => ({
            items: modelCatalog,
          })),
        ]);
      const deployments = deploymentsResult.items ?? [];
      setModelCatalog(normalizeGatewayModelCatalog(modelCatalogResult.items));
      pruneStoredLocalBootstraps(deployments.map((item) => item?.id));
      const nextData = {
        wallet: walletResult.wallet,
        usageSummary: usageResult.summary,
        deploymentSummaries: summaryResult.items ?? [],
        transactions: transactionsResult.items ?? [],
        deployments,
      };

      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          ...nextData,
          loading: false,
          syncing: false,
          error: "",
          profileError: "",
          passwordError: "",
        }));
      });
      return nextData;
    } catch (error) {
      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          loading: false,
          syncing: false,
          error: error instanceof Error ? error.message : "线上数据暂时不可用",
        }));
      });
      return null;
    }
  };

  const applyDeploymentSnapshot = (deploymentRecord) => {
    if (!deploymentRecord?.id) {
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      deployments: current.deployments.map((item) =>
        item?.id === deploymentRecord.id ? { ...item, ...deploymentRecord } : item,
      ),
    }));
  };

  useEffect(() => {
    void (async () => {
      try {
        const authResult = await refreshAuthState();
        if (authResult) {
          const workspaceData = await refreshWorkspaceData();
          try {
            const targetScopeId = resolveAuthScopeId(authResult);
            const runtimeStatus = await syncLocalRuntimeStatus();
            if (
              shouldAutoSyncLocalRuntime({
                sessionToken: getStoredSessionToken(),
                currentScopeId: targetScopeId,
                currentUserId: resolveUserId(authResult.user),
                deployments: workspaceData?.deployments ?? [],
                runtimeStatus,
              })
            ) {
              await syncLocalRuntimeForAccount({
                targetScopeId,
                deployments: workspaceData?.deployments ?? [],
                user: authResult.user ?? null,
                allowCreate: true,
              });
            }
          } catch (error) {
            setWorkspaceState((current) => ({
              ...current,
              localDeployError:
                error instanceof Error ? error.message : "同步本地 API Key 失败，请稍后再试。",
            }));
          }
        }
      } catch {
        setStoredSessionToken("");
        setAuthState((current) => ({
          ...current,
          user: null,
          accountScopeId: "",
          sessionToken: "",
          loading: false,
        }));
      }
    })();
  }, []);

  useEffect(() => {
    const handleSessionExpired = (event) => {
      const nextMessage =
        event?.detail?.message || "登录状态已失效，请重新登录。";

      setStoredSessionToken("");
      clearStoredLocalBootstraps();
      setAuthState((current) => ({
        ...current,
        user: null,
        accountScopeId: "",
        sessionToken: "",
        loading: false,
        authPending: false,
        authMode: "login",
        authError: nextMessage,
        authForm: {
          displayName: "",
          email: current.user?.email ?? current.authForm?.email ?? "",
          password: "",
        },
      }));
      setWorkspaceState((current) => ({
        ...current,
        wallet: null,
        usageSummary: null,
        deploymentSummaries: [],
        deployments: [],
        transactions: [],
        loading: false,
        syncing: false,
        profilePending: false,
        passwordPending: false,
        localCredentialPending: false,
        actionPendingId: null,
        actionPendingType: "",
        error: "",
        profileError: "",
        passwordError: "",
        createError: "",
        createResult: null,
        createDiagnostics: [],
        createFeedback: "",
        localDeployPending: false,
        localDeployError: "",
        localDeployFeedback: "",
        localDeployResult: null,
      }));
      setProfileForm({ displayName: "" });
      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setLocalDeploymentForm({
        ...DEFAULT_LOCAL_DEPLOYMENT_FORM,
        modelId: resolveDefaultGatewayModelId(modelCatalog),
      });
    };

    window.addEventListener("xiaolanbu:session-expired", handleSessionExpired);
    return () => {
      window.removeEventListener("xiaolanbu:session-expired", handleSessionExpired);
    };
  }, []);

  useEffect(() => {
    if (!currentScopeId) {
      return;
    }

    void refreshWorkspaceData();

    const timer = window.setInterval(() => {
      void refreshWorkspaceData();
  }, workspaceState.createPending || workspaceState.actionPendingId ? 5000 : 60000);

    return () => window.clearInterval(timer);
  }, [currentScopeId, workspaceState.createPending, workspaceState.actionPendingId]);

  useEffect(() => {
    let cancelled = false;

    const refreshTunnelStatus = async () => {
      try {
        const result = await getTunnelStatus();
        if (cancelled || !result?.ok) {
          return;
        }

        setTunnelStatus({
          connected: Boolean(result.connected),
          dashboardPortOpen: Boolean(result.dashboardPortOpen),
          browserControlPortOpen: Boolean(result.browserControlPortOpen),
          host: typeof result.host === "string" ? result.host : "",
          pid: Number.isFinite(result.pid) ? result.pid : null,
        });
      } catch {
        if (cancelled) {
          return;
        }

        setTunnelStatus({
          connected: false,
          dashboardPortOpen: false,
          browserControlPortOpen: false,
          host: "",
          pid: null,
        });
      }
    };

    void refreshTunnelStatus();
    const timer = window.setInterval(() => {
      void refreshTunnelStatus();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!workspaceState.localDeployPending || !localRuntimeStatus.ready) {
      return;
    }

    setWorkspaceState((current) => {
      if (!current.localDeployPending) {
        return current;
      }

      return {
        ...current,
        localDeployPending: false,
        localDeployError: "",
        localDeployFeedback: "本地 OpenClaw 已就绪，现在可以直接开始聊天。",
      };
    });
  }, [localRuntimeStatus.ready, workspaceState.localDeployPending]);

  useEffect(() => {
    if (!localRuntimeStatus.ready || currentLocalIsolationIssue) {
      return;
    }

    setWorkspaceState((current) => {
      if (!current.localDeployError) {
        return current;
      }

      return {
        ...current,
        localDeployError: "",
        localDeployFeedback:
          current.localDeployFeedback || "本地 OpenClaw 已就绪，现在可以直接开始聊天。",
      };
    });
  }, [currentLocalIsolationIssue, localRuntimeStatus.ready]);

  useEffect(() => {
    if (workspaceState.localDeployPending || localRuntimeStatus.ready) {
      return;
    }

    setWorkspaceState((current) => {
      if (
        !current.localDeployFeedback ||
        !/本地 OpenClaw 已(就绪|部署完成)/.test(current.localDeployFeedback)
      ) {
        return current;
      }

      return {
        ...current,
        localDeployFeedback: "",
      };
    });
  }, [localRuntimeStatus.ready, workspaceState.localDeployPending]);

  useEffect(() => {
    let cancelled = false;

    const refreshLocalRuntimeStatus = async () => {
      try {
        const result = await getLocalOpenClawStatus();
        if (cancelled) {
          return;
        }

        setLocalRuntimeStatus({
          ok: Boolean(result?.ok),
          installed: Boolean(result?.installed),
          ready: Boolean(result?.ready),
          dashboardPortOpen: Boolean(result?.dashboardPortOpen),
          browserControlPortOpen: Boolean(result?.browserControlPortOpen),
          binaryPath: typeof result?.binaryPath === "string" ? result.binaryPath : "",
          version: typeof result?.version === "string" ? result.version : "",
          logPath: typeof result?.logPath === "string" ? result.logPath : "",
          error: typeof result?.error === "string" ? result.error : "",
          bootstrapStage:
            typeof result?.bootstrapStage === "string" ? result.bootstrapStage : "idle",
          bootstrapMessage:
            typeof result?.bootstrapMessage === "string" ? result.bootstrapMessage : "",
          bootstrapLastLine:
            typeof result?.bootstrapLastLine === "string" ? result.bootstrapLastLine : "",
          bootstrapProgressPercent:
            typeof result?.bootstrapProgressPercent === "number"
              ? result.bootstrapProgressPercent
              : null,
          bootstrapProgressDetail:
            typeof result?.bootstrapProgressDetail === "string"
              ? result.bootstrapProgressDetail
              : "",
          localDeviceId:
            typeof result?.localDeviceId === "string" ? result.localDeviceId : "",
          localDeviceLabel:
            typeof result?.localDeviceLabel === "string" ? result.localDeviceLabel : "",
          bindingLocalDeviceId:
            typeof result?.bindingLocalDeviceId === "string" ? result.bindingLocalDeviceId : "",
          bindingLocalDeviceLabel:
            typeof result?.bindingLocalDeviceLabel === "string"
              ? result.bindingLocalDeviceLabel
              : "",
          currentModelId:
            typeof result?.currentModelId === "string" ? result.currentModelId : "",
          bootstrapLogUpdatedAt:
            typeof result?.bootstrapLogUpdatedAt === "number" ? result.bootstrapLogUpdatedAt : 0,
          bindingMissingDuringBootstrap: Boolean(result?.bindingMissingDuringBootstrap),
          localApiKeyConfigured: Boolean(result?.localApiKeyConfigured),
          ownerAccountScopeId:
            typeof result?.ownerAccountScopeId === "string" ? result.ownerAccountScopeId : "",
          ownerUserId: typeof result?.ownerUserId === "string" ? result.ownerUserId : "",
          ownerDisplayName:
            typeof result?.ownerDisplayName === "string" ? result.ownerDisplayName : "",
          ownerEmail: typeof result?.ownerEmail === "string" ? result.ownerEmail : "",
          authSyncedAt: typeof result?.authSyncedAt === "string" ? result.authSyncedAt : "",
          dashboardUrl: typeof result?.dashboardUrl === "string" ? result.dashboardUrl : "",
          browserControlUrl:
            typeof result?.browserControlUrl === "string" ? result.browserControlUrl : "",
          baseUrl: typeof result?.baseUrl === "string" ? result.baseUrl : "",
          workspaceId:
            typeof result?.workspaceId === "string" && result.workspaceId
              ? result.workspaceId
              : workspaceState.localDeployResult?.bootstrap?.workspaceId ?? "",
          deploymentId:
            typeof result?.deploymentId === "string" && result.deploymentId
              ? result.deploymentId
              : workspaceState.localDeployResult?.bootstrap?.deploymentId ?? "",
          bindingUpdatedAt:
            typeof result?.bindingUpdatedAt === "string" ? result.bindingUpdatedAt : "",
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLocalRuntimeStatus((current) => ({
          ...current,
          ok: false,
          ready: false,
          dashboardPortOpen: false,
          browserControlPortOpen: false,
          error: error instanceof Error ? error.message : "本地运行时状态暂时不可用。",
          bootstrapStage: "idle",
          bootstrapMessage: "",
          bootstrapLastLine: "",
          bootstrapProgressPercent: null,
          bootstrapProgressDetail: "",
          localDeviceId: current.localDeviceId || "",
          localDeviceLabel: current.localDeviceLabel || "",
          bindingLocalDeviceId: "",
          bindingLocalDeviceLabel: "",
          currentModelId: "",
          localApiKeyConfigured: false,
          ownerAccountScopeId: "",
          ownerUserId: "",
          ownerDisplayName: "",
          ownerEmail: "",
          authSyncedAt: "",
          dashboardUrl: "",
          browserControlUrl: "",
          baseUrl: "",
          workspaceId: "",
          deploymentId: "",
          bindingUpdatedAt: "",
          bootstrapLogUpdatedAt: 0,
          bindingMissingDuringBootstrap: false,
        }));
      }
    };

    void refreshLocalRuntimeStatus();
    const timer = window.setInterval(() => {
      void refreshLocalRuntimeStatus();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceState.localDeployResult]);

  useEffect(() => {
    if (
      authState.loading ||
      workspaceState.loading ||
      workspaceState.localDeployPending ||
      workspaceState.localCredentialPending ||
      !authState.sessionToken ||
      !currentScopeId
    ) {
      return;
    }

    const shouldSync = shouldAutoSyncLocalRuntime({
      sessionToken: authState.sessionToken,
      currentScopeId,
      currentUserId: resolveUserId(authState.user),
      deployments: workspaceState.deployments,
      runtimeStatus: localRuntimeStatus,
    });

    if (!shouldSync) {
      localRuntimeAutoSyncSignatureRef.current = "";
      return;
    }

    const localDeployment = findLocalDeployment(workspaceState.deployments, localRuntimeStatus);
    const syncSignature = JSON.stringify({
      scopeId: currentScopeId,
      currentUserId: resolveUserId(authState.user),
      deploymentId: localDeployment?.id ?? "",
      deploymentModelId: localDeployment
        ? resolveDeploymentGatewayModelId(localDeployment, "")
        : "",
      runtimeDeploymentId: localRuntimeStatus.deploymentId || "",
      runtimeModelId: localRuntimeStatus.currentModelId || "",
      ownerScopeId: localRuntimeStatus.ownerAccountScopeId || localRuntimeStatus.workspaceId || "",
      ownerUserId: localRuntimeStatus.ownerUserId || "",
      localApiKeyConfigured: Boolean(localRuntimeStatus.localApiKeyConfigured),
      authSyncedAt: localRuntimeStatus.authSyncedAt || "",
    });

    if (localRuntimeAutoSyncSignatureRef.current === syncSignature) {
      return;
    }
    localRuntimeAutoSyncSignatureRef.current = syncSignature;

    let cancelled = false;
    void (async () => {
      try {
        await syncLocalRuntimeForAccount({
          targetScopeId: currentScopeId,
          deployments: workspaceState.deployments,
          user: authState.user,
          deployment: localDeployment,
          allowCreate: true,
        });
        if (cancelled) {
          return;
        }
        await refreshWorkspaceData();
      } catch (error) {
        if (cancelled) {
          return;
        }
        setWorkspaceState((current) => ({
          ...current,
          localDeployError:
            error instanceof Error
              ? error.message
              : "同步本地 OpenClaw 运行模型失败，请稍后再试。",
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authState.loading,
    authState.sessionToken,
    authState.user,
    currentScopeId,
    localRuntimeStatus.authSyncedAt,
    localRuntimeStatus.browserControlPortOpen,
    localRuntimeStatus.currentModelId,
    localRuntimeStatus.dashboardPortOpen,
    localRuntimeStatus.deploymentId,
    localRuntimeStatus.installed,
    localRuntimeStatus.localApiKeyConfigured,
    localRuntimeStatus.ownerAccountScopeId,
    localRuntimeStatus.ownerUserId,
    localRuntimeStatus.ready,
    localRuntimeStatus.workspaceId,
    workspaceState.deployments,
    workspaceState.loading,
    workspaceState.localCredentialPending,
    workspaceState.localDeployPending,
  ]);

  const handleAuthFormChange = (field, value) => {
    setAuthState((current) => ({
      ...current,
      authForm: {
        ...current.authForm,
        [field]: value,
      },
    }));
  };

  const handleAuthSubmit = async () => {
    const authMode = authState.authMode;
    const { displayName, email, password } = authState.authForm;

    if (!email.trim() || !password.trim()) {
      setAuthState((current) => ({
        ...current,
        authError: "请先填写邮箱和密码。",
      }));
      return;
    }

    if (authMode === "register" && !displayName.trim()) {
      setAuthState((current) => ({
        ...current,
        authError: "注册时请先填写昵称。",
      }));
      return;
    }

    setAuthState((current) => ({
      ...current,
      authPending: true,
      authError: "",
    }));

    try {
      const result = await fetchJson(`/auth/${authMode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName,
          email,
          password,
        }),
      });

      const targetScopeId = resolveAuthScopeId(result);
      setStoredSessionToken(result.sessionToken ?? "");
      setAuthState((current) => ({
        ...current,
        user: result.user ?? null,
        accountScopeId: targetScopeId,
        sessionToken: result.sessionToken ?? "",
        loading: false,
        authPending: false,
        authError: "",
        authForm: {
          displayName: "",
          email: result.user?.email ?? email,
          password: "",
        },
      }));
      clearStoredLocalBootstraps();
      const workspaceData = await refreshWorkspaceData();
      try {
        const runtimeStatus = await syncLocalRuntimeStatus();
        if (
          shouldAutoSyncLocalRuntime({
            sessionToken: result.sessionToken ?? "",
            currentScopeId: targetScopeId,
            currentUserId: resolveUserId(result.user),
            deployments: workspaceData?.deployments ?? [],
            runtimeStatus,
          })
        ) {
          await syncLocalRuntimeForAccount({
            targetScopeId,
            deployments: workspaceData?.deployments ?? [],
            user: result.user ?? null,
            allowCreate: true,
          });
        }
      } catch (syncError) {
        setWorkspaceState((current) => ({
          ...current,
          localDeployError:
            syncError instanceof Error
              ? syncError.message
              : "登录成功，但同步本地 API Key 失败，请稍后再试。",
        }));
      }
    } catch (error) {
      setAuthState((current) => ({
        ...current,
        authPending: false,
        authError: error instanceof Error ? error.message : "登录失败，请稍后再试。",
      }));
    }
  };

  const handleAuthModeChange = (mode) => {
    setAuthState((current) => ({
      ...current,
      authMode: mode,
      authError: "",
    }));
  };

  const handleLogout = async () => {
    let localClearError = "";
    try {
      await fetchJson("/auth/logout", { method: "POST" });
    } catch {
      // Ignore logout transport errors and clear local session anyway.
    }

    if (localClearKeyOnLogout) {
      try {
        const clearResult = await clearLocalOpenClawApiKey();
        await syncLocalRuntimeStatus(clearResult?.status);
        if (!clearResult?.ok) {
          localClearError =
            clearResult?.error || "已退出登录，但清除本地 API Key 失败，请稍后手动处理。";
        }
      } catch (error) {
        localClearError =
          error instanceof Error
            ? `已退出登录，但清除本地 API Key 失败：${error.message}`
            : "已退出登录，但清除本地 API Key 失败，请稍后手动处理。";
      }
    }

    setStoredSessionToken("");
    clearStoredLocalBootstraps();
    setAuthState((current) => ({
      ...current,
      user: null,
      accountScopeId: "",
      sessionToken: "",
      loading: false,
      authPending: false,
      authError: localClearError,
      authMode: "login",
      authForm: {
        displayName: "",
        email: "",
        password: "",
      },
    }));
    setWorkspaceState((current) => ({
      ...current,
      wallet: null,
      usageSummary: null,
      deploymentSummaries: [],
      deployments: [],
      transactions: [],
      loading: false,
      syncing: false,
      profilePending: false,
      passwordPending: false,
      localCredentialPending: false,
      error: "",
      profileError: "",
      passwordError: "",
      createError: "",
      createResult: null,
      createDiagnostics: [],
      createFeedback: "",
      localDeployPending: false,
      localDeployError: "",
      localDeployFeedback: "",
      localDeployResult: null,
    }));
    setProfileForm({ displayName: "" });
    setPasswordForm({
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    });
    setLocalDeploymentForm({
      ...DEFAULT_LOCAL_DEPLOYMENT_FORM,
      modelId: resolveDefaultGatewayModelId(modelCatalog),
    });
  };

  const handleToggleLocalClearKeyOnLogout = (nextValue) => {
    const enabled = Boolean(nextValue);
    setStoredLocalClearKeyOnLogout(enabled);
    setLocalClearKeyOnLogout(enabled);
    setWorkspaceState((current) => ({
      ...current,
      localDeployError: "",
      localDeployFeedback: enabled
        ? "已开启：退出登录时会自动清除本地 API Key。"
        : "已关闭：退出登录后会保留本地 API Key。",
    }));
  };

  const handleProfileFieldChange = (field, value) => {
    setProfileForm((current) => ({
      ...current,
      [field]: value,
    }));
    setWorkspaceState((current) => ({
      ...current,
      profileError: "",
    }));
  };

  const handlePasswordFieldChange = (field, value) => {
    setPasswordForm((current) => ({
      ...current,
      [field]: value,
    }));
    setWorkspaceState((current) => ({
      ...current,
      passwordError: "",
    }));
  };

  const handleProfileSave = async () => {
    const displayName = profileForm.displayName.trim();
    if (!displayName) {
      setWorkspaceState((current) => ({
        ...current,
        profileError: "请先填写昵称。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      profilePending: true,
      profileError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson("/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName }),
      });

      setAuthState((current) => ({
        ...current,
        user: result.user ?? current.user,
        accountScopeId: resolveAuthScopeId(result) || current.accountScopeId,
      }));
      setWorkspaceState((current) => ({
        ...current,
        profilePending: false,
        profileError: "",
        createFeedback: "昵称已更新。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        profilePending: false,
        profileError: error instanceof Error ? error.message : "更新昵称失败，请稍后再试。",
      }));
    }
  };

  const handlePasswordSave = async () => {
    if (!passwordForm.currentPassword.trim() || !passwordForm.newPassword.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        passwordError: "请先填写当前密码和新密码。",
      }));
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setWorkspaceState((current) => ({
        ...current,
        passwordError: "两次输入的新密码不一致。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      passwordPending: true,
      passwordError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson("/auth/password", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        }),
      });

      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setWorkspaceState((current) => ({
        ...current,
        passwordPending: false,
        passwordError: "",
        createFeedback: result.message ?? "密码已更新。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        passwordPending: false,
        passwordError: error instanceof Error ? error.message : "更新密码失败，请稍后再试。",
      }));
    }
  };

  const handleTopup = async (amount) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          error: "请输入有效的充值金额。",
        }));
      });
      return;
    }

    startTransition(() => {
      setWorkspaceState((current) => ({
        ...current,
        topupPending: true,
        error: "",
      }));
    });

    try {
      await fetchJson("/billing/me/topups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amountCny: amount,
          title: `桌面端充值 ${formatCurrency(amount)}`,
        }),
      });

      await fetchJson("/billing/me/reconcile", {
        method: "POST",
      });
      await refreshWorkspaceData();
    } catch (error) {
      startTransition(() => {
        setWorkspaceState((current) => ({
          ...current,
          topupPending: false,
          error: error instanceof Error ? error.message : "充值失败，请稍后再试。",
        }));
      });
      return;
    }

    startTransition(() => {
      setWorkspaceState((current) => ({
        ...current,
        topupPending: false,
      }));
    });
  };

  const handleCreateFormChange = (field, value) => {
    setCreateForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleLocalDeploymentFormChange = (field, value) => {
    setLocalDeploymentForm((current) => ({
      ...current,
      [field]: value,
    }));
    setWorkspaceState((current) => ({
      ...current,
      localDeployError: "",
    }));
  };

  const handleSyncLocalApiKey = async (deployment) => {
    if (!currentScopeId) {
      setWorkspaceState((current) => ({
        ...current,
        localDeployError: "当前账号尚未完成初始化，请重新登录后再试。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      localCredentialPending: true,
      localDeployError: "",
      localDeployFeedback: "正在把当前账号的 API Key 同步到本机 OpenClaw...",
    }));

    try {
      const syncResult = await syncLocalRuntimeForAccount({
        targetScopeId: currentScopeId,
        deployments: workspaceState.deployments,
        user: authState.user,
        deployment,
        allowCreate: true,
      });
      if (!syncResult) {
        throw new Error("当前电脑还没有检测到本地 OpenClaw 运行时，请先点击“立即部署到本机”。");
      }
      await refreshWorkspaceData();
      setWorkspaceState((current) => ({
        ...current,
        localCredentialPending: false,
        localDeployError: "",
        localDeployFeedback:
          syncResult?.createdDeployment
            ? "已为当前账号补回本地 API Key。"
            : "当前账号的本地 API Key 已同步到本机 OpenClaw。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        localCredentialPending: false,
        localDeployError:
          error instanceof Error ? error.message : "同步本地 API Key 失败，请稍后再试。",
        localDeployFeedback: localRuntimeStatus?.logPath
          ? `可以查看日志：${localRuntimeStatus.logPath}`
          : current.localDeployFeedback,
      }));
    }
  };

  const handleClearLocalApiKey = async () => {
    setWorkspaceState((current) => ({
      ...current,
      localCredentialPending: true,
      localDeployError: "",
      localDeployFeedback: "正在清除本机 OpenClaw 的 API Key...",
    }));

    try {
      const result = await clearLocalOpenClawApiKey();
      const nextStatus = await syncLocalRuntimeStatus(result?.status);
      if (!result?.ok) {
        throw new Error(
          result?.error ||
            nextStatus?.bootstrapLastLine ||
            "本地 API Key 已清除，但本地网关重载失败。",
        );
      }

      setWorkspaceState((current) => ({
        ...current,
        localCredentialPending: false,
        localDeployError: "",
        localDeployFeedback:
          "本机 OpenClaw 的 API Key 已清除。后续重新登录或点击“同步本地 API Key”即可恢复。",
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        localCredentialPending: false,
        localDeployError:
          error instanceof Error ? error.message : "清除本地 API Key 失败，请稍后再试。",
        localDeployFeedback: localRuntimeStatus?.logPath
          ? `可以查看日志：${localRuntimeStatus.logPath}`
          : current.localDeployFeedback,
      }));
    }
  };

  const runLocalBootstrapFlow = async (deployment, bootstrapPayload) => {
    if (!bootstrapPayload?.apiKey) {
      throw new Error("本地部署缺少模型调用密钥，请重新一键部署。");
    }

    const bootstrapResult = await bootstrapLocalOpenClaw(bootstrapPayload);
    if (!bootstrapResult?.ok) {
      await syncLocalRuntimeStatus(bootstrapResult?.status);
      throw new Error(
        bootstrapResult?.error ||
          bootstrapResult?.status?.bootstrapLastLine ||
          "本地 OpenClaw 初始化失败，请稍后再试。",
      );
    }

    setLocalRuntimeStatus((current) => ({
      ...current,
      ok: Boolean(bootstrapResult?.status?.ok ?? true),
      installed: Boolean(bootstrapResult?.status?.installed ?? true),
      ready: Boolean(bootstrapResult?.status?.ready ?? true),
      dashboardPortOpen: Boolean(bootstrapResult?.status?.dashboardPortOpen ?? true),
      browserControlPortOpen: Boolean(
        bootstrapResult?.status?.browserControlPortOpen ?? current.browserControlPortOpen,
      ),
      binaryPath:
        typeof bootstrapResult?.status?.binaryPath === "string"
          ? bootstrapResult.status.binaryPath
          : current.binaryPath,
      version:
        typeof bootstrapResult?.status?.version === "string"
          ? bootstrapResult.status.version
          : current.version,
      logPath:
        typeof bootstrapResult?.logPath === "string"
          ? bootstrapResult.logPath
          : current.logPath,
      error: "",
      bootstrapStage:
        typeof bootstrapResult?.status?.bootstrapStage === "string"
          ? bootstrapResult.status.bootstrapStage
          : "service-start",
      bootstrapMessage:
        typeof bootstrapResult?.status?.bootstrapMessage === "string"
          ? bootstrapResult.status.bootstrapMessage
          : "本地控制台已就绪。",
      bootstrapLastLine:
        typeof bootstrapResult?.status?.bootstrapLastLine === "string"
          ? bootstrapResult.status.bootstrapLastLine
          : current.bootstrapLastLine,
      bootstrapProgressPercent:
        typeof bootstrapResult?.status?.bootstrapProgressPercent === "number"
          ? bootstrapResult.status.bootstrapProgressPercent
          : current.bootstrapProgressPercent,
      bootstrapProgressDetail:
        typeof bootstrapResult?.status?.bootstrapProgressDetail === "string"
          ? bootstrapResult.status.bootstrapProgressDetail
          : current.bootstrapProgressDetail,
      localDeviceId:
        typeof bootstrapResult?.status?.localDeviceId === "string"
          ? bootstrapResult.status.localDeviceId
          : current.localDeviceId,
      localDeviceLabel:
        typeof bootstrapResult?.status?.localDeviceLabel === "string"
          ? bootstrapResult.status.localDeviceLabel
          : current.localDeviceLabel,
      bindingLocalDeviceId:
        typeof bootstrapResult?.status?.bindingLocalDeviceId === "string"
          ? bootstrapResult.status.bindingLocalDeviceId
          : current.bindingLocalDeviceId,
      bindingLocalDeviceLabel:
        typeof bootstrapResult?.status?.bindingLocalDeviceLabel === "string"
          ? bootstrapResult.status.bindingLocalDeviceLabel
          : current.bindingLocalDeviceLabel,
      currentModelId:
        typeof bootstrapResult?.status?.currentModelId === "string"
          ? bootstrapResult.status.currentModelId
          : typeof bootstrapPayload?.modelId === "string"
            ? bootstrapPayload.modelId
            : current.currentModelId,
      localApiKeyConfigured: Boolean(
        bootstrapResult?.status?.localApiKeyConfigured ?? bootstrapPayload?.apiKey,
      ),
      ownerAccountScopeId:
        typeof bootstrapResult?.status?.ownerAccountScopeId === "string"
          ? bootstrapResult.status.ownerAccountScopeId
          : bootstrapPayload?.accountScopeId ?? current.ownerAccountScopeId,
      ownerUserId:
        typeof bootstrapResult?.status?.ownerUserId === "string"
          ? bootstrapResult.status.ownerUserId
          : bootstrapPayload?.userId ?? current.ownerUserId,
      ownerDisplayName:
        typeof bootstrapResult?.status?.ownerDisplayName === "string"
          ? bootstrapResult.status.ownerDisplayName
          : bootstrapPayload?.displayName ?? current.ownerDisplayName,
      ownerEmail:
        typeof bootstrapResult?.status?.ownerEmail === "string"
          ? bootstrapResult.status.ownerEmail
          : bootstrapPayload?.email ?? current.ownerEmail,
      authSyncedAt:
        typeof bootstrapResult?.status?.authSyncedAt === "string"
          ? bootstrapResult.status.authSyncedAt
          : new Date().toISOString(),
      dashboardUrl:
        typeof bootstrapResult?.status?.dashboardUrl === "string"
          ? bootstrapResult.status.dashboardUrl
          : current.dashboardUrl,
      browserControlUrl:
        typeof bootstrapResult?.status?.browserControlUrl === "string"
          ? bootstrapResult.status.browserControlUrl
          : current.browserControlUrl,
      baseUrl:
        typeof bootstrapResult?.status?.baseUrl === "string"
          ? bootstrapResult.status.baseUrl
          : bootstrapPayload?.baseUrl ?? current.baseUrl,
      workspaceId: bootstrapPayload?.workspaceId ?? deployment?.workspaceId ?? current.workspaceId,
      deploymentId: bootstrapPayload?.deploymentId ?? deployment?.id ?? current.deploymentId,
      bindingUpdatedAt: new Date().toISOString(),
      bootstrapLogUpdatedAt: Date.now(),
      bindingMissingDuringBootstrap: false,
    }));
    const runtimeStatusForSync = {
      ...bootstrapResult?.status,
      installed: Boolean(bootstrapResult?.status?.installed ?? true),
      ready: Boolean(bootstrapResult?.status?.ready ?? true),
      dashboardPortOpen: Boolean(bootstrapResult?.status?.dashboardPortOpen ?? true),
      browserControlPortOpen: Boolean(
        bootstrapResult?.status?.browserControlPortOpen ?? localRuntimeStatus.browserControlPortOpen,
      ),
      currentModelId:
        typeof bootstrapResult?.status?.currentModelId === "string"
          ? bootstrapResult.status.currentModelId
          : bootstrapPayload?.modelId ?? localRuntimeStatus.currentModelId,
      localApiKeyConfigured: Boolean(
        bootstrapResult?.status?.localApiKeyConfigured ?? bootstrapPayload?.apiKey,
      ),
      localDeviceId:
        typeof bootstrapResult?.status?.localDeviceId === "string"
          ? bootstrapResult.status.localDeviceId
          : localRuntimeStatus.localDeviceId,
      localDeviceLabel:
        typeof bootstrapResult?.status?.localDeviceLabel === "string"
          ? bootstrapResult.status.localDeviceLabel
          : localRuntimeStatus.localDeviceLabel,
      ownerAccountScopeId:
        typeof bootstrapResult?.status?.ownerAccountScopeId === "string"
          ? bootstrapResult.status.ownerAccountScopeId
          : bootstrapPayload?.accountScopeId ?? localRuntimeStatus.ownerAccountScopeId,
      ownerUserId:
        typeof bootstrapResult?.status?.ownerUserId === "string"
          ? bootstrapResult.status.ownerUserId
          : bootstrapPayload?.userId ?? localRuntimeStatus.ownerUserId,
      ownerDisplayName:
        typeof bootstrapResult?.status?.ownerDisplayName === "string"
          ? bootstrapResult.status.ownerDisplayName
          : bootstrapPayload?.displayName ?? localRuntimeStatus.ownerDisplayName,
      ownerEmail:
        typeof bootstrapResult?.status?.ownerEmail === "string"
          ? bootstrapResult.status.ownerEmail
          : bootstrapPayload?.email ?? localRuntimeStatus.ownerEmail,
      authSyncedAt:
        typeof bootstrapResult?.status?.authSyncedAt === "string"
          ? bootstrapResult.status.authSyncedAt
          : new Date().toISOString(),
      dashboardUrl:
        typeof bootstrapResult?.status?.dashboardUrl === "string"
          ? bootstrapResult.status.dashboardUrl
          : localRuntimeStatus.dashboardUrl,
      browserControlUrl:
        typeof bootstrapResult?.status?.browserControlUrl === "string"
          ? bootstrapResult.status.browserControlUrl
          : localRuntimeStatus.browserControlUrl,
      baseUrl:
        typeof bootstrapResult?.status?.baseUrl === "string"
          ? bootstrapResult.status.baseUrl
          : bootstrapPayload?.baseUrl ?? localRuntimeStatus.baseUrl,
      workspaceId: bootstrapPayload?.workspaceId ?? deployment?.workspaceId ?? localRuntimeStatus.workspaceId,
      deploymentId: bootstrapPayload?.deploymentId ?? deployment?.id ?? localRuntimeStatus.deploymentId,
      bindingUpdatedAt: new Date().toISOString(),
      logPath:
        typeof bootstrapResult?.logPath === "string" ? bootstrapResult.logPath : localRuntimeStatus.logPath,
      bootstrapStage:
        typeof bootstrapResult?.status?.bootstrapStage === "string"
          ? bootstrapResult.status.bootstrapStage
          : "service-start",
      bootstrapMessage:
        typeof bootstrapResult?.status?.bootstrapMessage === "string"
          ? bootstrapResult.status.bootstrapMessage
          : "本地控制台已就绪。",
      bootstrapLastLine:
        typeof bootstrapResult?.status?.bootstrapLastLine === "string"
          ? bootstrapResult.status.bootstrapLastLine
          : "",
      bootstrapProgressPercent:
        typeof bootstrapResult?.status?.bootstrapProgressPercent === "number"
          ? bootstrapResult.status.bootstrapProgressPercent
          : null,
      error: "",
    };
    await refreshWorkspaceData({ withSync: true });

    setWorkspaceState((current) => ({
      ...current,
      localDeployPending: false,
      localCredentialPending: false,
      localDeployError: "",
      localDeployResult: {
        deployment,
        bootstrap: bootstrapPayload,
        runtime: bootstrapResult,
      },
      localDeployFeedback: "本地 OpenClaw 已部署完成，现在可以直接开始聊天。",
    }));

    return bootstrapResult;
  };

  const handleCreateLocalDeployment = async () => {
    if (!currentScopeId) {
      setWorkspaceState((current) => ({
        ...current,
        localDeployError: "当前账号尚未完成初始化，请重新登录后再试。",
      }));
      return;
    }

    if (!localDeploymentForm.name.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        localDeployError: "请先填写本地实例名称。",
      }));
      return;
    }

    const runtimeStatus = await syncLocalRuntimeStatus();
    const existingLocalDeployment = findLocalDeployment(workspaceState.deployments, runtimeStatus);
    if (existingLocalDeployment) {
      setWorkspaceState((current) => ({
        ...current,
        localDeployError: "当前账号已经存在本地部署，请直接修复或继续使用。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      localDeployPending: true,
      localCredentialPending: false,
      localDeployError: "",
      localDeployFeedback: "",
      localDeployResult: null,
    }));

    try {
      const resolved = await resolveLocalBootstrapPayloadForDeployment({
        deployment: buildSyntheticLocalDeployment(runtimeStatus, currentScopeId),
        targetScopeId: currentScopeId,
      });
      const bootstrapPayload = {
        ...resolved.bootstrapPayload,
        modelId: localDeploymentForm.modelId?.trim() || resolved.bootstrapPayload.modelId,
        concreteModelId: localDeploymentForm.modelId?.trim() || resolved.bootstrapPayload.modelId,
        requestedModelId: localDeploymentForm.modelId?.trim() || resolved.bootstrapPayload.modelId,
      };
      setStoredLocalBootstrap(currentScopeId, bootstrapPayload);

      await runLocalBootstrapFlow(resolved.deployment, bootstrapPayload);
      setCurrentView("assistant");
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        localDeployPending: false,
        localCredentialPending: false,
        localDeployError:
          error instanceof Error ? error.message : "本地部署失败，请稍后再试。",
        localDeployFeedback: localRuntimeStatus?.logPath
          ? `可以查看日志：${localRuntimeStatus.logPath}`
          : current.localDeployFeedback,
      }));
      await refreshWorkspaceData();
    }
  };

  const handleRepairLocalDeployment = async (deployment) => {
    if (!deployment) {
      await handleSyncLocalApiKey(null);
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      localDeployPending: true,
      localCredentialPending: false,
      localDeployError: "",
      localDeployFeedback: "正在修复本地 OpenClaw 部署...",
      localDeployResult: null,
    }));

    let bootstrapPayload = null;
    try {
      const resolved = await resolveLocalBootstrapPayloadForDeployment({
        deployment,
        targetScopeId: currentScopeId || deployment?.workspaceId || "",
      });
      bootstrapPayload = resolved.bootstrapPayload;

      if (!bootstrapPayload?.apiKey) {
        throw new Error("缺少本地部署密钥，请重新一键部署以刷新本地引导配置。");
      }

      setStoredLocalBootstrap(currentScopeId || deployment?.workspaceId || "", bootstrapPayload);
      await runLocalBootstrapFlow(resolved.deployment ?? deployment, bootstrapPayload);
      setCurrentView("assistant");
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        localDeployPending: false,
        localCredentialPending: false,
        localDeployError:
          error instanceof Error ? error.message : "修复本地部署失败，请稍后再试。",
        localDeployFeedback: bootstrapPayload?.logPath
          ? `可以查看日志：${bootstrapPayload.logPath}`
          : current.localDeployFeedback,
      }));
      await refreshWorkspaceData();
    }
  };

  const handleUninstallLocalDeployment = async (deployment) => {
    const confirmed = window.confirm(
      deployment
        ? "这会停止并删除本机上的 OpenClaw 运行时、隧道密钥、日志和本地 OpenClaw 配置目录，同时清理当前设备上的本地绑定状态。是否继续？"
        : "这会停止并删除本机上的 OpenClaw 运行时、隧道密钥、日志和本地 OpenClaw 配置目录。是否继续？",
    );
    if (!confirmed) {
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      localDeployPending: true,
      localCredentialPending: false,
      localDeployError: "",
      localDeployFeedback: "正在卸载本地 OpenClaw...",
      localDeployResult: null,
    }));

    let uninstallResult = null;

    try {
      clearStoredLocalBootstraps();
      uninstallResult = await uninstallLocalOpenClaw();
      if (!uninstallResult?.ok) {
        throw new Error(uninstallResult?.error || "本地 OpenClaw 卸载失败，请稍后再试。");
      }
      await syncLocalRuntimeStatus(uninstallResult?.status);
      await refreshWorkspaceData({ withSync: true });
      setLocalDeploymentForm({
        ...DEFAULT_LOCAL_DEPLOYMENT_FORM,
        modelId: resolveDefaultGatewayModelId(modelCatalog),
      });
      setWorkspaceState((current) => ({
        ...current,
        localDeployPending: false,
        localCredentialPending: false,
        localDeployError: "",
        localDeployFeedback: deployment?.id
          ? "本地 OpenClaw 已卸载，本机状态已清理完成。"
          : "本地 OpenClaw 已卸载并清理完成。",
        localDeployResult: null,
      }));
    } catch (error) {
      const uninstallMessage =
        uninstallResult?.ok
          ? "本机文件已清理，但界面刷新失败。"
          : "卸载本地 OpenClaw 失败，请稍后再试。";

      setWorkspaceState((current) => ({
        ...current,
        localDeployPending: false,
        localCredentialPending: false,
        localDeployError: error instanceof Error ? `${uninstallMessage} ${error.message}` : uninstallMessage,
        localDeployFeedback: localRuntimeStatus?.logPath
          ? `可以查看日志：${localRuntimeStatus.logPath}`
          : current.localDeployFeedback,
        localDeployResult: null,
      }));
      await refreshWorkspaceData();
    }
  };

  const handleDeploymentPasswordDraftChange = (deploymentId, value) => {
    setSshPasswordDrafts((current) => ({
      ...current,
      [deploymentId]: value,
    }));
  };

  const handleDeploymentPasswordSave = (deploymentId, publicIp) => {
    const password = sshPasswordDrafts[deploymentId]?.trim() ?? "";
    if (!publicIp || !password) {
      return;
    }

    setStoredSshPassword(publicIp, password);
    setWorkspaceState((current) => ({
      ...current,
      createFeedback: "云端连接密码已记录到当前设备。下次会直接后台自动连接。",
    }));
  };

  const handleDeploymentPasswordClear = (deploymentId, publicIp) => {
    if (!publicIp) {
      return;
    }

    clearStoredSshPassword(publicIp);
    setSshPasswordDrafts((current) => ({
      ...current,
      [deploymentId]: "",
    }));
    setWorkspaceState((current) => ({
      ...current,
      createFeedback: "已清除当前设备保存的云端连接密码。",
    }));
  };

  const handleInstanceTypeChange = (index, value) => {
    setCreateForm((current) => ({
      ...current,
      instanceTypes: current.instanceTypes.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    }));
  };

  const handleCreateDeployment = async () => {
    if ((workspaceState.wallet?.balanceCny ?? 0) <= 0) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "当前余额不足，请先充值后再开通云端实例。",
      }));
      setCurrentView("membership");
      return;
    }

    if (!currentScopeId) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "当前账号尚未完成初始化，请重新登录后再试。",
      }));
      return;
    }

    if (!createForm.name.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "请先填写实例名称。",
      }));
      return;
    }

    if (!createForm.password.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "请先填写云端实例登录密码。",
      }));
      return;
    }

    const instanceTypes = createForm.instanceTypes.map((item) => item.trim()).filter(Boolean);
    if (instanceTypes.length === 0) {
      setWorkspaceState((current) => ({
        ...current,
        createError: "请至少保留一个可用的实例规格。",
      }));
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      createPending: true,
      createError: "",
      createResult: null,
      createDiagnostics: [],
      createFeedback: "",
    }));

    try {
      const result = await fetchJson("/deployments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountScopeId: currentScopeId,
          name: createForm.name.trim(),
          mode: "cloud",
          region: createForm.region.trim(),
          imageId: createForm.imageId.trim(),
          instanceType: instanceTypes[0],
          instanceTypes,
          securityGroupId: createForm.securityGroupId.trim(),
          vSwitchId: createForm.vSwitchId.trim(),
          internetMaxBandwidthOut: Number(createForm.internetMaxBandwidthOut || 0),
          password: createForm.password,
          openclawModelId: createForm.modelId?.trim() || resolveDefaultGatewayModelId(modelCatalog),
          waitForRunning: true,
          waitTimeoutSeconds: 240,
          dryRun: false,
        }),
      });

      const createdPublicIp =
        result.deployment?.publicIpAddress?.[0] ??
        getTunnelHost(result.deployment?.access?.sshTunnel ?? "");
      setStoredSshPassword(createdPublicIp, createForm.password);

      setWorkspaceState((current) => ({
        ...current,
        createPending: false,
        createError: "",
        createResult: result,
        createDiagnostics: result.deployment?.metadata?.instanceTypeAttempts ?? [],
        createFeedback: result.deployment?.access?.dashboardUrl
          ? "实例已就绪。点击“连接云端并开始聊天”后，桌面端会自动在后台建立连接。"
          : "实例已创建成功。等待聊天入口准备好后，就可以直接从桌面端进入聊天。",
      }));
      await refreshWorkspaceData({ withSync: true });
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        createPending: false,
        createError: error instanceof Error ? error.message : "创建实例失败，请稍后再试。",
        createDiagnostics: error?.details?.attempts ?? [],
        createFeedback: "",
      }));
    }
  };

  const handleOpenExternal = async (targetUrl) => {
    if (!targetUrl) {
      return;
    }

    const bridge = getAppBridge();
    if (bridge?.openExternal) {
      await bridge.openExternal(targetUrl);
      return;
    }

    window.open(targetUrl, "_blank", "noopener,noreferrer");
  };

  const handleCopyText = async (value, successMessage) => {
    if (!value) {
      return;
    }

    const bridge = getAppBridge();
    if (bridge?.copyText) {
      await bridge.copyText(value);
    } else if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    }

    setWorkspaceState((current) => ({
      ...current,
      createFeedback: successMessage,
    }));
  };

  const handleLaunchTunnel = async (command, options = {}) => {
    if (!command) {
      return { ok: false };
    }

    setWorkspaceState((current) => ({
      ...current,
      cloudConnectPending: true,
      createError: "",
      createFeedback: "正在连接云端实例并建立本机聊天入口，请稍候…",
    }));

    const result = await launchTunnelCommand(command);
    if (result?.ok) {
      const publicIp = getTunnelHost(command);
      if (publicIp && Number.isFinite(result.port)) {
        setStoredSshPort(publicIp, result.port);
      }
      const fallbackPortNote =
        result.usedFallbackPort && Number.isFinite(result.port)
          ? ` 已自动切换到 SSH 端口 ${result.port}。`
          : "";
      const successMessage = result.alreadyRunning
        ? `当前云端连接已经就绪，正在进入聊天。${fallbackPortNote}`
        : result.replacedExisting
          ? `已切换到当前云端实例，并在后台重新建立连接。连通后会直接进入聊天。${fallbackPortNote}`
          : `云端连接已在后台建立，连通后会直接进入聊天。${fallbackPortNote}`;
      setWorkspaceState((current) => ({
        ...current,
        cloudConnectPending: false,
        createFeedback: successMessage,
      }));
      if (options.navigateToAssistant) {
        setCurrentView("assistant");
      }
      return result;
    }

    setWorkspaceState((current) => ({
      ...current,
      cloudConnectPending: false,
      createFeedback: "",
      createError:
        typeof result?.error === "string" && result.error
          ? result.error
          : "连接云端失败，请稍后再试。",
    }));
    return result;
  };

  const handleGoAssistant = (deploymentId = "") => {
    setPreferredAssistantDeploymentId(
      typeof deploymentId === "string" && deploymentId.trim() ? deploymentId.trim() : "",
    );
    setCurrentView("assistant");
  };

  const handleConnectCloudChat = async (command, deploymentId = "") => {
    if (typeof deploymentId === "string" && deploymentId.trim()) {
      setPreferredAssistantDeploymentId(deploymentId.trim());
    }
    return handleLaunchTunnel(command, { navigateToAssistant: true });
  };

  const handleStopTunnel = async () => {
    const result = await stopTunnelCommand();
    if (result?.ok) {
      setWorkspaceState((current) => ({
        ...current,
        cloudConnectPending: false,
        createFeedback: result.stopped
          ? "已断开当前云端连接。需要时再次点击“连接云端并开始聊天”即可。"
          : "当前没有活动中的云端连接。",
      }));
      setTunnelStatus({
        connected: false,
        dashboardPortOpen: false,
        browserControlPortOpen: false,
        host: "",
        pid: null,
      });
      return;
    }

    setWorkspaceState((current) => ({
      ...current,
      createFeedback: "无法断开当前云端连接，请稍后再试。",
    }));
  };

  const buildOptimisticDeploymentModelRecord = (deployment, modelId) => {
    if (!deployment || typeof deployment !== "object") {
      return deployment;
    }

    const nextGatewayKey =
      deployment.gatewayKey && typeof deployment.gatewayKey === "object"
        ? {
            ...deployment.gatewayKey,
            modelId,
          }
        : deployment.gatewayKey;
    const nextMetadata =
      deployment.metadata && typeof deployment.metadata === "object"
        ? {
            ...deployment.metadata,
            modelId,
            localGatewayModelId: modelId,
          }
        : {
            modelId,
            localGatewayModelId: modelId,
          };

    if (nextMetadata.localRuntime && typeof nextMetadata.localRuntime === "object") {
      nextMetadata.localRuntime = {
        ...nextMetadata.localRuntime,
        currentModelId: modelId,
      };
    }

    return {
      ...deployment,
      gatewayKey: nextGatewayKey,
      metadata: nextMetadata,
    };
  };

  const handleDeploymentModelChange = async (deployment, nextModelId, options = {}) => {
    const deploymentId =
      typeof deployment?.id === "string" && deployment.id.trim() ? deployment.id.trim() : "";
    const normalizedModelId =
      typeof nextModelId === "string" ? nextModelId.trim() : "";
    const sessionKey =
      typeof options?.sessionKey === "string" && options.sessionKey.trim()
        ? options.sessionKey.trim()
        : "main";
    const currentSessionModelId =
      typeof options?.currentSessionModelId === "string" && options.currentSessionModelId.trim()
        ? options.currentSessionModelId.trim()
        : "";
    if (!deploymentId || !normalizedModelId) {
      return { ok: false, error: "missing-model-switch-params" };
    }

    const currentModelId =
      currentSessionModelId ||
      resolveDeploymentGatewayModelId(
        deployment,
        resolveDefaultGatewayModelId(modelCatalog),
      );
    if (currentModelId === normalizedModelId) {
      return { ok: true, skipped: true, modelId: normalizedModelId };
    }

    const nextModel = findGatewayModelCatalogItem(modelCatalog, normalizedModelId);
    const nextModelLabel = nextModel ? formatGatewayModelLabel(nextModel) : normalizedModelId;

    setWorkspaceState((current) => ({
      ...current,
      actionPendingId: deploymentId,
      actionPendingType: "switchModel",
      createError: "",
      createFeedback:
        deployment.mode === "local" ? "" : `正在切换云端实例模型到 ${nextModelLabel}...`,
    }));

    try {
      if (deployment.mode === "local") {
        const storageKey = currentScopeId || deployment.workspaceId || deploymentId;
        const existingBootstrap =
          getStoredLocalBootstrap(storageKey) ?? buildLocalBootstrapFromDeployment(deployment);
        const baseBootstrap =
          existingBootstrap ??
          attachLocalAuthOwner(
            enrichLocalBootstrapPayload(null, deployment, currentScopeId || deployment.workspaceId || ""),
            {
              accountScopeId: currentScopeId,
              user: authState.user,
            },
          );

        if (!baseBootstrap?.apiKey) {
          throw new Error("当前本地配置缺少 API Key，请先同步本地 API Key。");
        }

        const nextBootstrap = {
          ...baseBootstrap,
          accountScopeId: currentScopeId || deployment.workspaceId || baseBootstrap.accountScopeId || "",
          workspaceId: currentScopeId || deployment.workspaceId || baseBootstrap.workspaceId || "",
          deploymentId: deploymentId || baseBootstrap.deploymentId || `local:${currentScopeId || deployment.workspaceId || "local"}`,
          modelId: normalizedModelId,
          concreteModelId: normalizedModelId,
          requestedModelId: normalizedModelId,
          allowedModelIds: Array.from(
            new Set([...(baseBootstrap.allowedModelIds ?? []), normalizedModelId].filter(Boolean)),
          ),
        };

        setStoredLocalBootstrap(storageKey, nextBootstrap);

        const canFastSwitchLocalSession =
          localBootstrapTransportEquals(baseBootstrap, nextBootstrap) &&
          typeof nextBootstrap.dashboardUrl === "string" &&
          Boolean(nextBootstrap.dashboardUrl.trim());

        let runtimeSyncResult = null;
        if (canFastSwitchLocalSession) {
          const lightweightSyncResult = await syncLocalOpenClawAuth({
            ...nextBootstrap,
            modeSwitch: true,
            skipRestart: true,
          });
          await syncLocalRuntimeStatus(lightweightSyncResult?.status);
          if (!lightweightSyncResult?.ok) {
            throw new Error(
              lightweightSyncResult?.error || "本地模型配置已更新，但本地会话切换准备失败。",
            );
          }

          const patchResult = await patchLocalOpenClawSessionModel({
            dashboardUrl: nextBootstrap.dashboardUrl,
            sessionKey,
            modelId: normalizedModelId,
          });
          await syncLocalRuntimeStatus(patchResult?.status ?? lightweightSyncResult?.status);

          if (patchResult?.ok) {
            runtimeSyncResult = patchResult;
          } else {
            const fallbackSyncResult = await syncLocalOpenClawAuth({
              ...nextBootstrap,
              modeSwitch: true,
            });
            await syncLocalRuntimeStatus(fallbackSyncResult?.status);
            if (!fallbackSyncResult?.ok) {
              throw new Error(
                fallbackSyncResult?.error ||
                  patchResult?.error ||
                  "本地模型配置已更新，但本地网关重载失败。",
              );
            }
            runtimeSyncResult = fallbackSyncResult;
          }
        } else {
          const syncResult = await syncLocalOpenClawAuth({
            ...nextBootstrap,
            modeSwitch: true,
          });
          await syncLocalRuntimeStatus(syncResult?.status);
          if (!syncResult?.ok) {
            throw new Error(syncResult?.error || "本地模型配置已更新，但本地网关重载失败。");
          }
          runtimeSyncResult = syncResult;
        }

        const nextRuntimeStatus = await syncLocalRuntimeStatus(runtimeSyncResult?.status);
        const updatedDeployment = buildOptimisticDeploymentModelRecord(
          buildSyntheticLocalDeployment(
            {
              ...localRuntimeStatus,
              ...nextRuntimeStatus,
              currentModelId: normalizedModelId,
              ownerAccountScopeId: nextBootstrap.accountScopeId || localRuntimeStatus.ownerAccountScopeId,
              workspaceId: nextBootstrap.workspaceId || localRuntimeStatus.workspaceId,
              localApiKeyConfigured: true,
              dashboardUrl: nextBootstrap.dashboardUrl || nextRuntimeStatus?.dashboardUrl,
              browserControlUrl:
                nextBootstrap.browserControlUrl || nextRuntimeStatus?.browserControlUrl,
              baseUrl: nextBootstrap.baseUrl || nextRuntimeStatus?.baseUrl,
            },
            nextBootstrap.accountScopeId || currentScopeId || deployment.workspaceId || "",
          ) ?? deployment,
          normalizedModelId,
        );

        setWorkspaceState((current) => ({
          ...current,
          actionPendingId: null,
          actionPendingType: "",
          createError: "",
          createFeedback: "",
        }));

        return { ok: true, modelId: normalizedModelId, deployment: updatedDeployment };
      }

      const result = await fetchJson(`/deployments/${deploymentId}/model`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          modelId: normalizedModelId,
        }),
      });

      const updatedDeployment = result?.deployment ?? deployment;
      applyDeploymentSnapshot(updatedDeployment);
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createError: "",
        createFeedback:
          deployment.mode === "local" ? "" : `当前实例已切换到 ${nextModelLabel}。`,
      }));
      void refreshWorkspaceDeployments({ silent: true });
      return { ok: true, modelId: normalizedModelId, deployment: updatedDeployment };
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createError: error instanceof Error ? error.message : "切换模型失败，请稍后再试。",
      }));
      void refreshWorkspaceDeployments({ silent: true });
      return {
        ok: false,
        error: error instanceof Error ? error.message : "切换模型失败，请稍后再试。",
      };
    }
  };

  const handleDeploymentAction = async (deploymentId, action) => {
    const targetDeployment = workspaceState.deployments.find((item) => item.id === deploymentId) ?? null;
    const actionMap = {
      start: { method: "POST", path: `/deployments/${deploymentId}/start`, success: "实例已启动。" },
      stop: { method: "POST", path: `/deployments/${deploymentId}/stop`, success: "实例已停止。" },
      restart: { method: "POST", path: `/deployments/${deploymentId}/restart`, success: "实例已重启。" },
      refreshResponses: {
        method: "POST",
        path: `/deployments/${deploymentId}/refresh-native-responses`,
        success: "已刷新为原生 responses 配置并重启网关。",
      },
      destroy: { method: "DELETE", path: `/deployments/${deploymentId}`, success: "实例已销毁。" },
    };

    const config = actionMap[action];
    if (!config) {
      return;
    }

      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: deploymentId,
        actionPendingType: action,
        createError: "",
        createFeedback: "",
      }));

    try {
      await fetchJson(config.path, { method: config.method });
      if (action === "destroy" && targetDeployment?.mode === "local") {
        await resetLocalRuntimeBinding({
          clearBinding: true,
        });
      }
      await refreshWorkspaceData({ withSync: true });
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createFeedback: config.success,
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createError: error instanceof Error ? error.message : "实例操作失败，请稍后再试。",
      }));
    }
  };

  const handleBulkRefreshNativeResponses = async () => {
    setWorkspaceState((current) => ({
      ...current,
      actionPendingId: BULK_REFRESH_NATIVE_RESPONSES_ACTION_ID,
      actionPendingType: "refreshResponsesAll",
      createError: "",
      createFeedback: "",
    }));

    try {
      const result = await fetchJson("/deployments/refresh-native-responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountScopeId: currentScopeId,
        }),
      });
      await refreshWorkspaceData({ withSync: true });
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createFeedback: `批量刷新完成：${result?.refreshed ?? 0} 个已切换，${result?.skipped ?? 0} 个跳过，${result?.failed ?? 0} 个失败。`,
      }));
    } catch (error) {
      setWorkspaceState((current) => ({
        ...current,
        actionPendingId: null,
        actionPendingType: "",
        createError: error instanceof Error ? error.message : "批量刷新失败，请稍后再试。",
      }));
    }
  };

  const operationNotice = workspaceState.createPending
    ? {
        title: "正在创建云端实例",
        body: "系统会按实例规格顺序自动尝试，创建成功后会继续拉起 OpenClaw，桌面端后续会自动接管云端连接。",
      }
    : workspaceState.actionPendingId
      ? {
          title: "正在更新实例状态",
          body: `正在执行${
            {
              start: "启动",
              stop: "停止",
              restart: "重启",
              refreshResponses: "刷新原生 responses",
              refreshResponsesAll: "批量刷新原生 responses",
              switchModel: "切换模型",
              destroy: "销毁",
            }[workspaceState.actionPendingType] ?? "实例操作"
          }，页面会以更高频率自动刷新。`,
        }
      : null;

  const meta = VIEW_META[currentView] ?? VIEW_META.assistant;
  const showTopbar =
    currentView !== "assistant" &&
    currentView !== "membership" &&
    currentView !== "settings" &&
    currentView !== "home";
  const mainClassName = [
    "main",
    showTopbar ? "" : "main--no-topbar",
    currentView === "assistant" ? "main--assistant" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const activeDeploymentCount = useMemo(
    () => {
      const localDeployment = findLocalDeployment(workspaceState.deployments, localRuntimeStatus);
      const cloudCount = workspaceState.deployments.filter(
        (item) => isUsableDeploymentOnCurrentDesktop(item, localRuntimeStatus),
      ).length;
      const localCount =
        localDeployment && isUsableDeploymentOnCurrentDesktop(localDeployment, localRuntimeStatus) ? 1 : 0;
      return cloudCount + localCount;
    },
    [localRuntimeStatus, workspaceState.deployments],
  );

  useEffect(() => {
    if (!preferredAssistantDeploymentId) {
      return;
    }
    const localDeployment = findLocalDeployment(workspaceState.deployments, localRuntimeStatus);
    if (localDeployment?.id === preferredAssistantDeploymentId) {
      return;
    }
    const preferredDeployment =
      workspaceState.deployments.find((item) => item.id === preferredAssistantDeploymentId) ?? null;
    if (
      preferredDeployment &&
      !shouldHideDesktopForeignLocalDeployment(preferredDeployment, localRuntimeStatus)
    ) {
      return;
    }
    setPreferredAssistantDeploymentId("");
  }, [preferredAssistantDeploymentId, localRuntimeStatus, workspaceState.deployments]);

  if (authState.loading) {
    return (
      <div className="auth-shell">
        <div className="ambient ambient-a"></div>
        <div className="ambient ambient-b"></div>
        <div className="ambient ambient-c"></div>
        <section className="auth-card">
          <div className="eyebrow">Xiaolanbu Cloud</div>
          <h1 className="auth-title">正在准备你的账号与云端状态…</h1>
        </section>
      </div>
    );
  }

  if (!authState.sessionToken) {
    return (
      <AuthView
        authMode={authState.authMode}
        authForm={authState.authForm}
        authPending={authState.authPending}
        authError={authState.authError}
        onAuthFormChange={handleAuthFormChange}
        onAuthSubmit={handleAuthSubmit}
        onAuthModeChange={handleAuthModeChange}
      />
    );
  }

  return (
    <>
      <div className="ambient ambient-a"></div>
      <div className="ambient ambient-b"></div>
      <div className="ambient ambient-c"></div>

      <div className="shell">
        <AppSidebar
          currentView={currentView}
          setCurrentView={setCurrentView}
          wallet={workspaceState.wallet}
          activeDeploymentCount={activeDeploymentCount}
        />

        <main className={mainClassName}>
          {showTopbar ? (
            <header className="topbar">
              <div className="topbar-copy">
                <div className="eyebrow">{meta.eyebrow}</div>
                <h1 className="page-title">{meta.title}</h1>
              </div>
              <div className="topbar-actions app-no-drag">
                <div className="pill">
                  <span className="pill-dot"></span>
                  {activeDeploymentCount > 0 ? `实例在线 · ${activeDeploymentCount}` : "暂无可用实例"}
                </div>
                <div className="pill">{authState.user?.displayName ?? "当前用户"}</div>
                <button
                  className="icon-button"
                  aria-label="Refresh"
                  onClick={() => refreshWorkspaceData({ withSync: currentView === "membership" })}
                >
                  ↻
                </button>
                <button className="ghost-button small" onClick={handleLogout}>
                  退出
                </button>
                {currentView !== "home" ? (
                  <button className="primary-button" onClick={() => setCurrentView("assistant")}>
                    开始聊天
                  </button>
                ) : null}
              </div>
            </header>
          ) : null}

          {currentView === "home" ? (
            <HomeView
              go={setCurrentView}
              wallet={workspaceState.wallet}
              usageSummary={workspaceState.usageSummary}
              activeDeploymentCount={activeDeploymentCount}
              onLogout={handleLogout}
            />
          ) : null}
          {currentView === "assistant" ? (
            <AssistantView
              deployments={workspaceState.deployments}
              preferredDeploymentId={preferredAssistantDeploymentId}
              modelCatalog={modelCatalog}
              onLaunchTunnel={handleLaunchTunnel}
              onStopTunnel={handleStopTunnel}
              onOpenExternal={handleOpenExternal}
              onCopyText={handleCopyText}
              onBootstrapLocal={handleCreateLocalDeployment}
              onRepairLocal={handleRepairLocalDeployment}
              onDeploymentModelChange={handleDeploymentModelChange}
              go={setCurrentView}
              tunnelStatus={tunnelStatus}
              localRuntimeStatus={localRuntimeStatus}
              workspaceFeedback={workspaceState.createFeedback}
              workspaceError={workspaceState.createError}
              cloudConnectPending={workspaceState.cloudConnectPending}
              actionPendingId={workspaceState.actionPendingId}
              actionPendingType={workspaceState.actionPendingType}
              onClearWorkspaceFeedback={() =>
                setWorkspaceState((current) => ({
                  ...current,
                  createFeedback: "",
                }))
              }
            />
          ) : null}
          {currentView === "membership" ? (
            <MembershipView
              wallet={workspaceState.wallet}
              usageSummary={workspaceState.usageSummary}
              deploymentSummaries={workspaceState.deploymentSummaries}
              transactions={workspaceState.transactions}
              loading={workspaceState.loading}
              error={workspaceState.error}
              topupAmount={topupAmount}
              setTopupAmount={setTopupAmount}
              topupPending={workspaceState.topupPending}
              syncPending={workspaceState.syncing}
              onTopup={handleTopup}
              onRefresh={() => refreshWorkspaceData({ withSync: true })}
            />
          ) : null}
          {currentView === "settings" ? (
            <SettingsView
              currentUser={authState.user}
              deployments={workspaceState.deployments}
              modelCatalog={modelCatalog}
              wallet={workspaceState.wallet}
              syncing={workspaceState.syncing}
              onRefresh={() => refreshWorkspaceData({ withSync: true })}
              currentScopeId={currentScopeId}
              createForm={createForm}
              onFormChange={handleCreateFormChange}
              onInstanceTypeChange={handleInstanceTypeChange}
              createPending={workspaceState.createPending}
              createError={workspaceState.createError}
              createResult={workspaceState.createResult}
              createDiagnostics={workspaceState.createDiagnostics}
              createFeedback={workspaceState.createFeedback}
              operationNotice={operationNotice}
              onCreate={handleCreateDeployment}
              onOpenExternal={handleOpenExternal}
              onCopyText={handleCopyText}
              onLaunchTunnel={handleLaunchTunnel}
              onConnectCloudChat={handleConnectCloudChat}
              onStopTunnel={handleStopTunnel}
              onGoAssistant={handleGoAssistant}
              onGoMembership={() => setCurrentView("membership")}
              cloudConnectPending={workspaceState.cloudConnectPending}
              actionPendingId={workspaceState.actionPendingId}
              actionPendingType={workspaceState.actionPendingType}
              onDeploymentAction={handleDeploymentAction}
              onDeploymentModelChange={handleDeploymentModelChange}
              profileForm={profileForm}
              profilePending={workspaceState.profilePending}
              profileError={workspaceState.profileError}
              passwordForm={passwordForm}
              passwordPending={workspaceState.passwordPending}
              passwordError={workspaceState.passwordError}
              onProfileFieldChange={handleProfileFieldChange}
              onPasswordFieldChange={handlePasswordFieldChange}
              onProfileSave={handleProfileSave}
              onPasswordSave={handlePasswordSave}
              sshPasswordDrafts={sshPasswordDrafts}
              onDeploymentPasswordDraftChange={handleDeploymentPasswordDraftChange}
              onDeploymentPasswordSave={handleDeploymentPasswordSave}
              onDeploymentPasswordClear={handleDeploymentPasswordClear}
              tunnelStatus={tunnelStatus}
              localDeploymentForm={localDeploymentForm}
              onLocalDeploymentFormChange={handleLocalDeploymentFormChange}
              localRuntimeStatus={localRuntimeStatus}
              localDeployPending={workspaceState.localDeployPending}
              localCredentialPending={workspaceState.localCredentialPending}
              localDeployError={workspaceState.localDeployError}
              localDeployFeedback={workspaceState.localDeployFeedback}
              localDeployResult={workspaceState.localDeployResult}
              onCreateLocalDeployment={handleCreateLocalDeployment}
              onSyncLocalApiKey={handleSyncLocalApiKey}
              onClearLocalApiKey={handleClearLocalApiKey}
              onRepairLocalDeployment={handleRepairLocalDeployment}
              onBulkRefreshNativeResponses={handleBulkRefreshNativeResponses}
              onUninstallLocalDeployment={handleUninstallLocalDeployment}
              localClearKeyOnLogout={localClearKeyOnLogout}
              onToggleLocalClearKeyOnLogout={handleToggleLocalClearKeyOnLogout}
            />
          ) : null}
        </main>
      </div>
    </>
  );
}
