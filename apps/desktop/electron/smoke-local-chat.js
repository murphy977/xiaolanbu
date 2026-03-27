const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { chromium } = require("playwright");

const IS_WINDOWS = process.platform === "win32";
const WINDOWS_LOCAL_APP_DATA =
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const LOCAL_APP_SUPPORT_DIR = IS_WINDOWS
  ? path.join(WINDOWS_LOCAL_APP_DATA, "Xiaolanbu")
  : path.join(os.homedir(), "Library", "Application Support", "Xiaolanbu");
const LOCAL_OPENCLAW_STATE_DIR = path.join(os.homedir(), ".openclaw");
const LOCAL_OPENCLAW_CONFIG_PATH = path.join(LOCAL_OPENCLAW_STATE_DIR, "openclaw.json");
const LOCAL_OPENCLAW_AUTH_STORE_PATH = path.join(
  LOCAL_OPENCLAW_STATE_DIR,
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);
const LOCAL_GATEWAY_LOG_PATH = path.join(LOCAL_OPENCLAW_STATE_DIR, "logs", "gateway.log");
const LOCAL_GATEWAY_ERR_LOG_PATH = path.join(LOCAL_OPENCLAW_STATE_DIR, "logs", "gateway.err.log");
const DEFAULT_DASHBOARD_PORT = 18789;
const RESPONSE_TIMEOUT_MS = Number(process.env.XLB_SMOKE_RESPONSE_TIMEOUT_MS || 60_000);
const PAGE_TIMEOUT_MS = Number(process.env.XLB_SMOKE_PAGE_TIMEOUT_MS || 30_000);
const POLL_INTERVAL_MS = 500;

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readSlice(filePath, startOffset) {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return "";
    }

    const start = Math.max(0, Math.min(startOffset, stats.size));
    if (start >= stats.size) {
      return "";
    }

    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stats.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function getFileSize(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return 0;
    }

    const stats = fs.statSync(filePath);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

function hasConfiguredAuth(authStore) {
  if (!authStore || typeof authStore !== "object") {
    return false;
  }

  const profiles =
    authStore.profiles && typeof authStore.profiles === "object" ? authStore.profiles : {};
  return Object.keys(profiles).length > 0;
}

function checkPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (open) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(800);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", () => finalize(false));
    socket.connect(port, "127.0.0.1");
  });
}

function resolveGatewayToken(config) {
  const gateway =
    config && typeof config === "object" && config.gateway && typeof config.gateway === "object"
      ? config.gateway
      : {};
  const auth =
    gateway.auth && typeof gateway.auth === "object" ? gateway.auth : {};
  return typeof auth.token === "string" && auth.token.trim() ? auth.token.trim() : "";
}

function resolveGatewayPort(config) {
  const gateway =
    config && typeof config === "object" && config.gateway && typeof config.gateway === "object"
      ? config.gateway
      : {};
  const port = Number(gateway.port || DEFAULT_DASHBOARD_PORT);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_DASHBOARD_PORT;
}

async function launchBrowser() {
  const explicitExecutablePath = process.env.XLB_SMOKE_BROWSER_PATH?.trim();
  if (explicitExecutablePath) {
    return chromium.launch({
      executablePath: explicitExecutablePath,
      headless: true,
    });
  }

  const candidateChannels = IS_WINDOWS ? ["msedge", "chrome"] : ["chrome", "msedge"];
  let lastError = null;

  for (const channel of candidateChannels) {
    try {
      return await chromium.launch({
        channel,
        headless: true,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No supported browser channel is available for Playwright.");
}

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function runLocalChatSmokeTest() {
  const config = readJsonFile(LOCAL_OPENCLAW_CONFIG_PATH);
  const authStore = readJsonFile(LOCAL_OPENCLAW_AUTH_STORE_PATH);
  const gatewayToken = resolveGatewayToken(config);
  const gatewayPort = resolveGatewayPort(config);
  const dashboardUrl = `http://127.0.0.1:${gatewayPort}/#token=${gatewayToken}`;
  const authConfigured = hasConfiguredAuth(authStore);

  if (!config) {
    fail("Local OpenClaw config is missing.", { configPath: LOCAL_OPENCLAW_CONFIG_PATH });
  }

  if (!gatewayToken) {
    fail("Local OpenClaw gateway token is missing.", { configPath: LOCAL_OPENCLAW_CONFIG_PATH });
  }

  if (!authConfigured) {
    fail("Local OpenClaw auth store has no configured API key.", {
      authStorePath: LOCAL_OPENCLAW_AUTH_STORE_PATH,
    });
  }

  const [dashboardPortOpen, browserControlPortOpen] = await Promise.all([
    checkPortOpen(gatewayPort),
    checkPortOpen(gatewayPort + 2),
  ]);

  if (!dashboardPortOpen || !browserControlPortOpen) {
    fail("Local OpenClaw ports are not ready.", {
      gatewayPort,
      dashboardPortOpen,
      browserControlPortOpen,
    });
  }

  const gatewayLogOffset = getFileSize(LOCAL_GATEWAY_LOG_PATH);
  const gatewayErrLogOffset = getFileSize(LOCAL_GATEWAY_ERR_LOG_PATH);
  const expectedReply = `xlb-smoke-${Date.now().toString(36)}`;
  const prompt = `Reply with exactly this string and nothing else: ${expectedReply}`;
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleEvents = [];

  page.on("console", (msg) => {
    consoleEvents.push({ type: "console", text: msg.text() });
  });
  page.on("pageerror", (error) => {
    consoleEvents.push({ type: "pageerror", text: String(error) });
  });

  try {
    await page.goto(dashboardUrl, {
      waitUntil: "networkidle",
      timeout: PAGE_TIMEOUT_MS,
    });

    const textarea = page.locator('textarea[placeholder="Message Assistant (Enter to send)"]');
    await textarea.waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });

    const assistantMessages = page.locator(".chat-thread .chat-group.assistant .chat-text");
    const userMessages = page.locator(".chat-thread .chat-group.user .chat-text");
    const assistantCountBefore = await assistantMessages.count();
    const userCountBefore = await userMessages.count();

    await textarea.fill(prompt);
    await textarea.press("Enter");

    await page.waitForFunction(
      ({ expected, userBefore, assistantBefore }) => {
        const userTexts = Array.from(
          document.querySelectorAll(".chat-thread .chat-group.user .chat-text"),
        ).map((node) => (node.textContent || "").trim());
        const assistantTexts = Array.from(
          document.querySelectorAll(".chat-thread .chat-group.assistant .chat-text"),
        ).map((node) => (node.textContent || "").trim());
        const userExpanded = userTexts.length > userBefore;
        const assistantExpanded = assistantTexts.length > assistantBefore;
        const lastAssistant = assistantTexts[assistantTexts.length - 1] || "";
        return userExpanded && assistantExpanded && lastAssistant.includes(expected);
      },
      {
        expected: expectedReply,
        userBefore: userCountBefore,
        assistantBefore: assistantCountBefore,
      },
      {
        timeout: RESPONSE_TIMEOUT_MS,
        polling: POLL_INTERVAL_MS,
      },
    );

    const pageText = await page.evaluate(() => document.body.innerText);
    const gatewayLogDelta = readSlice(LOCAL_GATEWAY_LOG_PATH, gatewayLogOffset);
    const gatewayErrLogDelta = readSlice(LOCAL_GATEWAY_ERR_LOG_PATH, gatewayErrLogOffset);
    const disallowedPatterns = [
      /no api key found/i,
      /device token mismatch/i,
      /unauthorized/i,
      /authentication error/i,
      /key is blocked/i,
      /failed before reply/i,
    ];
    const disallowedMatches = [
      ...disallowedPatterns.filter((pattern) => pattern.test(pageText)).map((pattern) => `page:${pattern}`),
      ...disallowedPatterns
        .filter((pattern) => pattern.test(gatewayLogDelta))
        .map((pattern) => `gateway.log:${pattern}`),
      ...disallowedPatterns
        .filter((pattern) => pattern.test(gatewayErrLogDelta))
        .map((pattern) => `gateway.err.log:${pattern}`),
    ];

    if (disallowedMatches.length > 0) {
      fail("Local chat smoke test saw auth or runtime errors.", {
        disallowedMatches,
        gatewayLogDelta,
        gatewayErrLogDelta,
        consoleEvents,
      });
    }

    if (!/webchat connected/i.test(gatewayLogDelta)) {
      fail("Local chat smoke test did not observe a fresh webchat connection.", {
        gatewayLogDelta,
      });
    }

    const newUserMessageIndex = Math.min(userCountBefore, Math.max((await userMessages.count()) - 1, 0));
    const newAssistantMessageIndex = Math.min(
      assistantCountBefore,
      Math.max((await assistantMessages.count()) - 1, 0),
    );
    const lastAssistantText = await assistantMessages.nth(newAssistantMessageIndex).innerText();
    const lastUserText = await userMessages.nth(newUserMessageIndex).innerText();

    const result = {
      ok: true,
      dashboardUrl,
      gatewayPort,
      browserControlPort: gatewayPort + 2,
      prompt,
      expectedReply,
      lastUserText,
      lastAssistantText,
      consoleEvents,
    };
    return result;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  runLocalChatSmokeTest,
};

if (require.main === module) {
  runLocalChatSmokeTest()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      const details =
        error && typeof error === "object" && error.details && typeof error.details === "object"
          ? error.details
          : {};
      process.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...details,
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
    });
}
