const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const IS_MAC = process.platform === "darwin";
const LOCAL_APP_SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "Xiaolanbu");
const LOCAL_QIANNIU_HELPER_DIR = path.join(LOCAL_APP_SUPPORT_DIR, "support-helper");
const LOCAL_QIANNIU_HELPER_BIN_DIR = path.join(LOCAL_QIANNIU_HELPER_DIR, "bin");
const LOCAL_QIANNIU_HELPER_BINARY_PATH = path.join(LOCAL_QIANNIU_HELPER_BIN_DIR, "qianniu-ax-helper");
const QIANNIU_HELPER_SOURCE_PATH = path.join(__dirname, "qianniu-ax-helper.swift");
const QIANNIU_BUNDLE_IDENTIFIER = "com.taobao.Aliworkbench";
const QIANNIU_APP_PATH = "/Applications/Aliworkbench.app";
const QIANNIU_REMINDER_WINDOW_KEYWORDS = Object.freeze(["消息提醒", "提醒"]);

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function normalizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function execFileJson(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs || 20000,
        maxBuffer: options.maxBuffer || 1024 * 1024 * 4,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message || "command failed"));
          return;
        }
        try {
          resolve(stdout && stdout.trim() ? JSON.parse(stdout.trim()) : {});
        } catch {
          reject(new Error("helper returned non-JSON output"));
        }
      },
    );
  });
}

function ensureQianNiuHelperBinary() {
  if (!IS_MAC) {
    return {
      ok: false,
      error: "QianNiu AX helper is only available on macOS.",
      helperAvailable: false,
    };
  }
  if (!fs.existsSync(QIANNIU_HELPER_SOURCE_PATH)) {
    return {
      ok: false,
      error: "QianNiu AX helper source is missing.",
      helperAvailable: false,
    };
  }
  ensureDirectory(LOCAL_QIANNIU_HELPER_BIN_DIR);
  const needsCompile =
    !fs.existsSync(LOCAL_QIANNIU_HELPER_BINARY_PATH) ||
    fs.statSync(LOCAL_QIANNIU_HELPER_BINARY_PATH).mtimeMs <
      fs.statSync(QIANNIU_HELPER_SOURCE_PATH).mtimeMs;
  if (!needsCompile) {
    return {
      ok: true,
      helperAvailable: true,
      binaryPath: LOCAL_QIANNIU_HELPER_BINARY_PATH,
    };
  }
  try {
    require("child_process").execFileSync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-O",
        QIANNIU_HELPER_SOURCE_PATH,
        "-o",
        LOCAL_QIANNIU_HELPER_BINARY_PATH,
      ],
      {
        stdio: "pipe",
        maxBuffer: 1024 * 1024 * 8,
      },
    );
    return {
      ok: true,
      helperAvailable: true,
      binaryPath: LOCAL_QIANNIU_HELPER_BINARY_PATH,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to compile QianNiu helper",
      helperAvailable: false,
    };
  }
}

async function runQianNiuHelper(command, args = [], options = {}) {
  const ensured = ensureQianNiuHelperBinary();
  if (!ensured.ok || !ensured.binaryPath) {
    return {
      ok: false,
      helperAvailable: false,
      error: ensured.error || "QianNiu helper is unavailable.",
    };
  }
  try {
    const payload = await execFileJson(
      ensured.binaryPath,
      [command, ...args],
      { timeoutMs: options.timeoutMs || 20000 },
    );
    return {
      helperAvailable: true,
      ...payload,
    };
  } catch (error) {
    return {
      ok: false,
      helperAvailable: true,
      error: error instanceof Error ? error.message : "QianNiu helper failed",
    };
  }
}

function nodeLabel(node) {
  if (!node || typeof node !== "object") {
    return "";
  }
  const candidates = [node.title, node.value, node.elementDescription];
  for (const entry of candidates) {
    const normalized = normalizeString(entry);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeThreadId(label) {
  return normalizeString(label)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
}

function isTimestampLikeLine(text) {
  const value = normalizeString(text);
  return (
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}$/.test(value) ||
    /^[A-Za-z\u4e00-\u9fff]?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}$/.test(value)
  );
}

function isReadMarkerLine(text) {
  const value = normalizeString(text);
  return value === "已读" || value === "未读";
}

function isSystemWarningLine(text) {
  const value = normalizeString(text);
  if (!value) {
    return false;
  }
  return (
    value === "淘宝官方预警" ||
    value === "风险预测" ||
    value.includes("超10分钟未回复买家") ||
    value.includes("影响您的店铺真实体验分") ||
    value.includes("服务管理规范赔付处理") ||
    value.includes("影响人工响应率")
  );
}

function normalizeOcrTextLines(lines = []) {
  return (Array.isArray(lines) ? lines : [])
    .map((entry) => normalizeString(typeof entry === "string" ? entry : entry?.text))
    .filter(Boolean);
}

function parseTimestampSpeakerLine(text) {
  const value = normalizeString(text);
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\s+(.+)$/);
  if (!match) {
    return null;
  }
  return {
    timestamp: normalizeString(match[1]),
    speaker: normalizeString(match[2]),
  };
}

function parseQianNiuOcrHistory({ lines = [], buyerName = "" } = {}) {
  const normalizedBuyerName = normalizeString(buyerName);
  const filtered = normalizeOcrTextLines(lines).filter(
    (line) =>
      !isReadMarkerLine(line) &&
      !isSystemWarningLine(line),
  );
  const counts = new Map();
  for (const line of filtered) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  const sellerLabels = new Set();
  for (const line of filtered) {
    const speakerLine = parseTimestampSpeakerLine(line);
    if (speakerLine?.speaker && speakerLine.speaker !== normalizedBuyerName) {
      sellerLabels.add(speakerLine.speaker);
    }
    if (
      line !== normalizedBuyerName &&
      line.length <= 24 &&
      (counts.get(line) || 0) >= 2
    ) {
      sellerLabels.add(line);
    }
  }

  let currentRole = "buyer";
  let currentTimestamp = "";
  let currentBuffer = [];
  const history = [];

  function flushBuffer() {
    if (currentBuffer.length === 0) {
      return;
    }
    history.push({
      role: currentRole,
      text: currentBuffer.join(" ").trim(),
      timestamp: currentTimestamp || new Date().toISOString(),
    });
    currentBuffer = [];
  }

  for (const line of filtered) {
    const speakerLine = parseTimestampSpeakerLine(line);
    if (speakerLine) {
      flushBuffer();
      currentTimestamp = speakerLine.timestamp || "";
      currentRole = speakerLine.speaker === normalizedBuyerName ? "buyer" : "assistant";
      continue;
    }
    if (isTimestampLikeLine(line)) {
      flushBuffer();
      currentTimestamp = line;
      continue;
    }
    if (line === normalizedBuyerName) {
      flushBuffer();
      currentRole = "buyer";
      continue;
    }
    if (sellerLabels.has(line)) {
      flushBuffer();
      currentRole = "assistant";
      continue;
    }
    currentBuffer.push(line);
  }
  flushBuffer();

  const latestBuyerMessage =
    history
      .slice()
      .reverse()
      .find((entry) => entry.role === "buyer" && normalizeString(entry.text))?.text || "";

  return {
    history,
    latestBuyerMessage,
    sellerLabels: Array.from(sellerLabels),
  };
}

function pickQianNiuConversationWindow(windows = []) {
  const source = Array.isArray(windows) ? windows : [];
  return (
    source.find((entry) => normalizeString(entry?.title).includes("接待中心")) ||
    source
      .slice()
      .sort((left, right) => (right?.nodeCount || 0) - (left?.nodeCount || 0))[0] ||
    null
  );
}

function frameContains(frame, { minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity } = {}) {
  if (!frame || typeof frame !== "object") {
    return false;
  }
  const x = Number(frame.x || 0);
  const y = Number(frame.y || 0);
  const width = Number(frame.width || 0);
  const height = Number(frame.height || 0);
  return (
    x >= minX &&
    x + width <= maxX &&
    y >= minY &&
    y + height <= maxY
  );
}

function looksLikeHumanConversationLabel(label) {
  const text = normalizeString(label);
  if (!text || text.length < 2 || text.length > 48) {
    return false;
  }
  const ignored = new Set([
    "正在接待买家列表",
    "正在接待",
    "全部会话列表",
    "列表分组关闭",
    "最后一句消息",
    "消息",
    "进店",
    "工单",
    "离线消息",
    "打单工具",
    "选择表情",
    "转发当前用户",
    "新建任务",
    "更多",
    "快捷短语",
    "查看消息记录",
    "客服",
    "在线",
    "辅助中",
    "挂起",
    "展开",
  ]);
  if (ignored.has(text)) {
    return false;
  }
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(text);
}

function deriveQianNiuThreads(snapshot = {}) {
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) {
    return [];
  }
  const window = pickQianNiuConversationWindow(windows);
  const nodes = Array.isArray(window?.nodes) ? window.nodes : [];
  const threadRowCandidates = nodes.filter((node) => {
    const label = nodeLabel(node);
    const frame = node.frame;
    return (
      /^0\.39\.0\.\d+$/.test(String(node.path || "")) &&
      node.role === "AXGroup" &&
      looksLikeHumanConversationLabel(label) &&
      frameContains(frame, {
        minX: 260,
        maxX: 540,
        minY: 320,
        maxY: 920,
      }) &&
      Number(frame?.width || 0) >= 180 &&
      Number(frame?.height || 0) >= 40
    );
  });
  return threadRowCandidates
    .map((entry) => ({
      label: nodeLabel(entry),
      frame: entry.frame,
    }))
    .sort((left, right) => Number(left.frame?.y || 0) - Number(right.frame?.y || 0))
    .slice(0, 40)
    .map((entry, index) => ({
      threadId: normalizeThreadId(entry.label) || `thread-${index + 1}`,
      buyerName: entry.label,
      buyerId: "",
      latestMessage: "",
      history: [],
      orderRefs: [],
      status: "open",
      source: "qianniu-ax",
      frame: entry.frame,
    }));
}

function isQianNiuReminderWindow(window = {}) {
  const title = normalizeString(window?.title);
  if (
    QIANNIU_REMINDER_WINDOW_KEYWORDS.some((keyword) => title.includes(keyword))
  ) {
    return true;
  }
  if (title.includes("接待中心") || title.includes("工作台")) {
    return false;
  }
  const frame = window?.frame || {};
  return (
    Number(frame?.width || 0) > 0 &&
    Number(frame?.width || 0) <= 520 &&
    Number(frame?.height || 0) > 0 &&
    Number(frame?.height || 0) <= 320 &&
    Number(frame?.x || 0) >= 900
  );
}

function deriveQianNiuReminderThread(snapshot = {}) {
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  const reminderWindow = windows.find((entry) => isQianNiuReminderWindow(entry));
  if (!reminderWindow) {
    return null;
  }

  const candidate = (Array.isArray(reminderWindow.nodes) ? reminderWindow.nodes : [])
    .filter((node) => {
      const label = nodeLabel(node);
      if (!looksLikeHumanConversationLabel(label)) {
        return false;
      }
      const frame = node?.frame || {};
      return Number(frame?.width || 0) >= 40 && Number(frame?.height || 0) >= 14;
    })
    .sort((left, right) => {
      if (Number(left?.frame?.y || 0) !== Number(right?.frame?.y || 0)) {
        return Number(left?.frame?.y || 0) - Number(right?.frame?.y || 0);
      }
      if (Number(left?.frame?.x || 0) !== Number(right?.frame?.x || 0)) {
        return Number(left?.frame?.x || 0) - Number(right?.frame?.x || 0);
      }
      return Number(right?.frame?.width || 0) - Number(left?.frame?.width || 0);
    })[0];

  const label = nodeLabel(candidate);
  if (!label) {
    return null;
  }

  return {
    threadId: normalizeThreadId(label) || label,
    buyerName: label,
    buyerId: "",
    source: "qianniu-popup",
    attentionState: "popup",
    reminderWindowTitle: normalizeString(reminderWindow.title),
    frame: candidate?.frame || reminderWindow?.frame || null,
  };
}

function deriveQianNiuCurrentThread(snapshot = {}, existingThread = null) {
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) {
    return existingThread;
  }
  const window = pickQianNiuConversationWindow(windows);
  const nodes = Array.isArray(window?.nodes) ? window.nodes : [];
  const headerCandidates = nodes
    .filter((node) => {
      const label = nodeLabel(node);
      const frame = node.frame;
      return (
        looksLikeHumanConversationLabel(label) &&
        !label.includes("偏好") &&
        frame &&
        frameContains(frame, {
          minX: 540,
          maxX: 900,
          minY: 160,
          maxY: 220,
        }) &&
        Number(frame.width || 0) >= 60
      );
    })
    .sort((left, right) => {
      if (Number(left.frame?.y || 0) !== Number(right.frame?.y || 0)) {
        return Number(left.frame?.y || 0) - Number(right.frame?.y || 0);
      }
      return Number(left.frame?.x || 0) - Number(right.frame?.x || 0);
    });
  const existingIdentityCandidates = [
    normalizeString(existingThread?.buyerName),
    normalizeString(existingThread?.threadId),
    normalizeString(existingThread?.buyerId),
  ]
    .map((entry) => entry.toLowerCase())
    .filter(Boolean);
  const headerCandidate =
    headerCandidates.find((node) => {
      const label = nodeLabel(node).toLowerCase();
      return existingIdentityCandidates.includes(label);
    }) || headerCandidates[0];

  const currentTitle = nodeLabel(headerCandidate) || existingThread?.buyerName || "";
  const messageNodes = nodes
    .filter((node) => {
      const label = nodeLabel(node);
      const frame = node.frame;
      if (!label || !frame) {
        return false;
      }
      if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(label)) {
        return false;
      }
      return (
        frameContains(frame, {
          minX: 540,
          maxX: 1048,
          minY: 220,
          maxY: 620,
        }) &&
        label.length <= 300 &&
        ![
          "转发当前用户",
          "新建任务",
          "更多",
          "专属优惠",
          "优惠计算",
          "邀请下单",
          "邀请物流客服",
          "更多功能",
          "快捷短语",
          "查看消息记录",
          "选择表情",
          "截图",
          "计算器",
        ].includes(label)
      );
    })
    .sort((left, right) => {
      if (Number(left.frame?.y || 0) !== Number(right.frame?.y || 0)) {
        return Number(left.frame?.y || 0) - Number(right.frame?.y || 0);
      }
      return Number(left.frame?.x || 0) - Number(right.frame?.x || 0);
    });

  const history = messageNodes.map((node) => ({
    role: "buyer",
    text: nodeLabel(node),
    timestamp: new Date().toISOString(),
  }));

  const latestBuyerMessage =
    history
      .slice()
      .reverse()
      .find((entry) => entry.role === "buyer" && normalizeString(entry.text))?.text ||
    history[history.length - 1]?.text ||
    existingThread?.latestMessage ||
    "";

  return {
    ...(existingThread && typeof existingThread === "object" ? existingThread : {}),
    threadId: existingThread?.threadId || normalizeThreadId(currentTitle) || "qianniu-current-thread",
    buyerName: currentTitle || existingThread?.buyerName || "",
    latestMessage: latestBuyerMessage,
    history: history.length > 0 ? history : Array.isArray(existingThread?.history) ? existingThread.history : [],
    source: "qianniu-ax",
  };
}

async function getQianNiuHelperStatus() {
  return runQianNiuHelper("status");
}

async function requestQianNiuAccessibility() {
  return runQianNiuHelper("request-accessibility");
}

async function inspectQianNiuUi() {
  const result = await runQianNiuHelper("inspect-ui", [], { timeoutMs: 25000 });
  if (!result?.ok) {
    return result;
  }
  return {
    ...result,
    derivedThreads: deriveQianNiuThreads(result),
    reminderThread: deriveQianNiuReminderThread(result),
  };
}

async function openQianNiuThread({ threadTitle = "" } = {}) {
  return runQianNiuHelper(
    "open-thread",
    ["--thread-title", normalizeString(threadTitle)],
    { timeoutMs: 25000 },
  );
}

async function readQianNiuThread({ threadTitle = "", existingThread = null } = {}) {
  const normalizedTitle = normalizeString(threadTitle);
  if (normalizedTitle) {
    const openResult = await openQianNiuThread({ threadTitle: normalizedTitle });
    if (!openResult?.ok) {
      return {
        ok: false,
        helperAvailable: openResult?.helperAvailable !== false,
        error: openResult?.error || "Failed to activate QianNiu thread.",
      };
    }
  }
  const inspectResult = await inspectQianNiuUi();
  if (!inspectResult?.ok) {
    return inspectResult;
  }
  const thread = deriveQianNiuCurrentThread(inspectResult, existingThread);
  const ocrResult = await ocrQianNiuCurrentThread();
  if (ocrResult?.ok) {
    const parsed = parseQianNiuOcrHistory({
      lines: ocrResult.lines,
      buyerName: thread?.buyerName || normalizedTitle,
    });
    if (parsed.history.length > 0) {
      thread.history = parsed.history;
    }
    if (parsed.latestBuyerMessage) {
      thread.latestMessage = parsed.latestBuyerMessage;
    }
    thread.ocr = {
      text: normalizeString(ocrResult.text),
      sellerLabels: parsed.sellerLabels,
      cropFrame: ocrResult.cropFrame || null,
    };
  }
  return {
    ...inspectResult,
    thread,
  };
}

async function sendQianNiuReply({ threadTitle = "", message = "" } = {}) {
  return runQianNiuHelper(
    "send-reply",
    ["--thread-title", normalizeString(threadTitle), "--message", normalizeString(message)],
    { timeoutMs: 25000 },
  );
}

async function pressQianNiuLabel({ label = "" } = {}) {
  return runQianNiuHelper(
    "press-label",
    ["--label", normalizeString(label)],
    { timeoutMs: 25000 },
  );
}

async function inspectQianNiuAttributes({ path = "" } = {}) {
  return runQianNiuHelper(
    "inspect-attributes",
    ["--path", normalizeString(path)],
    { timeoutMs: 25000 },
  );
}

async function ocrQianNiuCurrentThread() {
  return runQianNiuHelper("ocr-current-thread", [], { timeoutMs: 30000 });
}

module.exports = {
  IS_MAC,
  QIANNIU_APP_PATH,
  QIANNIU_BUNDLE_IDENTIFIER,
  deriveQianNiuCurrentThread,
  deriveQianNiuReminderThread,
  deriveQianNiuThreads,
  ensureQianNiuHelperBinary,
  getQianNiuHelperStatus,
  inspectQianNiuUi,
  openQianNiuThread,
  inspectQianNiuAttributes,
  ocrQianNiuCurrentThread,
  pressQianNiuLabel,
  readQianNiuThread,
  requestQianNiuAccessibility,
  sendQianNiuReply,
};
