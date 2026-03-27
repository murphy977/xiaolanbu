const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require("electron");
const { createPrivateKey, createPublicKey, randomBytes, sign } = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { Client: SshClient } = require("ssh2");
const { WebSocket } = require("ws");

const IS_WINDOWS = process.platform === "win32";
const WINDOWS_LOCAL_APP_DATA =
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const LOCAL_APP_SUPPORT_DIR = IS_WINDOWS
  ? path.join(WINDOWS_LOCAL_APP_DATA, "Xiaolanbu")
  : path.join(os.homedir(), "Library", "Application Support", "Xiaolanbu");
const LOCAL_LOG_DIR = IS_WINDOWS
  ? path.join(LOCAL_APP_SUPPORT_DIR, "logs")
  : path.join(os.homedir(), "Library", "Logs", "Xiaolanbu");
const LOCAL_BOOTSTRAP_LOG = path.join(LOCAL_LOG_DIR, "local-bootstrap.log");
const LOCAL_GATEWAY_CHAT_LOG = path.join(LOCAL_LOG_DIR, "gateway-chat.log");
const LEGACY_LOCAL_OPENCLAW_STATE_DIR = path.join(LOCAL_APP_SUPPORT_DIR, "openclaw-state");
const LEGACY_LOCAL_PROFILE_STATE_DIR = path.join(os.homedir(), ".openclaw-xiaolanbu-local");
const LOCAL_OPENCLAW_STATE_DIR = path.join(os.homedir(), ".openclaw");
const LOCAL_OPENCLAW_CONFIG_PATH = path.join(LOCAL_OPENCLAW_STATE_DIR, "openclaw.json");
const LOCAL_OPENCLAW_WORKSPACE_DIR = path.join(LOCAL_OPENCLAW_STATE_DIR, "workspace");
const LOCAL_OPENCLAW_AGENT_DIR = path.join(
  LOCAL_OPENCLAW_STATE_DIR,
  "agents",
  "main",
  "agent",
);
const LOCAL_OPENCLAW_SESSION_STORE_PATH = path.join(
  LOCAL_OPENCLAW_STATE_DIR,
  "agents",
  "main",
  "sessions",
  "sessions.json",
);
const LOCAL_OPENCLAW_IDENTITY_DIR = path.join(LOCAL_OPENCLAW_STATE_DIR, "identity");
const LOCAL_OPENCLAW_DEVICE_IDENTITY_PATH = path.join(LOCAL_OPENCLAW_IDENTITY_DIR, "device.json");
const LOCAL_OPENCLAW_AUTH_STORE_PATH = path.join(
  LOCAL_OPENCLAW_AGENT_DIR,
  "auth-profiles.json",
);
const LOCAL_DEFAULT_DASHBOARD_PORT = 18789;
const LOCAL_DEFAULT_BROWSER_CONTROL_PORT = 18791;
const CLOUD_TUNNEL_LOCAL_DASHBOARD_PORT = 28789;
const CLOUD_TUNNEL_LOCAL_BROWSER_CONTROL_PORT = 28791;
const LOCAL_MANAGED_RUNTIME_ROOT = path.join(LOCAL_APP_SUPPORT_DIR, "runtime", "openclaw");
const LOCAL_MANAGED_NODE_ROOT = path.join(LOCAL_MANAGED_RUNTIME_ROOT, "node");
const LOCAL_MANAGED_NODE_CURRENT = path.join(LOCAL_MANAGED_NODE_ROOT, "current");
const LOCAL_MANAGED_NPM_PREFIX = path.join(LOCAL_MANAGED_RUNTIME_ROOT, "npm-global");
const LOCAL_MANAGED_NPM_BIN_DIR = IS_WINDOWS
  ? LOCAL_MANAGED_NPM_PREFIX
  : path.join(LOCAL_MANAGED_NPM_PREFIX, "bin");
const LOCAL_MANAGED_WRAPPER_BIN_DIR = path.join(LOCAL_MANAGED_RUNTIME_ROOT, "bin");
const LOCAL_MANAGED_CLAW_BIN = path.join(
  LOCAL_MANAGED_WRAPPER_BIN_DIR,
  IS_WINDOWS ? "openclaw.cmd" : "openclaw",
);
const LOCAL_MANAGED_NODE_BIN = IS_WINDOWS
  ? path.join(LOCAL_MANAGED_NODE_CURRENT, "node.exe")
  : path.join(LOCAL_MANAGED_NODE_CURRENT, "bin", "node");
const LOCAL_MANAGED_NPM_BIN = IS_WINDOWS
  ? path.join(LOCAL_MANAGED_NODE_CURRENT, "npm.cmd")
  : path.join(LOCAL_MANAGED_NODE_CURRENT, "bin", "npm");
const LOCAL_MANAGED_NODE_VERSION = "22.22.1";
const LOCAL_GATEWAY_TUNNEL_KEY_DIR = path.join(LOCAL_APP_SUPPORT_DIR, "keys");
const LOCAL_GATEWAY_TUNNEL_KEY_PATH = path.join(
  LOCAL_GATEWAY_TUNNEL_KEY_DIR,
  "xlb-gateway-tunnel",
);
const LOCAL_GATEWAY_TUNNEL_STATE_PATH = path.join(
  LOCAL_APP_SUPPORT_DIR,
  "local-gateway-tunnel-state.json",
);
const LOCAL_GATEWAY_TUNNEL_CONFIG_PATH = path.join(
  LOCAL_APP_SUPPORT_DIR,
  "local-gateway-tunnel-config.json",
);
const LOCAL_GATEWAY_TUNNEL_HELPER_PATH = path.join(__dirname, "gateway-tunnel-helper.js");
const LEGACY_LOCAL_GATEWAY_TUNNEL_KEY_PATH = path.join(
  os.homedir(),
  ".xiaolanbu",
  "keys",
  "xlb-gateway-tunnel",
);
const LOCAL_GATEWAY_TUNNEL_PORT = 43030;
const LOCAL_GATEWAY_TUNNEL_REMOTE_PORT = 3030;
const LOCAL_BINDING_STATE_PATH = path.join(LOCAL_APP_SUPPORT_DIR, "local-openclaw-binding.json");
const LOCAL_DESKTOP_DEVICE_IDENTITY_PATH = path.join(LOCAL_APP_SUPPORT_DIR, "desktop-device.json");
const LOCAL_RESPONSES_MODEL_ALIAS = "openclaw";
const GATEWAY_CHAT_EVENT_CHANNEL = "xiaolanbu:gateway-chat-event";
const RESPONSES_STREAM_IDLE_TIMEOUT_MS = Number(
  process.env.XLB_RESPONSES_STREAM_IDLE_TIMEOUT_MS || 12000,
);
const WINDOWS_OPENCLAW_GATEWAY_TASK_NAME = "OpenClaw Gateway";
const IS_DESKTOP_HELPER_MODE = process.env.XLB_DESKTOP_HELPERS === "1";
const DEVICE_IDENTITY_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MANAGED_CLOUD_TUNNEL_PORTS = Object.freeze([
  {
    localPort: CLOUD_TUNNEL_LOCAL_DASHBOARD_PORT,
    remotePort: LOCAL_DEFAULT_DASHBOARD_PORT,
    label: "dashboard",
  },
  {
    localPort: CLOUD_TUNNEL_LOCAL_BROWSER_CONTROL_PORT,
    remotePort: LOCAL_DEFAULT_BROWSER_CONTROL_PORT,
    label: "browser-control",
  },
]);

function logGatewayChatDebug(message, details = {}) {
  try {
    fs.mkdirSync(LOCAL_LOG_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message} ${JSON.stringify(details)}\n`;
    fs.appendFileSync(LOCAL_GATEWAY_CHAT_LOG, line, "utf8");
  } catch {
    // ignore logging failures
  }
}

function parsePortList(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return [...fallback];
  }

  const ports = value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);

  return ports.length > 0 ? Array.from(new Set(ports)) : [...fallback];
}

function normalizePortCandidates(value, fallback = []) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? value.split(",")
      : Number.isFinite(Number(value)) && Number(value) > 0
        ? [value]
        : [];
  const ports = entries
    .map((entry) => Number(typeof entry === "string" ? entry.trim() : entry))
    .filter((port) => Number.isInteger(port) && port > 0);
  return ports.length > 0 ? Array.from(new Set(ports)) : [...fallback];
}

function buildLocalGatewayTunnelPortCandidates(gatewayTunnel) {
  if (!gatewayTunnel || typeof gatewayTunnel !== "object") {
    return [22, 2222];
  }

  const explicitCandidates = normalizePortCandidates(gatewayTunnel.sshPortCandidates, []);
  if (explicitCandidates.length > 0) {
    return explicitCandidates;
  }

  const legacySshPort = Number(gatewayTunnel.sshPort || gatewayTunnel.port || 0);
  if (
    Number.isInteger(legacySshPort) &&
    legacySshPort > 0 &&
    legacySshPort !== 22 &&
    legacySshPort !== 2222
  ) {
    return [legacySshPort];
  }

  return [22, 2222];
}

function areNumberArraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (Number(left[index]) !== Number(right[index])) {
      return false;
    }
  }

  return true;
}

const DEFAULT_MANAGED_CLOUD_TUNNEL_PORT_CANDIDATES = Object.freeze(
  parsePortList(process.env.XLB_CLOUD_SSH_PORT_CANDIDATES, [22, 2222]),
);
const managedCloudTunnelState = {
  client: null,
  servers: [],
  host: "",
  username: "",
  port: 22,
  connected: false,
  connectPromise: null,
  lastError: "",
};
let localGatewayTunnelEnsurePromise = null;

function getLocalManagedPathEntries() {
  if (IS_WINDOWS) {
    return [
      LOCAL_MANAGED_WRAPPER_BIN_DIR,
      LOCAL_MANAGED_NPM_BIN_DIR,
      LOCAL_MANAGED_NODE_CURRENT,
      path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
      process.env.SystemRoot || "C:\\Windows",
    ];
  }

  return [
    LOCAL_MANAGED_WRAPPER_BIN_DIR,
    LOCAL_MANAGED_NPM_BIN_DIR,
    path.join(LOCAL_MANAGED_NODE_CURRENT, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

function buildLocalRuntimePath() {
  return [...getLocalManagedPathEntries(), process.env.PATH ?? ""]
    .filter(Boolean)
    .join(path.delimiter);
}

function getShellScriptRuntimePathExpression() {
  return [...getLocalManagedPathEntries(), "$PATH"].filter(Boolean).join(":");
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function powershellEscape(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeTunnelCommand(command) {
  if (typeof command !== "string") {
    return "";
  }

  const trimmed = command.trim();
  if (!trimmed.startsWith("ssh ")) {
    return trimmed;
  }

  if (trimmed.includes("StrictHostKeyChecking=")) {
    return trimmed;
  }

  return trimmed.replace(
    /^ssh\s+/,
    "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ",
  );
}

function createTunnelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseManagedTunnelCommand(command) {
  const normalizedCommand = normalizeTunnelCommand(command);
  if (!normalizedCommand) {
    return null;
  }

  const targetMatch = normalizedCommand.match(/\b([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)\b/);
  if (!targetMatch) {
    return null;
  }

  const [, username, host] = targetMatch;
  const portMatch = normalizedCommand.match(/(?:^|\s)-p\s+(\d+)\b/);
  const port = portMatch ? Number(portMatch[1]) : 22;
  const parsedForwards = Array.from(
    normalizedCommand.matchAll(/(?:^|\s)-L\s+(\d+):127\.0\.0\.1:(\d+)\b/g),
    (match) => ({
      localPort: Number(match[1]),
      remotePort: Number(match[2]),
      label: `${match[1]}->${match[2]}`,
    }),
  ).filter(
    (entry) =>
      Number.isInteger(entry.localPort) &&
      entry.localPort > 0 &&
      Number.isInteger(entry.remotePort) &&
      entry.remotePort > 0,
  );
  const forwards = parsedForwards
    .map((entry) => {
      if (entry.remotePort === LOCAL_DEFAULT_DASHBOARD_PORT) {
        return {
          localPort: CLOUD_TUNNEL_LOCAL_DASHBOARD_PORT,
          remotePort: entry.remotePort,
          label: "dashboard",
        };
      }

      if (entry.remotePort === LOCAL_DEFAULT_BROWSER_CONTROL_PORT) {
        return {
          localPort: CLOUD_TUNNEL_LOCAL_BROWSER_CONTROL_PORT,
          remotePort: entry.remotePort,
          label: "browser-control",
        };
      }

      return entry;
    })
    .filter((entry, index, entries) => {
      return entries.findIndex((item) => item.localPort === entry.localPort) === index;
    });

  return {
    normalizedCommand,
    username,
    host,
    port: Number.isInteger(port) && port > 0 ? port : 22,
    explicitPort: Boolean(portMatch),
    forwards: forwards.length > 0 ? forwards : [...MANAGED_CLOUD_TUNNEL_PORTS],
  };
}

function buildManagedTunnelPortCandidates(spec) {
  const requestedPort =
    Number.isInteger(spec?.port) && spec.port > 0 ? spec.port : DEFAULT_MANAGED_CLOUD_TUNNEL_PORT_CANDIDATES[0];
  const configuredFallbacks = [...DEFAULT_MANAGED_CLOUD_TUNNEL_PORT_CANDIDATES];

  if (spec?.explicitPort) {
    return Array.from(new Set([requestedPort, ...configuredFallbacks]));
  }

  return Array.from(new Set([requestedPort, ...configuredFallbacks]));
}

function isManagedTunnelAuthFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /All configured authentication methods failed/i.test(message);
}

function isManagedTunnelRetryablePortError(error) {
  if (!error) {
    return false;
  }

  const code = typeof error?.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (code === "missing-password" || code === "invalid-command" || code === "invalid-host") {
    return false;
  }

  if (code === "remote-port-not-ready" || code === "EADDRINUSE") {
    return false;
  }

  if (isManagedTunnelAuthFailure(error)) {
    return false;
  }

  return (
    /Timed out while waiting for handshake/i.test(message) ||
    /Connection lost before handshake/i.test(message) ||
    /kex_exchange_identification/i.test(message) ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/i.test(message) ||
    /connect timeout|Timed out/i.test(message)
  );
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || typeof server.close !== "function") {
      resolve();
      return;
    }

    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function closeManagedCloudTunnelServers(servers) {
  await Promise.all((Array.isArray(servers) ? servers : []).map((server) => closeServer(server)));
}

async function teardownManagedCloudTunnel(reason = "") {
  const client = managedCloudTunnelState.client;
  const servers = managedCloudTunnelState.servers;

  managedCloudTunnelState.client = null;
  managedCloudTunnelState.servers = [];
  managedCloudTunnelState.host = "";
  managedCloudTunnelState.username = "";
  managedCloudTunnelState.port = 22;
  managedCloudTunnelState.connected = false;
  managedCloudTunnelState.connectPromise = null;
  managedCloudTunnelState.lastError = reason || managedCloudTunnelState.lastError;

  await closeManagedCloudTunnelServers(servers);

  if (client) {
    try {
      client.end();
    } catch {
      // ignore close failures
    }
    try {
      client.destroy();
    } catch {
      // ignore destroy failures
    }
  }
}

function verifyManagedCloudTunnelTarget(client, forwardSpec) {
  return new Promise((resolve, reject) => {
    client.forwardOut(
      "127.0.0.1",
      0,
      "127.0.0.1",
      forwardSpec.remotePort,
      (error, stream) => {
        if (error) {
          reject(
            createTunnelError(
              "remote-port-not-ready",
              `remote port ${String(forwardSpec.remotePort)} is not ready`,
            ),
          );
          return;
        }

        let settled = false;
        const finish = (callback) => {
          if (settled) {
            return;
          }
          settled = true;
          try {
            stream.end();
          } catch {
            // ignore close failures
          }
          try {
            stream.destroy();
          } catch {
            // ignore destroy failures
          }
          callback();
        };

        stream.once("error", (streamError) => {
          finish(() => reject(streamError));
        });

        // `forwardOut()` succeeding is enough to prove the remote port is reachable.
        // Long-lived services like OpenClaw gateway may keep the stream open and never
        // close on their own, so waiting for `close` here can hang the whole tunnel startup.
        finish(resolve);
      },
    );
  });
}

async function createManagedCloudTunnelServer(client, forwardSpec) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      client.forwardOut(
        socket.remoteAddress || "127.0.0.1",
        socket.remotePort || 0,
        "127.0.0.1",
        forwardSpec.remotePort,
        (error, stream) => {
          if (error) {
            socket.destroy(error);
            return;
          }

          socket.pipe(stream).pipe(socket);
          stream.once("error", () => {
            socket.destroy();
          });
          socket.once("error", () => {
            try {
              stream.end();
            } catch {
              // ignore close failures
            }
          });
        },
      );
    });

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(forwardSpec.localPort, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

function formatManagedTunnelError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const attemptedPorts = Array.isArray(error?.attemptedPorts)
    ? error.attemptedPorts.filter((port) => Number.isInteger(port) && port > 0)
    : [];
  const attemptedPortsSuffix =
    attemptedPorts.length > 1 ? ` 已自动尝试 SSH 端口 ${attemptedPorts.join(" / ")}。` : "";

  if (code === "missing-password") {
    return "缺少这台云端实例的登录密码。请先在设置页补录一次连接密码。";
  }

  if (code === "invalid-command" || code === "invalid-host") {
    return "当前实例缺少可用的云端连接信息，请刷新后重试。";
  }

  if (code === "remote-port-not-ready") {
    return "云端聊天网关还没有完全启动，请稍后再试。";
  }

  if (code === "EADDRINUSE" || /address already in use/i.test(message)) {
    return "本机 127.0.0.1:28789 已被占用。请先关闭旧的云端连接后再试。";
  }

  if (/All configured authentication methods failed/i.test(message)) {
    return "云端连接失败：这台实例的登录密码不正确，或还没有录入到当前设备。";
  }

  if (/Timed out while waiting for handshake/i.test(message)) {
    return `已连上云端实例，但 SSH 服务没有正常响应握手。请检查服务器上的 sshd 是否真的在提供 SSH 服务，或是否被代理/防火墙挂住。${attemptedPortsSuffix}`.trim();
  }

  if (/Connection lost before handshake/i.test(message) || /kex_exchange_identification/i.test(message)) {
    return `已连上云端实例，但 SSH 在握手开始前就被远端关闭了。请检查服务器上的 sshd 是否正常运行、目标端口是否真的是 SSH、以及是否有安全策略/代理提前断开连接。${attemptedPortsSuffix}`.trim();
  }

  if (/connect timeout|Timed out/i.test(message)) {
    return `连接云端实例超时，请检查公网网络、安全组或实例状态后再试。${attemptedPortsSuffix}`.trim();
  }

  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(message)) {
    return `无法连到云端实例，请确认公网 IP、端口和实例状态正常。${attemptedPortsSuffix}`.trim();
  }

  return `连接云端实例失败，请稍后再试。${attemptedPortsSuffix}`.trim();
}

async function startManagedCloudTunnel(command, password) {
  const spec = parseManagedTunnelCommand(command);
  if (!spec) {
    throw createTunnelError("invalid-command", "invalid tunnel command");
  }

  if (!spec.host) {
    throw createTunnelError("invalid-host", "missing tunnel host");
  }

  const normalizedPassword = typeof password === "string" ? password.trim() : "";
  if (!normalizedPassword) {
    throw createTunnelError("missing-password", "missing cloud connection password");
  }

  const activeTunnels = listActiveTunnelProcesses();
  const sameHostExternalTunnel = activeTunnels.find((item) => item.host === spec.host);
  const alreadyRunning =
    managedCloudTunnelState.connected && managedCloudTunnelState.host === spec.host;

  if (alreadyRunning) {
    return {
      ok: true,
      automated: true,
      alreadyRunning: true,
      replacedExisting: false,
      host: spec.host,
    };
  }

  if (managedCloudTunnelState.connectPromise) {
    await managedCloudTunnelState.connectPromise.catch(() => {
      // Retry below with a fresh tunnel startup.
    });
    if (managedCloudTunnelState.connected && managedCloudTunnelState.host === spec.host) {
      return {
        ok: true,
        automated: true,
        alreadyRunning: true,
        replacedExisting: false,
        host: spec.host,
      };
    }
  }

  const replacedExisting =
    managedCloudTunnelState.connected ||
    Boolean(managedCloudTunnelState.host) ||
    activeTunnels.length > 0;

  if (activeTunnels.length > 0) {
    killTunnelProcesses(activeTunnels);
  }

  if (managedCloudTunnelState.connected || managedCloudTunnelState.host) {
    await teardownManagedCloudTunnel();
  }

  const portCandidates = buildManagedTunnelPortCandidates(spec);
  const startPromise = (async () => {
    const attemptedPorts = [];
    let lastError = null;

    for (const port of portCandidates) {
      attemptedPorts.push(port);

      try {
        return await new Promise((resolve, reject) => {
          const client = new SshClient();
          let settled = false;
          let ready = false;
          let servers = [];

          const fail = async (error) => {
            if (settled) {
              return;
            }
            settled = true;
            await closeManagedCloudTunnelServers(servers);
            try {
              client.end();
            } catch {
              // ignore close failures
            }
            try {
              client.destroy();
            } catch {
              // ignore destroy failures
            }
            reject(error instanceof Error ? error : new Error(String(error)));
          };

          client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
            if (!normalizedPassword) {
              finish([]);
              return;
            }
            finish(Array.from({ length: prompts.length || 1 }, () => normalizedPassword));
          });

          client.on("ready", async () => {
            try {
              for (const forward of spec.forwards) {
                await verifyManagedCloudTunnelTarget(client, forward);
              }

              servers = [];
              for (const forward of spec.forwards) {
                const server = await createManagedCloudTunnelServer(client, forward);
                servers.push(server);
              }

              ready = true;
              managedCloudTunnelState.client = client;
              managedCloudTunnelState.servers = servers;
              managedCloudTunnelState.host = spec.host;
              managedCloudTunnelState.username = spec.username;
              managedCloudTunnelState.port = port;
              managedCloudTunnelState.connected = true;
              managedCloudTunnelState.lastError = "";
              settled = true;

              resolve({
                ok: true,
                automated: true,
                alreadyRunning: false,
                replacedExisting,
                host: spec.host,
                port,
                attemptedPorts: [...attemptedPorts],
                usedFallbackPort: attemptedPorts.length > 1,
                reusedExternalTunnel: Boolean(sameHostExternalTunnel),
              });
            } catch (error) {
              await fail(error);
            }
          });

          client.on("error", async (error) => {
            if (!ready) {
              await fail(error);
              return;
            }

            managedCloudTunnelState.lastError = error instanceof Error ? error.message : String(error ?? "");
            await teardownManagedCloudTunnel(managedCloudTunnelState.lastError);
          });

          client.on("close", async () => {
            if (!ready) {
              return;
            }
            await teardownManagedCloudTunnel("cloud tunnel closed");
          });

          client.connect({
            host: spec.host,
            port,
            username: spec.username,
            password: normalizedPassword,
            readyTimeout: 12000,
            keepaliveInterval: 10000,
            keepaliveCountMax: 3,
            tryKeyboard: true,
          });
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!isManagedTunnelRetryablePortError(lastError) || port === portCandidates[portCandidates.length - 1]) {
          break;
        }
      }
    }

    const finalError =
      lastError instanceof Error ? lastError : new Error("managed cloud tunnel failed");
    finalError.attemptedPorts = [...attemptedPorts];
    throw finalError;
  })();

  managedCloudTunnelState.host = spec.host;
  managedCloudTunnelState.username = spec.username;
  managedCloudTunnelState.port = portCandidates[0] || spec.port;
  managedCloudTunnelState.connectPromise = startPromise;

  try {
    return await startPromise;
  } finally {
    managedCloudTunnelState.connectPromise = null;
  }
}

function buildGatewayConnectionFromDashboardUrl(dashboardUrl) {
  if (typeof dashboardUrl !== "string" || !dashboardUrl.trim()) {
    throw new Error("missing dashboardUrl");
  }

  let parsed;
  try {
    parsed = new URL(dashboardUrl);
  } catch {
    throw new Error("invalid dashboardUrl");
  }

  const token = parsed.hash.startsWith("#token=") ? parsed.hash.slice("#token=".length).trim() : "";
  if (!token) {
    throw new Error("missing gateway token");
  }

  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const httpProtocol = parsed.protocol === "https:" ? "https:" : "http:";
  return {
    token,
    wsUrl: `${wsProtocol}//${parsed.host}`,
    responsesUrl: `${httpProtocol}//${parsed.host}/v1/responses`,
  };
}

function buildLegacyAssistantMessage(text) {
  const normalizedText = typeof text === "string" ? text : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: normalizedText }],
    timestamp: Date.now(),
  };
}

function buildResponsesInput(message, attachments) {
  const content = [];
  if (typeof message === "string" && message) {
    content.push({
      type: "input_text",
      text: message,
    });
  }

  for (const entry of Array.isArray(attachments) ? attachments : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const base64Data =
      typeof entry.content === "string" && entry.content.trim() ? entry.content.trim() : "";
    const mediaType =
      typeof entry.mimeType === "string" && entry.mimeType.trim()
        ? entry.mimeType.trim()
        : "image/png";
    if (!base64Data) {
      continue;
    }
    content.push({
      type: "input_image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64Data,
      },
    });
  }

  return [
    {
      type: "message",
      role: "user",
      content,
    },
  ];
}

function normalizeResponsesAssistantContentPart(part) {
  if (!part || typeof part !== "object") {
    return [];
  }

  if (part.type === "output_text" && typeof part.text === "string" && part.text) {
    return [{ type: "text", text: part.text }];
  }

  if (part.type === "text" && typeof part.text === "string" && part.text) {
    return [{ type: "text", text: part.text }];
  }

  if (part.type === "refusal" && typeof part.refusal === "string" && part.refusal) {
    return [{ type: "text", text: part.refusal }];
  }

  if (part.type === "image" || part.type === "output_image") {
    if (typeof part.url === "string" && part.url) {
      return [{ type: "image", url: part.url, alt: typeof part.alt === "string" ? part.alt : "Generated image" }];
    }
    if (typeof part.b64_json === "string" && part.b64_json) {
      return [
        {
          type: "image",
          data: part.b64_json,
          mimeType: typeof part.mime_type === "string" && part.mime_type ? part.mime_type : "image/png",
          alt: typeof part.alt === "string" ? part.alt : "Generated image",
        },
      ];
    }
    if (
      part.image_url &&
      typeof part.image_url === "object" &&
      typeof part.image_url.url === "string" &&
      part.image_url.url
    ) {
      return [{ type: "image_url", image_url: { url: part.image_url.url }, alt: part.alt }];
    }
  }

  if (
    part.type === "image_url" &&
    part.image_url &&
    typeof part.image_url === "object" &&
    typeof part.image_url.url === "string" &&
    part.image_url.url
  ) {
    return [{ type: "image_url", image_url: { url: part.image_url.url }, alt: part.alt }];
  }

  return [];
}

function buildAssistantMessageFromOpenResponse(responsePayload) {
  if (!responsePayload || typeof responsePayload !== "object") {
    return null;
  }

  const output = Array.isArray(responsePayload.output) ? responsePayload.output : [];
  const content = [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "message" && item.role === "assistant") {
      const itemContent = Array.isArray(item.content) ? item.content : [];
      for (const part of itemContent) {
        content.push(...normalizeResponsesAssistantContentPart(part));
      }
      continue;
    }

    content.push(...normalizeResponsesAssistantContentPart(item));
  }

  if (content.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
  };
}

function buildAssistantMessageFromOpenResponseItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const content = [];
  if (item.type === "message" && item.role === "assistant") {
    const itemContent = Array.isArray(item.content) ? item.content : [];
    for (const part of itemContent) {
      content.push(...normalizeResponsesAssistantContentPart(part));
    }
  } else {
    content.push(...normalizeResponsesAssistantContentPart(item));
  }

  if (content.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
  };
}

function extractTextFromOpenResponse(responsePayload) {
  const message = buildAssistantMessageFromOpenResponse(responsePayload);
  if (!message || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function extractTextFromOpenResponseItem(item) {
  const message = buildAssistantMessageFromOpenResponseItem(item);
  if (!message || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function normalizeGatewayHistoryRole(message) {
  return typeof message?.role === "string" ? message.role.trim().toLowerCase() : "";
}

function extractTextFromGatewayHistoryMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (part.text && typeof part.text === "object" && typeof part.text.value === "string") {
        return part.text.value;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function hasRenderableGatewayHistoryMessage(message) {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (extractTextFromGatewayHistoryMessage(message)) {
    return true;
  }

  const content = Array.isArray(message.content) ? message.content : [];
  return content.some((part) => {
    if (!part || typeof part !== "object") {
      return false;
    }
    return (
      part.type === "image" ||
      part.type === "image_url" ||
      part.type === "output_image"
    );
  });
}

function findRecoverableAssistantMessageInHistory(messages, { promptText = "", accumulatedText = "" } = {}) {
  const historyMessages = Array.isArray(messages) ? messages : [];
  if (historyMessages.length === 0) {
    return null;
  }

  let matchedUserIndex = -1;
  const normalizedPrompt = typeof promptText === "string" ? promptText.trim() : "";

  if (normalizedPrompt) {
    for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
      const message = historyMessages[index];
      if (normalizeGatewayHistoryRole(message) !== "user") {
        continue;
      }
      const userText = extractTextFromGatewayHistoryMessage(message);
      if (
        userText === normalizedPrompt ||
        (userText && normalizedPrompt && (userText.includes(normalizedPrompt) || normalizedPrompt.includes(userText)))
      ) {
        matchedUserIndex = index;
        break;
      }
    }
  }

  if (matchedUserIndex < 0) {
    for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
      if (normalizeGatewayHistoryRole(historyMessages[index]) === "user") {
        matchedUserIndex = index;
        break;
      }
    }
  }

  if (matchedUserIndex < 0) {
    return null;
  }

  const normalizedAccumulatedText =
    typeof accumulatedText === "string" ? accumulatedText.trim() : "";

  for (let index = historyMessages.length - 1; index > matchedUserIndex; index -= 1) {
    const message = historyMessages[index];
    if (normalizeGatewayHistoryRole(message) !== "assistant") {
      continue;
    }
    if (!hasRenderableGatewayHistoryMessage(message)) {
      continue;
    }

    const assistantText = extractTextFromGatewayHistoryMessage(message);
    if (!normalizedAccumulatedText) {
      return message;
    }
    if (!assistantText) {
      continue;
    }
    if (
      assistantText.length >= normalizedAccumulatedText.length &&
      (assistantText.includes(normalizedAccumulatedText) || normalizedAccumulatedText.includes(assistantText))
    ) {
      return message;
    }
  }

  return null;
}

function parseResponsesSseBlock(block) {
  const normalized = typeof block === "string" ? block.replace(/\r/g, "") : "";
  if (!normalized.trim()) {
    return null;
  }

  const lines = normalized.split("\n");
  let event = "";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice("event: ".length).trim();
      continue;
    }
    if (line.startsWith("data: ")) {
      dataLines.push(line.slice("data: ".length));
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n"),
  };
}

async function* iterateResponsesSseEvents(stream) {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const normalized = buffer.replace(/\r\n/g, "\n");
      let separatorIndex = normalized.indexOf("\n\n");

      while (separatorIndex >= 0) {
        const block = normalized.slice(0, separatorIndex);
        buffer = normalized.slice(separatorIndex + 2);
        const event = parseResponsesSseBlock(block);
        if (event) {
          yield event;
        }
        separatorIndex = buffer.indexOf("\n\n");
      }

      if (done) {
        const event = parseResponsesSseBlock(buffer);
        if (event) {
          yield event;
        }
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore stream cleanup failure
    }
  }
}

function isResponsesEndpointUnavailable(status, message) {
  if (status === 404 || status === 405) {
    return true;
  }

  return /responses/i.test(message || "") && /not found|unsupported|disabled/i.test(message || "");
}

function sendGatewayChatFrame(webContents, payload) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send(GATEWAY_CHAT_EVENT_CHANNEL, payload);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeResponsesStreams = new Map();

function trackActiveResponsesStream(streamInfo) {
  if (!streamInfo || typeof streamInfo !== "object") {
    return;
  }
  if (typeof streamInfo.requestId === "string" && streamInfo.requestId) {
    activeResponsesStreams.set(`request:${streamInfo.requestId}`, streamInfo);
  }
  if (typeof streamInfo.runId === "string" && streamInfo.runId) {
    activeResponsesStreams.set(`run:${streamInfo.runId}`, streamInfo);
  }
}

function untrackActiveResponsesStream(streamInfo) {
  if (!streamInfo || typeof streamInfo !== "object") {
    return;
  }
  if (typeof streamInfo.requestId === "string" && streamInfo.requestId) {
    activeResponsesStreams.delete(`request:${streamInfo.requestId}`);
  }
  if (typeof streamInfo.runId === "string" && streamInfo.runId) {
    activeResponsesStreams.delete(`run:${streamInfo.runId}`);
  }
}

function abortTrackedResponsesStreams({ runId = "", sessionKey = "" } = {}) {
  const normalizedRunId = typeof runId === "string" ? runId.trim() : "";
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const seen = new Set();
  let aborted = false;

  for (const streamInfo of activeResponsesStreams.values()) {
    if (!streamInfo || typeof streamInfo !== "object") {
      continue;
    }
    if (seen.has(streamInfo)) {
      continue;
    }
    seen.add(streamInfo);

    const runMatches =
      normalizedRunId &&
      typeof streamInfo.runId === "string" &&
      streamInfo.runId === normalizedRunId;
    const sessionMatches =
      !normalizedRunId &&
      normalizedSessionKey &&
      typeof streamInfo.sessionKey === "string" &&
      sessionKeysLikelyMatch(normalizedSessionKey, streamInfo.sessionKey);

    if (!runMatches && !sessionMatches) {
      continue;
    }

    try {
      streamInfo.abortController?.abort(new Error("chat aborted"));
      aborted = true;
    } catch {
      // ignore abort failure
    }
  }

  return aborted;
}

function getNativeChatGatewayClientInfo() {
  const deviceFamily =
    process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "Desktop";
  return {
    client: {
      id: "gateway-client",
      displayName: "Xiaolanbu Desktop",
      version: "xiaolanbu-desktop",
      platform: process.platform,
      mode: "backend",
      instanceId: `xiaolanbu-${process.pid}`,
      deviceFamily,
    },
    deviceFamily,
    scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
  };
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function normalizeGatewayDeviceMetadataField(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.replace(/[A-Z]/g, (match) => match.toLowerCase()) : "";
}

function resolveLocalDesktopDeviceLabel() {
  try {
    const hostname = typeof os.hostname === "function" ? os.hostname() : "";
    if (typeof hostname === "string" && hostname.trim()) {
      return hostname.trim();
    }
  } catch {
    // ignore hostname resolution errors
  }

  return `xiaolanbu-${process.platform}`;
}

function loadLocalDesktopDeviceIdentity() {
  const parsed = readJsonFile(LOCAL_DESKTOP_DEVICE_IDENTITY_PATH);
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof parsed.deviceId === "string" &&
    parsed.deviceId.trim()
  ) {
    return {
      deviceId: parsed.deviceId.trim(),
      deviceLabel:
        typeof parsed.deviceLabel === "string" && parsed.deviceLabel.trim()
          ? parsed.deviceLabel.trim()
          : resolveLocalDesktopDeviceLabel(),
      platform:
        typeof parsed.platform === "string" && parsed.platform.trim()
          ? parsed.platform.trim()
          : process.platform,
      createdAt:
        typeof parsed.createdAt === "string" && parsed.createdAt.trim()
          ? parsed.createdAt.trim()
          : "",
    };
  }

  return null;
}

function getOrCreateLocalDesktopDeviceIdentity() {
  const existing = loadLocalDesktopDeviceIdentity();
  if (existing) {
    return existing;
  }

  const gatewayIdentity = loadLocalGatewayDeviceIdentity();
  const identity = {
    deviceId:
      typeof gatewayIdentity?.deviceId === "string" && gatewayIdentity.deviceId.trim()
        ? gatewayIdentity.deviceId.trim()
        : `xlb-local-${randomBytes(12).toString("hex")}`,
    deviceLabel: resolveLocalDesktopDeviceLabel(),
    platform: process.platform,
    createdAt: new Date().toISOString(),
  };
  writeJsonFile(LOCAL_DESKTOP_DEVICE_IDENTITY_PATH, identity);
  return identity;
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const rawPublicKey = Buffer.from(spki).subarray(DEVICE_IDENTITY_PUBLIC_KEY_PREFIX.length);
  return base64UrlEncode(rawPublicKey);
}

function signGatewayDevicePayload(privateKeyPem, payload) {
  return base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)));
}

function buildGatewayDeviceAuthPayloadV3(params) {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token || "",
    params.nonce,
    normalizeGatewayDeviceMetadataField(params.platform),
    normalizeGatewayDeviceMetadataField(params.deviceFamily),
  ].join("|");
}

function loadLocalGatewayDeviceIdentity() {
  try {
    const raw = fs.readFileSync(LOCAL_OPENCLAW_DEVICE_IDENTITY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.publicKeyPem === "string" &&
      typeof parsed.privateKeyPem === "string"
    ) {
      return {
        deviceId: parsed.deviceId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      };
    }
  } catch {
    // ignore missing/invalid local identity and fall back to token-only auth
  }
  return null;
}

function buildNativeChatGatewayConnectParams({ token, nonce, scopes: requestedScopes, omitDeviceIdentity = false }) {
  const { client, scopes: defaultScopes, deviceFamily } = getNativeChatGatewayClientInfo();
  const scopes =
    Array.isArray(requestedScopes) && requestedScopes.length > 0
      ? requestedScopes
      : defaultScopes;
  const connectParams = {
    minProtocol: 3,
    maxProtocol: 3,
    client,
    role: "operator",
    scopes,
    caps: ["tool-events"],
    auth: {
      token,
    },
  };
  const identity = omitDeviceIdentity ? null : loadLocalGatewayDeviceIdentity();

  if (!identity) {
    return {
      connectParams,
      requiresChallenge: false,
    };
  }

  if (!nonce) {
    throw new Error("missing gateway connect challenge");
  }

  const signedAtMs = Date.now();
  const payload = buildGatewayDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: client.id,
    clientMode: client.mode,
    role: "operator",
    scopes,
    signedAtMs,
    token,
    nonce,
    platform: client.platform,
    deviceFamily,
  });

  connectParams.device = {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signGatewayDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };

  return {
    connectParams,
    requiresChallenge: true,
  };
}

function createGatewayRequestId() {
  return randomBytes(16).toString("hex");
}

function parseGatewayFrame(raw) {
  if (typeof raw !== "string" || !raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

async function createGatewayRpcClient({
  dashboardUrl,
  connectTimeoutMs = 15000,
  scopes,
  omitDeviceIdentity = false,
}) {
  const { token, wsUrl } = buildGatewayConnectionFromDashboardUrl(dashboardUrl);
  const previewConnect = buildNativeChatGatewayConnectParams({
    token,
    nonce: "preview",
    scopes,
    omitDeviceIdentity,
  });
  const requiresChallenge = previewConnect.requiresChallenge;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const eventListeners = new Set();
    let settled = false;
    let connectSent = false;
    let connectTimer = null;

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      clearTimeout(timeoutTimer);
      try {
        ws.close();
      } catch {
        // ignore close failure
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const sendConnect = (nonce = "") => {
      if (connectSent || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      connectSent = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      const connectId = createGatewayRequestId();
      pending.set(connectId, {
        resolve: (payload) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve({
            request(method, params) {
              if (ws.readyState !== WebSocket.OPEN) {
                return Promise.reject(new Error("gateway websocket closed"));
              }

              return new Promise((innerResolve, innerReject) => {
                const requestId = createGatewayRequestId();
                pending.set(requestId, {
                  resolve: innerResolve,
                  reject: innerReject,
                });
                ws.send(
                  JSON.stringify({
                    type: "req",
                    id: requestId,
                    method,
                    params,
                  }),
                );
              });
            },
            onChatEvent(listener) {
              if (typeof listener !== "function") {
                return () => {};
              }

              const wrapped = (frame) => {
                if (frame?.event === "chat") {
                  listener(frame.payload);
                }
              };
              eventListeners.add(wrapped);
              return () => {
                eventListeners.delete(wrapped);
              };
            },
            onEvent(listener) {
              if (typeof listener !== "function") {
                return () => {};
              }

              eventListeners.add(listener);
              return () => {
                eventListeners.delete(listener);
              };
            },
            close() {
              cleanup();
              for (const [, entry] of pending) {
                entry.reject(new Error("gateway client closed"));
              }
              pending.clear();
              try {
                ws.close();
              } catch {
                // ignore close failure
              }
            },
            hello: payload,
          });
        },
        reject: fail,
      });

      ws.send(
        JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: buildNativeChatGatewayConnectParams({
            token,
            nonce,
            scopes,
            omitDeviceIdentity,
          }).connectParams,
        }),
      );
    };

    const timeoutTimer = setTimeout(() => {
      fail(new Error("gateway connect timeout"));
    }, connectTimeoutMs);

    ws.on("open", () => {
      if (requiresChallenge) {
        connectTimer = setTimeout(() => {
          fail(new Error("gateway connect challenge timeout"));
        }, 3000);
        return;
      }

      connectTimer = setTimeout(() => {
        sendConnect();
      }, 150);
    });

    ws.on("message", (data) => {
      const frame = parseGatewayFrame(String(data ?? ""));
      if (!frame || typeof frame !== "object") {
        return;
      }

      if (frame.type === "event") {
        if (frame.event === "connect.challenge") {
          const nonce =
            frame.payload && typeof frame.payload === "object" && typeof frame.payload.nonce === "string"
              ? frame.payload.nonce
              : "";
          sendConnect(nonce);
          return;
        }

        for (const listener of eventListeners) {
          try {
            listener({
              event: frame.event,
              payload: frame.payload,
              seq: typeof frame.seq === "number" ? frame.seq : null,
              stateVersion:
                frame.stateVersion && typeof frame.stateVersion === "object" ? frame.stateVersion : null,
            });
          } catch {
            // ignore listener failures
          }
        }
        return;
      }

      if (frame.type !== "res" || typeof frame.id !== "string") {
        return;
      }

      const entry = pending.get(frame.id);
      if (!entry) {
        return;
      }

      pending.delete(frame.id);
      if (frame.ok) {
        clearTimeout(timeoutTimer);
        entry.resolve(frame.payload);
        return;
      }

      const errorMessage =
        frame.error && typeof frame.error === "object" && typeof frame.error.message === "string"
          ? frame.error.message
          : "gateway request failed";
      entry.reject(new Error(errorMessage));
    });

    ws.on("error", (error) => {
      fail(error instanceof Error ? error : new Error("gateway websocket error"));
    });

    ws.on("close", (code, reasonBuffer) => {
      const reason =
        typeof reasonBuffer === "string" ? reasonBuffer : Buffer.from(reasonBuffer ?? "").toString("utf8");
      if (!settled) {
        fail(new Error(`gateway closed (${code}): ${reason || "no reason"}`));
      }
    });
  });
}

async function fetchGatewayChatHistory(params) {
  const handle = await acquireCachedLocalGatewayRpcClient({
    dashboardUrl: params?.dashboardUrl,
  });
  const { client } = handle;

  try {
    const payload = await client.request("chat.history", {
      sessionKey:
        typeof params?.sessionKey === "string" && params.sessionKey.trim()
          ? params.sessionKey.trim()
          : "main",
      limit:
        Number.isFinite(params?.limit) && params.limit > 0
          ? Math.min(Math.trunc(params.limit), 500)
          : 200,
    });

    return {
      ok: true,
      thinkingLevel:
        payload && typeof payload === "object" && typeof payload.thinkingLevel === "string"
          ? payload.thinkingLevel
          : null,
      messages:
        payload && typeof payload === "object" && Array.isArray(payload.messages) ? payload.messages : [],
    };
  } catch (error) {
    handle.invalidate();
    throw error;
  } finally {
    handle.release();
  }
}

async function fetchGatewaySessions(params) {
  const handle = await acquireCachedLocalGatewayRpcClient({
    dashboardUrl: params?.dashboardUrl,
  });
  const { client } = handle;

  try {
    const payload = await client.request("sessions.list", {
      includeGlobal: params?.includeGlobal !== false,
      includeUnknown: params?.includeUnknown === true,
      ...(Number.isFinite(params?.limit) && params.limit > 0
        ? { limit: Math.min(Math.trunc(params.limit), 500) }
        : {}),
      ...(Number.isFinite(params?.activeMinutes) && params.activeMinutes > 0
        ? { activeMinutes: Math.min(Math.trunc(params.activeMinutes), 24 * 60) }
        : {}),
    });

    return {
      ok: true,
      count:
        payload && typeof payload === "object" && Number.isFinite(payload.count) ? payload.count : 0,
      defaults:
        payload && typeof payload === "object" && payload.defaults && typeof payload.defaults === "object"
          ? payload.defaults
          : {},
      sessions:
        payload && typeof payload === "object" && Array.isArray(payload.sessions) ? payload.sessions : [],
    };
  } catch (error) {
    handle.invalidate();
    throw error;
  } finally {
    handle.release();
  }
}

async function abortGatewayChat(params) {
  const sessionKey =
    typeof params?.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "main";
  const runId =
    typeof params?.runId === "string" && params.runId.trim() ? params.runId.trim() : "";

  if (abortTrackedResponsesStreams({ sessionKey, runId })) {
    return { ok: true };
  }

  const handle = await acquireCachedLocalGatewayRpcClient({
    dashboardUrl: params?.dashboardUrl,
  });
  const { client } = handle;

  try {
    await client.request(
      "chat.abort",
      runId ? { sessionKey, runId } : { sessionKey },
    );

    return { ok: true };
  } catch (error) {
    handle.invalidate();
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to abort chat",
    };
  } finally {
    handle.release();
  }
}

async function sendGatewayChatMessageViaRpc(webContents, params) {
  const sessionKey =
    typeof params?.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "main";
  const message =
    typeof params?.message === "string" ? params.message.trim() : "";
  const attachments =
    Array.isArray(params?.attachments)
      ? params.attachments
          .map((entry) => {
            const dataUrl = typeof entry?.dataUrl === "string" ? entry.dataUrl.trim() : "";
            const mimeType = typeof entry?.mimeType === "string" ? entry.mimeType.trim() : "";
            if (!dataUrl || !mimeType) {
              return null;
            }
            const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
            if (!match || !match[2]) {
              return null;
            }
            return {
              type: "image",
              mimeType: mimeType || match[1] || "image/png",
              fileName:
                typeof entry?.name === "string" && entry.name.trim()
                  ? entry.name.trim()
                  : typeof entry?.fileName === "string" && entry.fileName.trim()
                    ? entry.fileName.trim()
                    : undefined,
              content: match[2],
            };
          })
          .filter(Boolean)
      : [];

  if (!message && attachments.length === 0) {
    return { ok: false, error: "message or attachments required" };
  }

  const timeoutMs =
    Number.isFinite(params?.timeoutMs) && params.timeoutMs > 0
      ? Math.min(Math.trunc(params.timeoutMs), 300000)
      : 180000;
  const requestId =
    typeof params?.requestId === "string" && params.requestId.trim()
      ? params.requestId.trim()
      : createGatewayRequestId();
  const handle = await acquireCachedLocalGatewayRpcClient({
    dashboardUrl: params?.dashboardUrl,
  });
  const { client } = handle;
  let unsubscribeGatewayEvents = () => {};

  try {
    const runId =
      typeof params?.runId === "string" && params.runId.trim()
        ? params.runId.trim()
        : createGatewayRequestId();
    logGatewayChatDebug("rpc-chat-start", {
      requestId,
      runId,
      sessionKey,
      hasMessage: Boolean(message),
      attachmentCount: attachments.length,
    });
    unsubscribeGatewayEvents = client.onEvent((frame) => {
      if (!frame || (frame.event !== "chat" && frame.event !== "agent")) {
        return;
      }

      const eventPayload =
        frame.payload && typeof frame.payload === "object" ? frame.payload : null;
      if (!eventPayload) {
        return;
      }

      if (
        typeof eventPayload.sessionKey === "string" &&
        eventPayload.sessionKey &&
        !sessionKeysLikelyMatch(sessionKey, eventPayload.sessionKey)
      ) {
        return;
      }

      if (
        frame.event === "chat" &&
        typeof eventPayload.runId === "string" &&
        eventPayload.runId &&
        eventPayload.runId !== runId
      ) {
        return;
      }

      if (!webContents || webContents.isDestroyed()) {
        return;
      }

      if (frame.event === "chat") {
        logGatewayChatDebug("rpc-chat-event", {
          requestId,
          runId,
          sessionKey,
          state: typeof eventPayload.state === "string" ? eventPayload.state : "",
        });
      }

      webContents.send(GATEWAY_CHAT_EVENT_CHANNEL, {
        requestId,
        event: frame.event,
        payload: eventPayload,
        seq: frame.seq,
        stateVersion: frame.stateVersion,
        sessionKey,
        runId,
        receivedAt: Date.now(),
      });
    });
    const finalResultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("chat response timeout"));
      }, timeoutMs);

      const unsubscribe = client.onChatEvent((payload) => {
        const eventPayload = payload && typeof payload === "object" ? payload : null;
        if (!eventPayload) {
          return;
        }

        if (
          typeof eventPayload.sessionKey === "string" &&
          eventPayload.sessionKey &&
          !sessionKeysLikelyMatch(sessionKey, eventPayload.sessionKey)
        ) {
          return;
        }

        if (
          typeof eventPayload.runId === "string" &&
          eventPayload.runId &&
          eventPayload.runId !== runId
        ) {
          return;
        }

        if (eventPayload.state === "delta") {
          return;
        }

        clearTimeout(timer);
        unsubscribe();
        if (eventPayload.state === "final") {
          logGatewayChatDebug("rpc-chat-terminal", {
            requestId,
            runId,
            sessionKey,
            state: "final",
          });
          resolve({
            ok: true,
            requestId,
            runId,
            message: eventPayload.message ?? null,
          });
          return;
        }

        if (eventPayload.state === "aborted") {
          logGatewayChatDebug("rpc-chat-terminal", {
            requestId,
            runId,
            sessionKey,
            state: "aborted",
          });
          resolve({
            ok: false,
            aborted: true,
            requestId,
            runId,
            error: "chat aborted",
            message: eventPayload.message ?? null,
          });
          return;
        }

        logGatewayChatDebug("rpc-chat-terminal", {
          requestId,
          runId,
          sessionKey,
          state:
            typeof eventPayload.state === "string" && eventPayload.state
              ? eventPayload.state
              : "error",
        });
        resolve({
          ok: false,
          requestId,
          runId,
          error:
            typeof eventPayload.errorMessage === "string" && eventPayload.errorMessage.trim()
              ? eventPayload.errorMessage.trim()
              : "chat error",
        });
      });
    });

    await client.request("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: runId,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    return await finalResultPromise;
  } catch (error) {
    handle.invalidate();
    logGatewayChatDebug("rpc-chat-error", {
      requestId,
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    try {
      unsubscribeGatewayEvents?.();
    } catch {
      // ignore cleanup failure
    }
    handle.release();
  }
}

async function sendGatewayChatMessageViaResponses(webContents, params) {
  const sessionKey =
    typeof params?.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "main";
  const message =
    typeof params?.message === "string" ? params.message.trim() : "";
  const attachments =
    Array.isArray(params?.attachments)
      ? params.attachments
          .map((entry) => {
            const dataUrl = typeof entry?.dataUrl === "string" ? entry.dataUrl.trim() : "";
            const mimeType = typeof entry?.mimeType === "string" ? entry.mimeType.trim() : "";
            if (!dataUrl || !mimeType) {
              return null;
            }
            const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
            if (!match || !match[2]) {
              return null;
            }
            return {
              type: "image",
              mimeType: mimeType || match[1] || "image/png",
              fileName:
                typeof entry?.name === "string" && entry.name.trim()
                  ? entry.name.trim()
                  : typeof entry?.fileName === "string" && entry.fileName.trim()
                    ? entry.fileName.trim()
                    : undefined,
              content: match[2],
            };
          })
          .filter(Boolean)
      : [];

  if (!message && attachments.length === 0) {
    return { ok: false, error: "message or attachments required" };
  }

  const timeoutMs =
    Number.isFinite(params?.timeoutMs) && params.timeoutMs > 0
      ? Math.min(Math.trunc(params.timeoutMs), 300000)
      : 180000;
  const requestId =
    typeof params?.requestId === "string" && params.requestId.trim()
      ? params.requestId.trim()
      : createGatewayRequestId();
  const { token, responsesUrl } = buildGatewayConnectionFromDashboardUrl(params?.dashboardUrl);
  const activeRunId =
    typeof params?.runId === "string" && params.runId.trim()
      ? params.runId.trim()
      : createGatewayRequestId();

  const abortController = new AbortController();
  const trackedStream = {
    requestId,
    runId: activeRunId,
    sessionKey,
    abortController,
  };
  trackActiveResponsesStream(trackedStream);

  void (async () => {
    logGatewayChatDebug("responses-stream-start", {
      requestId,
      runId: activeRunId,
      sessionKey,
      hasMessage: Boolean(message),
      attachmentCount: attachments.length,
    });
    const timeout = setTimeout(() => {
      abortController.abort(new Error("chat response timeout"));
    }, timeoutMs);
    let streamIdleTimer = null;
    let idleTimeoutTriggered = false;

    let accumulatedText = "";
    let finalMessage = null;
    let responseStatus = "completed";

    const clearStreamIdleTimer = () => {
      if (streamIdleTimer) {
        clearTimeout(streamIdleTimer);
        streamIdleTimer = null;
      }
    };

    const refreshStreamIdleTimer = () => {
      clearStreamIdleTimer();
      streamIdleTimer = setTimeout(() => {
        idleTimeoutTriggered = true;
        logGatewayChatDebug("responses-stream-idle-timeout", {
          requestId,
          runId: activeRunId,
          sessionKey,
          accumulatedLength: accumulatedText.length,
        });
        abortController.abort(new Error("chat response idle timeout"));
      }, RESPONSES_STREAM_IDLE_TIMEOUT_MS);
    };

    const recoverFinalMessageFromHistory = async () => {
      try {
        const historyResult = await fetchGatewayChatHistory({
          dashboardUrl: params?.dashboardUrl,
          sessionKey,
          limit: 200,
        });
        if (!historyResult?.ok) {
          return null;
        }
        return (
          findRecoverableAssistantMessageInHistory(historyResult.messages, {
            promptText: message,
            accumulatedText,
          }) ||
          null
        );
      } catch {
        return null;
      }
    };

    try {
      const response = await fetch(responsesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-openclaw-agent-id": "main",
          "x-openclaw-session-key": sessionKey,
        },
        body: JSON.stringify({
          model: "openclaw",
          stream: true,
          input: buildResponsesInput(message, attachments),
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        clearStreamIdleTimer();
        const errorText = (await response.text().catch(() => "")).trim();
        if (isResponsesEndpointUnavailable(response.status, errorText)) {
          const rpcResult = await sendGatewayChatMessageViaRpc(webContents, params);
          if (!rpcResult?.ok) {
            sendGatewayChatFrame(webContents, {
              requestId,
              event: "chat",
              payload: {
                state: "error",
                errorMessage: rpcResult?.error || "消息发送失败。",
                message: rpcResult?.message ?? null,
              },
              seq: null,
              stateVersion: null,
              sessionKey,
              runId: activeRunId,
              receivedAt: Date.now(),
            });
          }
          return;
        }

        sendGatewayChatFrame(webContents, {
          requestId,
          event: "chat",
          payload: {
            state: "error",
            errorMessage:
              errorText || `responses request failed with status ${String(response.status)}`,
          },
          seq: null,
          stateVersion: null,
          sessionKey,
          runId: activeRunId,
          receivedAt: Date.now(),
        });
        return;
      }

      let sawTerminalEvent = false;
      refreshStreamIdleTimer();

      for await (const event of iterateResponsesSseEvents(response.body)) {
        refreshStreamIdleTimer();
        if (!event) {
          continue;
        }

        if (event.data === "[DONE]") {
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }

        if (
          event.event === "response.output_text.delta" &&
          typeof parsed.delta === "string" &&
          parsed.delta
        ) {
          accumulatedText += parsed.delta;
          logGatewayChatDebug("responses-stream-delta", {
            requestId,
            runId: activeRunId,
            sessionKey,
            accumulatedLength: accumulatedText.length,
          });
          sendGatewayChatFrame(webContents, {
            requestId,
            event: "chat",
            payload: {
              state: "delta",
              message: buildLegacyAssistantMessage(accumulatedText),
            },
            seq: null,
            stateVersion: null,
            sessionKey,
            runId: activeRunId,
            receivedAt: Date.now(),
          });
          continue;
        }

        if (event.event === "response.output_text.done" && typeof parsed.text === "string") {
          accumulatedText = parsed.text;
          continue;
        }

        if (event.event === "response.output_item.done") {
          const finalMessageFromItem = buildAssistantMessageFromOpenResponseItem(parsed.item);
          const finalTextFromItem = extractTextFromOpenResponseItem(parsed.item);
          if (finalTextFromItem) {
            accumulatedText = finalTextFromItem;
          }
          if (finalMessageFromItem) {
            finalMessage = finalMessageFromItem;
          }
          if (
            parsed.item &&
            typeof parsed.item === "object" &&
            parsed.item.type === "message" &&
            parsed.item.role === "assistant" &&
            parsed.item.status === "completed"
          ) {
            responseStatus = "completed";
            sawTerminalEvent = true;
            break;
          }
          continue;
        }

        if (
          event.event === "response.failed" ||
          event.event === "response.cancelled" ||
          event.event === "response.incomplete"
        ) {
          const responsePayload =
            parsed.response && typeof parsed.response === "object" ? parsed.response : null;
          const finalMessageFromResponse = buildAssistantMessageFromOpenResponse(responsePayload);
          const finalText = extractTextFromOpenResponse(responsePayload) || accumulatedText;
          responseStatus =
            responsePayload && typeof responsePayload.status === "string"
              ? responsePayload.status
              : event.event.replace("response.", "");
          finalMessage =
            finalMessageFromResponse ||
            (finalText ? buildLegacyAssistantMessage(finalText) : null);
          sawTerminalEvent = true;
          break;
        }

        if (event.event === "response.completed") {
          const responsePayload =
            parsed.response && typeof parsed.response === "object" ? parsed.response : null;
          const finalMessageFromResponse = buildAssistantMessageFromOpenResponse(responsePayload);
          const finalText = extractTextFromOpenResponse(responsePayload) || accumulatedText;
          responseStatus =
            responsePayload && typeof responsePayload.status === "string"
              ? responsePayload.status
              : "completed";
          finalMessage =
            finalMessageFromResponse ||
            (finalText ? buildLegacyAssistantMessage(finalText) : null);
          sawTerminalEvent = true;
          break;
        }
      }

      clearStreamIdleTimer();

      if (!finalMessage && accumulatedText) {
        finalMessage = buildLegacyAssistantMessage(accumulatedText);
      }

      if (!sawTerminalEvent && !finalMessage) {
        finalMessage = await recoverFinalMessageFromHistory();
      }

      if (!sawTerminalEvent && !finalMessage) {
        sendGatewayChatFrame(webContents, {
          requestId,
          event: "chat",
          payload: {
            state: "error",
            errorMessage: "responses stream ended without a final message",
          },
          seq: null,
          stateVersion: null,
          sessionKey,
          runId: activeRunId,
          receivedAt: Date.now(),
        });
        return;
      }

      const isTerminalFailure =
        responseStatus === "failed" ||
        responseStatus === "cancelled" ||
        responseStatus === "incomplete";

      logGatewayChatDebug("responses-stream-terminal", {
        requestId,
        runId: activeRunId,
        sessionKey,
        responseStatus,
        sawTerminalEvent,
        recoveredFromHistory: !sawTerminalEvent,
        hasFinalMessage: Boolean(finalMessage),
      });

      sendGatewayChatFrame(webContents, {
        requestId,
        event: "chat",
        payload: isTerminalFailure
          ? {
              state: "error",
              errorMessage: `responses request ${responseStatus}`,
              message: finalMessage,
            }
          : {
              state: "final",
              message: finalMessage,
            },
        seq: null,
        stateVersion: null,
        sessionKey,
        runId: activeRunId,
        receivedAt: Date.now(),
      });
    } catch (error) {
      clearStreamIdleTimer();
      const aborted = abortController.signal.aborted;
      if (aborted && idleTimeoutTriggered) {
        const recoveredMessage =
          (await recoverFinalMessageFromHistory()) ||
          (accumulatedText ? buildLegacyAssistantMessage(accumulatedText) : null);
        if (recoveredMessage) {
          logGatewayChatDebug("responses-stream-idle-recovered", {
            requestId,
            runId: activeRunId,
            sessionKey,
            accumulatedLength: accumulatedText.length,
          });
          sendGatewayChatFrame(webContents, {
            requestId,
            event: "chat",
            payload: {
              state: "final",
              message: recoveredMessage,
            },
            seq: null,
            stateVersion: null,
            sessionKey,
            runId: activeRunId,
            receivedAt: Date.now(),
          });
          return;
        }
      }
      logGatewayChatDebug("responses-stream-error", {
        requestId,
        runId: activeRunId,
        sessionKey,
        aborted,
        idleTimeoutTriggered,
        accumulatedLength: accumulatedText.length,
        error: error instanceof Error ? error.message : String(error),
      });
      sendGatewayChatFrame(webContents, {
        requestId,
        event: "chat",
        payload: aborted
          ? {
              state: "aborted",
              message:
                finalMessage ||
                (accumulatedText ? buildLegacyAssistantMessage(accumulatedText) : null),
            }
          : {
              state: "error",
              errorMessage:
                error instanceof Error ? error.message : "failed to stream chat response",
              message:
                finalMessage ||
                (accumulatedText ? buildLegacyAssistantMessage(accumulatedText) : null),
            },
        seq: null,
        stateVersion: null,
        sessionKey,
        runId: activeRunId,
        receivedAt: Date.now(),
      });
    } finally {
      clearTimeout(timeout);
      clearStreamIdleTimer();
      untrackActiveResponsesStream(trackedStream);
    }
  })();

  return {
    ok: true,
    started: true,
    requestId,
    runId: activeRunId,
  };
}

async function sendGatewayChatMessage(webContents, params) {
  try {
    return await sendGatewayChatMessageViaRpc(webContents, params);
  } catch (rpcError) {
    logGatewayChatDebug("rpc-chat-fallback-to-responses", {
      requestId:
        typeof params?.requestId === "string" && params.requestId.trim() ? params.requestId.trim() : "",
      runId: typeof params?.runId === "string" && params.runId.trim() ? params.runId.trim() : "",
      sessionKey:
        typeof params?.sessionKey === "string" && params.sessionKey.trim()
          ? params.sessionKey.trim()
          : "main",
      error: rpcError instanceof Error ? rpcError.message : String(rpcError),
    });
  }

  const responsesResult = await sendGatewayChatMessageViaResponses(webContents, params);
  if (!responsesResult?.endpointUnavailable && !responsesResult?.retryViaRpc) {
    return responsesResult;
  }

  return sendGatewayChatMessageViaRpc(webContents, params);
}

async function saveMarkdownExport(params) {
  const content = typeof params?.content === "string" ? params.content : "";
  if (!content.trim()) {
    return { ok: false, error: "empty markdown content" };
  }

  const suggestedName =
    typeof params?.suggestedName === "string" && params.suggestedName.trim()
      ? params.suggestedName.trim()
      : `xiaolanbu-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;

  try {
    const result = await dialog.showSaveDialog({
      title: "导出聊天记录",
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
      filters: [{ name: "Markdown", extensions: ["md"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true, error: "export canceled" };
    }

    fs.writeFileSync(result.filePath, content, "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to save markdown export",
    };
  }
}

function launchInTerminal(command) {
  if (process.platform === "darwin") {
    spawn(
      "osascript",
      [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    ).unref();
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", command], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  const terminal = process.env.TERMINAL || "x-terminal-emulator";
  spawn(terminal, ["-e", `bash -lc ${JSON.stringify(command)}`], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function launchDetached(command, args) {
  spawn(command, args, {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const normalized = typeof raw === "string" ? raw.replace(/^\uFEFF/, "") : raw;
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readLocalBindingState() {
  const parsed = readJsonFile(LOCAL_BINDING_STATE_PATH);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function readLocalOpenClawAuthStore() {
  const parsed = readJsonFile(LOCAL_OPENCLAW_AUTH_STORE_PATH);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function readLocalGatewayTunnelState() {
  const parsed = readJsonFile(LOCAL_GATEWAY_TUNNEL_STATE_PATH);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function normalizeLocalGatewayTunnelConfig(source) {
  const candidate = source && typeof source === "object" ? source : null;
  const gatewayTunnel =
    candidate?.gatewayTunnel && typeof candidate.gatewayTunnel === "object"
      ? candidate.gatewayTunnel
      : null;
  if (!gatewayTunnel) {
    return null;
  }

  const originalBaseUrl =
    typeof candidate.originalBaseUrl === "string" && candidate.originalBaseUrl.trim()
      ? candidate.originalBaseUrl.trim()
      : typeof candidate.baseUrl === "string" && candidate.baseUrl.trim()
        ? candidate.baseUrl.trim()
        : "";

  let parsedBaseUrl = null;
  try {
    parsedBaseUrl = originalBaseUrl ? new URL(originalBaseUrl) : null;
  } catch {
    parsedBaseUrl = null;
  }

  const host =
    typeof gatewayTunnel.host === "string" && gatewayTunnel.host.trim()
      ? gatewayTunnel.host.trim()
      : parsedBaseUrl?.hostname || "";
  if (!host) {
    return null;
  }

  const basePath = parsedBaseUrl ? parsedBaseUrl.pathname.replace(/\/$/, "") || "" : "";
  const protocolDefaultPort = parsedBaseUrl?.protocol === "https:" ? 443 : 80;
  const localPort = Number(gatewayTunnel.localPort || LOCAL_GATEWAY_TUNNEL_PORT);
  const remotePort = Number(
    gatewayTunnel.remotePort || parsedBaseUrl?.port || protocolDefaultPort || LOCAL_GATEWAY_TUNNEL_REMOTE_PORT,
  );
  const sshPortCandidates = buildLocalGatewayTunnelPortCandidates(gatewayTunnel);
  const sshPort = Number(gatewayTunnel.sshPort || gatewayTunnel.port || sshPortCandidates[0] || 22);

  return {
    host,
    user:
      typeof gatewayTunnel.user === "string" && gatewayTunnel.user.trim()
        ? gatewayTunnel.user.trim()
        : "root",
    localPort: Number.isFinite(localPort) && localPort > 0 ? localPort : LOCAL_GATEWAY_TUNNEL_PORT,
    remotePort:
      Number.isFinite(remotePort) && remotePort > 0 ? remotePort : LOCAL_GATEWAY_TUNNEL_REMOTE_PORT,
    sshPort: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : sshPortCandidates[0] || 22,
    sshPortCandidates,
    privateKey:
      typeof gatewayTunnel.privateKey === "string" && gatewayTunnel.privateKey.trim()
        ? gatewayTunnel.privateKey.trim()
        : "",
    originalBaseUrl,
    effectiveBaseUrl: `http://127.0.0.1:${String(
      Number.isFinite(localPort) && localPort > 0 ? localPort : LOCAL_GATEWAY_TUNNEL_PORT,
    )}${basePath}`,
  };
}

function buildPersistedLocalGatewayTunnel(config) {
  if (!config) {
    return undefined;
  }

  return {
    host: config.host,
    user: config.user,
    localPort: config.localPort,
    remotePort: config.remotePort,
    sshPort: config.sshPort,
    sshPortCandidates: Array.isArray(config.sshPortCandidates) ? [...config.sshPortCandidates] : undefined,
  };
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureLocalGatewayTunnelPrivateKey(config) {
  if (!config) {
    return { ok: true, keyPath: LOCAL_GATEWAY_TUNNEL_KEY_PATH };
  }

  syncLegacyGatewayTunnelKey();

  if (typeof config.privateKey === "string" && config.privateKey.trim()) {
    ensureDirectory(path.dirname(LOCAL_GATEWAY_TUNNEL_KEY_PATH));
    fs.writeFileSync(
      LOCAL_GATEWAY_TUNNEL_KEY_PATH,
      `${config.privateKey.trim().replace(/\r\n/g, "\n")}\n`,
      "utf8",
    );
    try {
      fs.chmodSync(LOCAL_GATEWAY_TUNNEL_KEY_PATH, 0o600);
    } catch {
      // Ignore chmod failures on platforms without POSIX permissions.
    }
  }

  if (!fs.existsSync(LOCAL_GATEWAY_TUNNEL_KEY_PATH)) {
    return {
      ok: false,
      error: `本地 SSH 隧道缺少私钥文件：${LOCAL_GATEWAY_TUNNEL_KEY_PATH}`,
    };
  }

  return {
    ok: true,
    keyPath: LOCAL_GATEWAY_TUNNEL_KEY_PATH,
  };
}

function stopBundledLocalGatewayTunnel(options = {}) {
  const state = readLocalGatewayTunnelState();
  const requestedPort =
    Number.isFinite(Number(options.localPort)) && Number(options.localPort) > 0
      ? Number(options.localPort)
      : null;
  const statePort =
    Number.isFinite(Number(state?.localPort)) && Number(state.localPort) > 0
      ? Number(state.localPort)
      : null;
  const tunnelPorts = Array.from(
    new Set([requestedPort, statePort, LOCAL_GATEWAY_TUNNEL_PORT].filter((value) => Number.isFinite(value) && value > 0)),
  );
  const listeningPids = tunnelPorts.flatMap((port) => listListeningPids(port));
  const statePid = Number(state?.pid);
  const stoppedPids = killProcessesByPid([
    ...(Number.isFinite(statePid) && statePid > 0 ? [statePid] : []),
    ...listeningPids,
  ]);

  if (options.clearState !== false) {
    removeFileIfExists(LOCAL_GATEWAY_TUNNEL_STATE_PATH);
    removeFileIfExists(LOCAL_GATEWAY_TUNNEL_CONFIG_PATH);
  }

  return {
    stoppedPids,
    tunnelPorts,
  };
}

async function ensureBundledLocalGatewayTunnel(config) {
  if (!config) {
    return { ok: true, skipped: true };
  }

  const keyResult = ensureLocalGatewayTunnelPrivateKey(config);
  if (!keyResult.ok) {
    return keyResult;
  }

  const currentState = readLocalGatewayTunnelState();
  const localPortOpen = await checkLocalPortOpen(config.localPort);
  const currentStatePortCandidates = buildLocalGatewayTunnelPortCandidates(currentState);
  const sameConfig =
    currentState &&
    currentState.host === config.host &&
    currentState.user === config.user &&
    Number(currentState.localPort) === config.localPort &&
    Number(currentState.remotePort) === config.remotePort &&
    areNumberArraysEqual(currentStatePortCandidates, config.sshPortCandidates);

  if (sameConfig && Number.isFinite(Number(currentState?.pid)) && isProcessAlive(Number(currentState.pid)) && localPortOpen) {
    return { ok: true, reused: true, pid: Number(currentState.pid) };
  }

  if (localPortOpen && !sameConfig) {
    return { ok: true, reusedListeningPort: true };
  }

  if (currentState && (sameConfig || isProcessAlive(Number(currentState.pid)))) {
    stopBundledLocalGatewayTunnel({
      localPort: Number(currentState.localPort) || config.localPort,
    });
    await delay(250);
  }

  const helperConfig = {
    host: config.host,
    user: config.user,
    localPort: config.localPort,
    remotePort: config.remotePort,
    sshPort: config.sshPort,
    sshPortCandidates: config.sshPortCandidates,
    keyPath: keyResult.keyPath,
    statePath: LOCAL_GATEWAY_TUNNEL_STATE_PATH,
    logPath: LOCAL_BOOTSTRAP_LOG,
  };
  writeJsonFile(LOCAL_GATEWAY_TUNNEL_CONFIG_PATH, helperConfig);

  const child = spawn(process.execPath, [LOCAL_GATEWAY_TUNNEL_HELPER_PATH, LOCAL_GATEWAY_TUNNEL_CONFIG_PATH], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (await checkLocalPortOpen(config.localPort)) {
      return { ok: true, pid: child.pid };
    }

    const nextState = readLocalGatewayTunnelState();
    if (nextState?.status === "error" && typeof nextState.lastError === "string" && nextState.lastError.trim()) {
      return {
        ok: false,
        error: nextState.lastError.trim(),
      };
    }

    await delay(250);
  }

  return {
    ok: false,
    error: "本地 SSH 隧道启动超时。",
  };
}

async function prepareLocalGatewayTunnelPayload(payload) {
  const config = normalizeLocalGatewayTunnelConfig(payload);
  if (!config) {
    return {
      ok: true,
      payload,
      tunnelConfig: null,
    };
  }

  const tunnelResult = await ensureBundledLocalGatewayTunnel(config);
  if (!tunnelResult.ok) {
    return {
      ok: false,
      error: tunnelResult.error || "本地 SSH 隧道启动失败。",
    };
  }

  return {
    ok: true,
    tunnelConfig: config,
    payload: {
      ...payload,
      originalBaseUrl: config.originalBaseUrl || payload.baseUrl,
      baseUrl: config.effectiveBaseUrl,
      gatewayTunnel: buildPersistedLocalGatewayTunnel(config),
    },
  };
}

async function ensurePersistedLocalGatewayTunnel() {
  if (localGatewayTunnelEnsurePromise) {
    return localGatewayTunnelEnsurePromise;
  }

  const binding = readLocalBindingState();
  const config = normalizeLocalGatewayTunnelConfig(binding);
  if (!config) {
    return { ok: true, skipped: true };
  }

  localGatewayTunnelEnsurePromise = ensureBundledLocalGatewayTunnel(config).finally(() => {
    localGatewayTunnelEnsurePromise = null;
  });
  return localGatewayTunnelEnsurePromise;
}

function resolveManagedProviderIds(binding) {
  const providerIds = [];
  const hasManagedProviderList = binding && Array.isArray(binding.managedProviderIds);
  const push = (value) => {
    if (typeof value !== "string") {
      return;
    }

    const normalized = value.trim();
    if (!normalized || providerIds.includes(normalized)) {
      return;
    }

    providerIds.push(normalized);
  };

  if (hasManagedProviderList) {
    for (const value of binding.managedProviderIds) {
      push(value);
    }
  }

  if (!hasManagedProviderList && binding && typeof binding.providerId === "string" && binding.providerId.trim()) {
    push(binding.providerId);
    if (binding.providerId.trim() !== "openai") {
      push("openai");
    }
  }

  return providerIds;
}

function resolveManagedProfileIds(binding) {
  const profileIds = [];
  const hasManagedProfileList = binding && Array.isArray(binding.managedProfileIds);
  const push = (value) => {
    if (typeof value !== "string") {
      return;
    }

    const normalized = value.trim();
    if (!normalized || profileIds.includes(normalized)) {
      return;
    }

    profileIds.push(normalized);
  };

  if (hasManagedProfileList) {
    for (const value of binding.managedProfileIds) {
      push(value);
    }
  }

  if (!hasManagedProfileList) {
    for (const providerId of resolveManagedProviderIds(binding)) {
      push(`${providerId}:default`);
    }
  }

  return profileIds;
}

function hasLocalManagedProviderApiKey(binding, config, authStore) {
  const managedProviderIds = resolveManagedProviderIds(binding);
  const managedProfileIds = resolveManagedProfileIds(binding);
  const authProfiles = isPlainObject(authStore?.profiles) ? authStore.profiles : {};
  const configProviders =
    isPlainObject(config?.models) && isPlainObject(config.models.providers)
      ? config.models.providers
      : {};

  for (const profileId of managedProfileIds) {
    const profile = authProfiles[profileId];
    if (
      isPlainObject(profile) &&
      typeof profile.key === "string" &&
      profile.key.trim()
    ) {
      return true;
    }
  }

  for (const providerId of managedProviderIds) {
    const provider = configProviders[providerId];
    if (
      isPlainObject(provider) &&
      typeof provider.apiKey === "string" &&
      provider.apiKey.trim()
    ) {
      return true;
    }
  }

  if (!managedProviderIds.length && !managedProfileIds.length) {
    for (const profile of Object.values(authProfiles)) {
      if (
        isPlainObject(profile) &&
        typeof profile.key === "string" &&
        profile.key.trim()
      ) {
        return true;
      }
    }

    for (const provider of Object.values(configProviders)) {
      if (
        isPlainObject(provider) &&
        typeof provider.apiKey === "string" &&
        provider.apiKey.trim()
      ) {
        return true;
      }
    }
  }

  return false;
}

function clearLocalBindingState() {
  try {
    fs.rmSync(LOCAL_BINDING_STATE_PATH, { force: true });
  } catch {
    // Ignore missing binding state.
  }
}

function removePathIfExists(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return false;
    }

    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function removeFileIfExists(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return false;
    }

    fs.rmSync(targetPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function removeManagedOpenClawLaunchAgents(agents) {
  const removedAgents = [];

  for (const agent of agents) {
    if (removeFileIfExists(agent.plistPath)) {
      removedAgents.push(agent.label || path.basename(agent.plistPath));
    }
  }

  return removedAgents;
}

function removeEmptyDirectory(targetPath) {
  try {
    fs.rmdirSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeLocalOpenClawCredentials() {
  const binding = readLocalBindingState();
  const managedProviderIds = resolveManagedProviderIds(binding);
  const managedProfileIds = resolveManagedProfileIds(binding);
  const config = readJsonFile(LOCAL_OPENCLAW_CONFIG_PATH);
  if (config && typeof config === "object") {
    const nextConfig = { ...config };
    const providers =
      nextConfig.models &&
      typeof nextConfig.models === "object" &&
      nextConfig.models.providers &&
      typeof nextConfig.models.providers === "object"
        ? nextConfig.models.providers
        : null;

    if (providers) {
      for (const providerId of managedProviderIds) {
        const provider = providers[providerId];
        if (provider && typeof provider === "object") {
          delete provider.apiKey;
        }
      }
    }

    if (nextConfig.auth && typeof nextConfig.auth === "object") {
      if (
        nextConfig.auth.profiles &&
        typeof nextConfig.auth.profiles === "object" &&
        managedProfileIds.length > 0
      ) {
        const nextProfiles = { ...nextConfig.auth.profiles };
        for (const profileId of managedProfileIds) {
          delete nextProfiles[profileId];
        }
        nextConfig.auth.profiles = nextProfiles;
      }

      if (nextConfig.auth.lastGood && typeof nextConfig.auth.lastGood === "object") {
        const nextLastGood = { ...nextConfig.auth.lastGood };
        for (const providerId of managedProviderIds) {
          delete nextLastGood[providerId];
        }
        nextConfig.auth.lastGood = nextLastGood;
      }
    }

    writeJsonFile(LOCAL_OPENCLAW_CONFIG_PATH, nextConfig);
  }

  if (fs.existsSync(LOCAL_OPENCLAW_AUTH_STORE_PATH)) {
    const existingStore = readLocalOpenClawAuthStore();
    const nextStore = isPlainObject(existingStore) ? { ...existingStore } : {};
    nextStore.version = 1;
    nextStore.profiles = isPlainObject(nextStore.profiles) ? { ...nextStore.profiles } : {};
    nextStore.lastGood = isPlainObject(nextStore.lastGood) ? { ...nextStore.lastGood } : {};
    nextStore.usageStats = isPlainObject(nextStore.usageStats) ? { ...nextStore.usageStats } : {};

    for (const profileId of managedProfileIds) {
      delete nextStore.profiles[profileId];
    }

    for (const providerId of managedProviderIds) {
      delete nextStore.lastGood[providerId];
    }

    writeJsonFile(LOCAL_OPENCLAW_AUTH_STORE_PATH, nextStore);
  }

  if (binding && typeof binding === "object") {
    const nextBinding = { ...binding };
    delete nextBinding.ownerAccountScopeId;
    delete nextBinding.ownerUserId;
    delete nextBinding.ownerDisplayName;
    delete nextBinding.ownerEmail;
    delete nextBinding.authSyncedAt;
    delete nextBinding.managedProviderIds;
    delete nextBinding.managedProfileIds;
    nextBinding.updatedAt = new Date().toISOString();
    writeJsonFile(LOCAL_BINDING_STATE_PATH, nextBinding);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveManagedModelCompat(modelId) {
  const normalized = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  const compat = {
    supportsUsageInStreaming: false,
  };

  if (!normalized) {
    return compat;
  }

  if (normalized.startsWith("qwen")) {
    compat.supportsStrictMode = false;
    compat.thinkingFormat = "qwen";
    return compat;
  }

  if (normalized.startsWith("glm")) {
    compat.thinkingFormat = "zai";
    return compat;
  }

  if (
    normalized.startsWith("gpt-") ||
    normalized === "gpt-4o" ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    compat.thinkingFormat = "openai";
    return compat;
  }

  return compat;
}

function applyManagedModelCompat(target, modelId) {
  if (!isPlainObject(target)) {
    return;
  }

  const nextCompat = resolveManagedModelCompat(modelId);
  target.compat = isPlainObject(target.compat) ? { ...target.compat } : {};
  target.compat.supportsUsageInStreaming = nextCompat.supportsUsageInStreaming;

  if (Object.prototype.hasOwnProperty.call(nextCompat, "supportsStrictMode")) {
    target.compat.supportsStrictMode = nextCompat.supportsStrictMode;
  } else {
    delete target.compat.supportsStrictMode;
  }

  if (typeof nextCompat.thinkingFormat === "string" && nextCompat.thinkingFormat.trim()) {
    target.compat.thinkingFormat = nextCompat.thinkingFormat;
  } else {
    delete target.compat.thinkingFormat;
  }
}

function isStableManagedModelAlias(modelId) {
  const normalized = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  return normalized === LOCAL_RESPONSES_MODEL_ALIAS;
}

function normalizeConcreteManagedModelId(modelId) {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalized) {
    return "";
  }

  if (isStableManagedModelAlias(normalized)) {
    return "";
  }

  const lower = normalized.toLowerCase();
  if (lower === "qwen35-plus" || lower === "qwen3.5-plus") {
    return "qwen35-plus";
  }
  return normalized;
}

function extractConcreteManagedModelIdFromConfig(config, providerId = "") {
  if (!isPlainObject(config)) {
    return "";
  }

  const primary =
    typeof config?.agents?.defaults?.model?.primary === "string"
      ? config.agents.defaults.model.primary.trim()
      : "";
  if (primary.includes("/")) {
    const primaryModelId = normalizeConcreteManagedModelId(primary.split("/").slice(1).join("/"));
    if (primaryModelId) {
      return primaryModelId;
    }
  }

  const providers = isPlainObject(config?.models?.providers) ? config.models.providers : {};
  const providerOrder = [];
  const pushProvider = (value) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || providerOrder.includes(normalized)) {
      return;
    }
    providerOrder.push(normalized);
  };

  pushProvider(providerId);
  Object.keys(providers).forEach((value) => pushProvider(value));

  for (const id of providerOrder) {
    const models = Array.isArray(providers[id]?.models) ? providers[id].models : [];
    for (const item of models) {
      const candidate = normalizeConcreteManagedModelId(item?.id);
      if (candidate) {
        return candidate;
      }
    }
  }

  return "";
}

function resolveLocalMainSessionStoreKeys(config) {
  const configuredMainKey =
    typeof config?.session?.mainKey === "string" && config.session.mainKey.trim()
      ? config.session.mainKey.trim()
      : "main";

  return Array.from(new Set([`agent:main:${configuredMainKey}`, configuredMainKey, "main"]));
}

function extractConcreteManagedModelIdFromSessionStore(config) {
  const store = readJsonFile(LOCAL_OPENCLAW_SESSION_STORE_PATH);
  if (!isPlainObject(store)) {
    return "";
  }

  for (const key of resolveLocalMainSessionStoreKeys(config)) {
    const entry = isPlainObject(store[key]) ? store[key] : null;
    const candidate =
      typeof entry?.model === "string" && entry.model.trim()
        ? entry.model
        : typeof entry?.modelOverride === "string" && entry.modelOverride.trim()
          ? entry.modelOverride
          : "";
    const modelId = normalizeConcreteManagedModelId(candidate);
    if (modelId) {
      return modelId;
    }
  }

  return "";
}

function normalizeManagedModelId(modelId, options = {}) {
  const direct = normalizeConcreteManagedModelId(modelId);
  if (direct) {
    return direct;
  }

  const preferred = normalizeConcreteManagedModelId(options?.preferredModelId);
  if (preferred) {
    return preferred;
  }

  const existing = extractConcreteManagedModelIdFromConfig(
    options?.existingConfig,
    options?.providerId,
  );
  if (existing) {
    return existing;
  }

  return "qwen35-plus";
}

function normalizeManagedModelIdList(modelIds, options = {}) {
  const normalizedList = [];
  const seen = new Set();
  const push = (candidate) => {
    const normalized = normalizeConcreteManagedModelId(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    normalizedList.push(normalized);
  };

  push(options.primaryModelId);
  if (Array.isArray(modelIds)) {
    for (const candidate of modelIds) {
      push(candidate);
    }
  }

  const fallbackModelId = normalizeManagedModelId(options.fallbackModelId, {
    preferredModelId: options.primaryModelId,
    existingConfig: options.existingConfig,
    providerId: options.providerId,
  });
  push(fallbackModelId);
  return normalizedList;
}

function removeProviderScopedKeys(record, providerId) {
  if (!isPlainObject(record) || !providerId) {
    return {};
  }

  const nextRecord = { ...record };
  for (const key of Object.keys(nextRecord)) {
    if (
      key === providerId ||
      key === `${providerId}:default` ||
      key.startsWith(`${providerId}:`) ||
      key.startsWith(`${providerId}-`)
    ) {
      delete nextRecord[key];
    }
  }

  return nextRecord;
}

function ensureLocalOpenClawAuthState(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.providerId !== "string" ||
    typeof payload.apiKey !== "string" ||
    !payload.providerId.trim() ||
    !payload.apiKey.trim()
  ) {
    return { ok: false, reason: "missing-auth-payload" };
  }

  const providerId = payload.providerId.trim();
  const apiKey = payload.apiKey.trim();
  const workspaceId =
    typeof payload.workspaceId === "string" && payload.workspaceId.trim()
      ? payload.workspaceId.trim()
      : "";
  const deploymentId =
    typeof payload.deploymentId === "string" && payload.deploymentId.trim()
      ? payload.deploymentId.trim()
      : "";
  const existingConfigRaw = readJsonFile(LOCAL_OPENCLAW_CONFIG_PATH);
  const modelId = normalizeManagedModelId(payload.modelId, {
    preferredModelId:
      (typeof payload.concreteModelId === "string" && payload.concreteModelId.trim()) ||
      (typeof payload.requestedModelId === "string" && payload.requestedModelId.trim()) ||
      "",
    existingConfig: existingConfigRaw,
    providerId,
  });
  const allowedModelIds = normalizeManagedModelIdList(payload.allowedModelIds, {
    primaryModelId: modelId,
    fallbackModelId: modelId,
    existingConfig: existingConfigRaw,
    providerId,
  });
  const baseUrl =
    typeof payload.baseUrl === "string" && payload.baseUrl.trim() ? payload.baseUrl.trim() : "";
  const gatewayPort = Math.max(
    Number(payload.gatewayPort || LOCAL_DEFAULT_DASHBOARD_PORT) || LOCAL_DEFAULT_DASHBOARD_PORT,
    1,
  );
  const gatewayBind =
    typeof payload.gatewayBind === "string" && payload.gatewayBind.trim()
      ? payload.gatewayBind.trim()
      : "loopback";
  const ownerAccountScopeId =
    typeof payload.accountScopeId === "string" && payload.accountScopeId.trim()
      ? payload.accountScopeId.trim()
      : workspaceId;
  const ownerUserId =
    typeof payload.userId === "string" && payload.userId.trim() ? payload.userId.trim() : "";
  const ownerDisplayName =
    typeof payload.displayName === "string" && payload.displayName.trim()
      ? payload.displayName.trim()
      : "";
  const ownerEmail =
    typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : "";
  const persistedGatewayTunnel = buildPersistedLocalGatewayTunnel(
    normalizeLocalGatewayTunnelConfig(payload),
  );
  const existingBinding = readLocalBindingState();
  const localDeviceIdentity = getOrCreateLocalDesktopDeviceIdentity();
  const localDeviceId =
    typeof payload.localDeviceId === "string" && payload.localDeviceId.trim()
      ? payload.localDeviceId.trim()
      : typeof existingBinding?.localDeviceId === "string" && existingBinding.localDeviceId.trim()
        ? existingBinding.localDeviceId.trim()
        : localDeviceIdentity.deviceId;
  const localDeviceLabel =
    typeof payload.localDeviceLabel === "string" && payload.localDeviceLabel.trim()
      ? payload.localDeviceLabel.trim()
      : typeof existingBinding?.localDeviceLabel === "string" && existingBinding.localDeviceLabel.trim()
        ? existingBinding.localDeviceLabel.trim()
        : localDeviceIdentity.deviceLabel;
  const workspaceDir = LOCAL_OPENCLAW_WORKSPACE_DIR;
  const hadConfigFile = fs.existsSync(LOCAL_OPENCLAW_CONFIG_PATH);
  const hadAuthStoreFile = fs.existsSync(LOCAL_OPENCLAW_AUTH_STORE_PATH);
  const existingAuthStoreRaw = readLocalOpenClawAuthStore();
  const hadManagedOpenAiAlias =
    (Array.isArray(existingBinding?.managedProviderIds) &&
      existingBinding.managedProviderIds.includes("openai")) ||
    (Array.isArray(existingBinding?.managedProfileIds) &&
      existingBinding.managedProfileIds.includes("openai:default"));
  const shouldReplaceManagedOpenAiAlias = hadManagedOpenAiAlias && providerId !== "openai";
  const managedProviderIds = [providerId];
  const managedProfileIds = managedProviderIds.map((item) => `${item}:default`);

  ensureDirectory(LOCAL_OPENCLAW_AGENT_DIR);
  ensureDirectory(workspaceDir);

  const authStore = isPlainObject(existingAuthStoreRaw) ? { ...existingAuthStoreRaw } : {};
  authStore.version = 1;
  authStore.profiles = isPlainObject(authStore.profiles) ? { ...authStore.profiles } : {};
  authStore.lastGood = isPlainObject(authStore.lastGood) ? { ...authStore.lastGood } : {};
  authStore.usageStats = isPlainObject(authStore.usageStats) ? { ...authStore.usageStats } : {};

  authStore.profiles[`${providerId}:default`] = {
    type: "api_key",
    provider: providerId,
    key: apiKey,
  };
  authStore.lastGood[providerId] = `${providerId}:default`;

  if (shouldReplaceManagedOpenAiAlias) {
    delete authStore.profiles["openai:default"];
    delete authStore.lastGood.openai;
  }

  writeJsonFile(LOCAL_OPENCLAW_AUTH_STORE_PATH, authStore);

  const config = isPlainObject(existingConfigRaw) ? { ...existingConfigRaw } : {};
  const existingGatewayAuth =
    isPlainObject(config.gateway) && isPlainObject(config.gateway.auth) ? config.gateway.auth : {};
  const gatewayToken =
    (typeof payload.gatewayToken === "string" && payload.gatewayToken.trim()) ||
    (typeof existingGatewayAuth.token === "string" && existingGatewayAuth.token.trim()) ||
    randomBytes(24).toString("hex");

  config.meta = isPlainObject(config.meta) ? { ...config.meta } : {};
  if (typeof config.meta.lastTouchedVersion !== "string" || !config.meta.lastTouchedVersion.trim()) {
    config.meta.lastTouchedVersion = "2026.3.13";
  }
  config.meta.lastTouchedAt = new Date().toISOString();

  config.wizard = isPlainObject(config.wizard) ? { ...config.wizard } : {};
  if (typeof config.wizard.lastRunVersion !== "string" || !config.wizard.lastRunVersion.trim()) {
    config.wizard.lastRunVersion = "2026.3.13";
  }
  config.wizard.lastRunAt = new Date().toISOString();
  config.wizard.lastRunCommand = "onboard";
  config.wizard.lastRunMode = "local";

  config.session = isPlainObject(config.session) ? { ...config.session } : {};
  if (typeof config.session.dmScope !== "string" || !config.session.dmScope.trim()) {
    config.session.dmScope = "per-channel-peer";
  }

  config.commands = isPlainObject(config.commands) ? { ...config.commands } : {};
  config.commands.native = "auto";
  config.commands.nativeSkills = "auto";
  config.commands.restart = true;
  config.commands.ownerDisplay = "raw";

  config.models = isPlainObject(config.models) ? { ...config.models } : {};
  config.models.mode =
    typeof config.models.mode === "string" && config.models.mode.trim()
      ? config.models.mode
      : "merge";
  const existingProviders = isPlainObject(config.models.providers) ? config.models.providers : {};
  config.models.providers = removeProviderScopedKeys(existingProviders, providerId);
  if (shouldReplaceManagedOpenAiAlias) {
    config.models.providers = removeProviderScopedKeys(config.models.providers, "openai");
  }

  const ensureProviderConfig = (id) => {
    const currentProvider = isPlainObject(config.models.providers[id])
      ? { ...config.models.providers[id] }
      : {};
    currentProvider.api = "openai-completions";
    currentProvider.apiKey = apiKey;
    if (baseUrl) {
      currentProvider.baseUrl = baseUrl;
    }
    const models = Array.isArray(currentProvider.models) ? [...currentProvider.models] : [];
    for (const allowedModelId of allowedModelIds) {
      if (!models.some((item) => item && typeof item === "object" && item.id === allowedModelId)) {
        models.push({
          id: allowedModelId,
          name: `${allowedModelId} (Custom Provider)`,
          input: ["text", "image"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });
      }
    }
    for (const item of models) {
      if (item && typeof item === "object") {
        if (typeof item.name !== "string" || !item.name.trim()) {
          item.name = `${item.id || modelId} (Custom Provider)`;
        }
        const nextInput = new Set(
          Array.isArray(item.input)
            ? item.input
                .map((value) => (typeof value === "string" ? value.trim() : ""))
                .filter(Boolean)
            : [],
        );
        nextInput.add("text");
        nextInput.add("image");
        item.input = Array.from(nextInput);
        item.cost = isPlainObject(item.cost) ? { ...item.cost } : {};
        item.cost.input = Number(item.cost.input || 0);
        item.cost.output = Number(item.cost.output || 0);
        item.cost.cacheRead = Number(item.cost.cacheRead || 0);
        item.cost.cacheWrite = Number(item.cost.cacheWrite || 0);
        item.contextWindow = Math.max(Number(item.contextWindow || 0), 262144);
        item.maxTokens = Math.max(Number(item.maxTokens || 0), 8192);
        item.reasoning = false;
        applyManagedModelCompat(item, item.id || modelId);
      }
    }
    currentProvider.models = models;
    config.models.providers[id] = currentProvider;
  };

  ensureProviderConfig(providerId);

  config.auth = isPlainObject(config.auth) ? { ...config.auth } : {};
  config.auth.profiles = isPlainObject(config.auth.profiles) ? { ...config.auth.profiles } : {};
  config.auth.profiles[`${providerId}:default`] = {
    provider: providerId,
    mode: "api_key",
  };
  if (shouldReplaceManagedOpenAiAlias) {
    delete config.auth.profiles["openai:default"];
  }

  config.agents = isPlainObject(config.agents) ? { ...config.agents } : {};
  config.agents.defaults = isPlainObject(config.agents.defaults) ? { ...config.agents.defaults } : {};
  config.agents.defaults.model = isPlainObject(config.agents.defaults.model)
    ? { ...config.agents.defaults.model }
    : {};
  config.agents.defaults.model.primary = `${providerId}/${modelId}`;
  config.agents.defaults.model.fallbacks = allowedModelIds
    .filter((candidate) => candidate !== modelId)
    .map((candidate) => `${providerId}/${candidate}`);
  const existingDefaultModels = isPlainObject(config.agents.defaults.models)
    ? { ...config.agents.defaults.models }
    : {};
  for (const candidate of allowedModelIds) {
    const managedModelKey = `${providerId}/${candidate}`;
    existingDefaultModels[managedModelKey] = isPlainObject(existingDefaultModels[managedModelKey])
      ? { ...existingDefaultModels[managedModelKey] }
      : {};
  }
  config.agents.defaults.models = existingDefaultModels;
  config.agents.defaults.workspace = workspaceDir;
  delete config.agents.defaults.skipBootstrap;
  delete config.agents.defaults.bootstrapMaxChars;
  delete config.agents.defaults.bootstrapTotalMaxChars;
  const existingAgentList = Array.isArray(config.agents.list) ? [...config.agents.list] : [];
  const mainAgentIndex = existingAgentList.findIndex((entry) => isPlainObject(entry) && entry.id === "main");
  const mainAgent =
    mainAgentIndex >= 0 && isPlainObject(existingAgentList[mainAgentIndex])
      ? { ...existingAgentList[mainAgentIndex] }
      : { id: "main", default: true };
  mainAgent.id = "main";
  if (typeof mainAgent.default !== "boolean") {
    mainAgent.default = true;
  }
  mainAgent.workspace = workspaceDir;
  if (mainAgentIndex >= 0) {
    existingAgentList[mainAgentIndex] = mainAgent;
    config.agents.list = existingAgentList;
  } else {
    config.agents.list = [mainAgent, ...existingAgentList];
  }

  config.skills = isPlainObject(config.skills) ? { ...config.skills } : {};
  config.skills.limits = isPlainObject(config.skills.limits) ? { ...config.skills.limits } : {};
  if (
    Array.isArray(config.skills.allowBundled) &&
    config.skills.allowBundled.length === 1 &&
    config.skills.allowBundled[0] === "__xlb_none__"
  ) {
    delete config.skills.allowBundled;
  }
  delete config.skills.limits.maxSkillsInPrompt;
  delete config.skills.limits.maxSkillsPromptChars;
  if (!Object.keys(config.skills.limits).length) {
    delete config.skills.limits;
  }
  if (!Object.keys(config.skills).length) {
    delete config.skills;
  }
  config.gateway = isPlainObject(config.gateway) ? { ...config.gateway } : {};
  config.gateway.port = gatewayPort;
  config.gateway.mode = "local";
  config.gateway.bind = gatewayBind;
  config.gateway.auth = isPlainObject(config.gateway.auth) ? { ...config.gateway.auth } : {};
  config.gateway.auth.mode = "token";
  config.gateway.auth.token = gatewayToken;
  config.gateway.http = isPlainObject(config.gateway.http) ? { ...config.gateway.http } : {};
  config.gateway.http.endpoints = isPlainObject(config.gateway.http.endpoints)
    ? { ...config.gateway.http.endpoints }
    : {};
  config.gateway.http.endpoints.responses = isPlainObject(config.gateway.http.endpoints.responses)
    ? { ...config.gateway.http.endpoints.responses }
    : {};
  config.gateway.http.endpoints.responses.enabled = true;
  config.gateway.tailscale = isPlainObject(config.gateway.tailscale)
    ? { ...config.gateway.tailscale }
    : {};
  config.gateway.tailscale.mode = "off";
  config.gateway.tailscale.resetOnExit = false;
  config.tools = isPlainObject(config.tools) ? { ...config.tools } : {};
  if (typeof config.tools.profile !== "string" || !config.tools.profile.trim()) {
    config.tools.profile = "coding";
  }

  writeJsonFile(LOCAL_OPENCLAW_CONFIG_PATH, config);

  const nextWorkspaceId = workspaceId || existingBinding?.workspaceId || "";
  const nextDeploymentId = deploymentId || existingBinding?.deploymentId || "";
  if (nextWorkspaceId || nextDeploymentId) {
    writeJsonFile(LOCAL_BINDING_STATE_PATH, {
      accountScopeId: ownerAccountScopeId || nextWorkspaceId,
      workspaceId: nextWorkspaceId,
      deploymentId: nextDeploymentId,
      localDeviceId,
      localDeviceLabel,
      localPlatform: process.platform,
      providerId,
      managedProviderIds,
      managedProfileIds,
      baseUrl:
        typeof payload.originalBaseUrl === "string" && payload.originalBaseUrl.trim()
          ? payload.originalBaseUrl.trim()
          : baseUrl,
      ...(persistedGatewayTunnel ? { gatewayTunnel: persistedGatewayTunnel } : {}),
      ownerAccountScopeId:
        ownerAccountScopeId ||
        (typeof existingBinding?.ownerAccountScopeId === "string"
          ? existingBinding.ownerAccountScopeId
          : ""),
      ownerUserId:
        ownerUserId ||
        (typeof existingBinding?.ownerUserId === "string" ? existingBinding.ownerUserId : ""),
      ownerDisplayName:
        ownerDisplayName ||
        (typeof existingBinding?.ownerDisplayName === "string"
          ? existingBinding.ownerDisplayName
          : ""),
      ownerEmail:
        ownerEmail ||
        (typeof existingBinding?.ownerEmail === "string" ? existingBinding.ownerEmail : ""),
      authSyncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    createdFreshState: !hadConfigFile || !hadAuthStoreFile,
    replacedExistingKey: hadConfigFile || hadAuthStoreFile,
  };
}

function appendLocalBootstrapLog(message) {
  ensureDirectory(LOCAL_LOG_DIR);
  fs.appendFileSync(LOCAL_BOOTSTRAP_LOG, `[xiaolanbu-local] ${message}\n`, "utf8");
}

async function waitForLocalOpenClawPorts(options = {}) {
  const attempts = Number(options.attempts || 45);
  const intervalMs = Number(options.intervalMs || 2000);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [dashboardPortOpen, browserControlPortOpen] = await Promise.all([
      checkLocalPortOpen(LOCAL_DEFAULT_DASHBOARD_PORT),
      checkLocalPortOpen(LOCAL_DEFAULT_BROWSER_CONTROL_PORT),
    ]);

    if (dashboardPortOpen && browserControlPortOpen) {
      return { ok: true };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { ok: false, error: "local-gateway-not-ready" };
}

async function restartLocalOpenClawGatewayService(reason = "credential-update") {
  appendLocalBootstrapLog(`restarting local gateway (${reason})`);
  await stopLocalOpenClaw({ clearBinding: false, clearCredentials: false, clearTunnel: false });

  if (!IS_WINDOWS) {
    const agents = listManagedOpenClawLaunchAgents();
    const startedAgents = [];

    for (const agent of agents) {
      const bootstrapped = bootstrapLaunchAgent(agent);
      const kicked = kickstartLaunchAgent(agent);
      if (bootstrapped || kicked) {
        startedAgents.push(agent.label || path.basename(agent.plistPath));
      }
    }

    if (startedAgents.length === 0) {
      const installResult = await tryRunLocalOpenClawGatewayCommand(["gateway", "install", "--json"]);
      if (!installResult.ok) {
        return {
          ok: false,
          error: installResult.error || "launch-agent-restart-failed",
        };
      }

      const installedAgents = listManagedOpenClawLaunchAgents();
      for (const agent of installedAgents) {
        const bootstrapped = bootstrapLaunchAgent(agent);
        const kicked = kickstartLaunchAgent(agent);
        if (bootstrapped || kicked) {
          startedAgents.push(agent.label || path.basename(agent.plistPath));
        }
      }
    }

    if (startedAgents.length === 0) {
      return {
        ok: false,
        error: "launch-agent-restart-failed",
      };
    }

    appendLocalBootstrapLog(`launch agent restart requested (${startedAgents.join(", ")})`);
  } else {
    const directStart = await tryRunLocalOpenClawGatewayCommand(["gateway", "start", "--json"]);
    if (directStart.ok && !/not-loaded/i.test(String(directStart.stdout || directStart.stderr || ""))) {
      appendLocalBootstrapLog("openclaw gateway start requested");
    } else {
    const taskRun = await runWindowsScheduledTaskCommand([
      "/Run",
      "/TN",
      WINDOWS_OPENCLAW_GATEWAY_TASK_NAME,
    ]);

    if (!taskRun.ok) {
      const gatewayScriptPath = path.join(LOCAL_OPENCLAW_STATE_DIR, "gateway.cmd");
      if (!fs.existsSync(gatewayScriptPath)) {
        return {
          ok: false,
          error: "gateway-launcher-missing",
        };
      }

      spawn("cmd.exe", ["/c", gatewayScriptPath], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PATH: buildLocalRuntimePath(),
        },
      }).unref();
      appendLocalBootstrapLog("gateway.cmd launch requested");
    } else {
      appendLocalBootstrapLog("scheduled task launch requested");
    }
    }
  }

  const ready = await waitForLocalOpenClawPorts();
  if (!ready.ok) {
    return ready;
  }

  appendLocalBootstrapLog("local gateway is ready after restart");
  return { ok: true };
}

async function restartLocalOpenClawGatewayForModelSwitch(currentStatus) {
  const requireReady =
    Boolean(currentStatus?.ready) ||
    Boolean(currentStatus?.dashboardPortOpen) ||
    Boolean(currentStatus?.browserControlPortOpen);

  appendLocalBootstrapLog("attempting lightweight gateway restart (model-switch)");
  const softRestart = await tryRunLocalOpenClawGatewayCommand(["gateway", "restart"]);
  if (softRestart.ok) {
    const softStatus = await waitForStableLocalOpenClawStatus({
      timeoutMs: 8_000,
      requireReady,
      requireAuth: true,
    });
    const softReady = (!requireReady || Boolean(softStatus.ready)) && Boolean(softStatus.localApiKeyConfigured);
    if (softReady) {
      appendLocalBootstrapLog("local gateway is ready after lightweight restart");
      return {
        ok: true,
        mode: "soft",
        status: softStatus,
      };
    }
    appendLocalBootstrapLog("lightweight gateway restart did not reach ready state, falling back");
  } else {
    appendLocalBootstrapLog(
      `lightweight gateway restart failed, falling back (${String(softRestart.error || "unknown-error")})`,
    );
  }

  const hardRestart = await restartLocalOpenClawGatewayService("model-switch");
  const hardStatus = hardRestart.ok
    ? await waitForStableLocalOpenClawStatus({
        timeoutMs: 12_000,
        requireReady,
        requireAuth: true,
      })
    : await getLocalOpenClawStatus();

  return {
    ...hardRestart,
    mode: "hard",
    status: hardStatus,
  };
}

async function syncLocalOpenClawAuthPayload(payload) {
  const preparedPayload = await prepareLocalGatewayTunnelPayload(payload);
  if (!preparedPayload.ok) {
    return {
      ok: false,
      error: preparedPayload.error || "本地 SSH 隧道启动失败。",
      status: await getLocalOpenClawStatus(),
    };
  }

  const effectivePayload = preparedPayload.payload;
  const ensuredAuthState = ensureLocalOpenClawAuthState(effectivePayload);
  if (!ensuredAuthState.ok) {
    return {
      ok: false,
      error: "本地 API Key 参数不完整，无法同步。",
      reason: ensuredAuthState.reason,
      status: await getLocalOpenClawStatus(),
    };
  }

  const currentStatus = await getLocalOpenClawStatus();
  const runtime = await detectLocalOpenClawRuntime();
  let gatewayRestart = null;
  const lightweightModelSwitch = effectivePayload?.modeSwitch === true;
  const skipRestart = effectivePayload?.skipRestart === true;

  if (
    !skipRestart &&
    (runtime.installed ||
      currentStatus.installed ||
      currentStatus.ready ||
      currentStatus.dashboardPortOpen ||
      currentStatus.browserControlPortOpen)
  ) {
    gatewayRestart = lightweightModelSwitch
      ? await restartLocalOpenClawGatewayForModelSwitch(currentStatus)
      : await restartLocalOpenClawGatewayService(
          ensuredAuthState.createdFreshState ? "auth-rebuild" : "auth-sync",
        );
  }

  const status =
    gatewayRestart && gatewayRestart.status
      ? gatewayRestart.status
      : gatewayRestart
        ? await waitForStableLocalOpenClawStatus({
            timeoutMs: 12_000,
            requireReady:
              Boolean(currentStatus.ready) ||
              Boolean(currentStatus.dashboardPortOpen) ||
              Boolean(currentStatus.browserControlPortOpen),
            requireAuth: true,
          })
        : await getLocalOpenClawStatus();

  return {
    ok: gatewayRestart ? Boolean(gatewayRestart.ok) : true,
    logPath: LOCAL_BOOTSTRAP_LOG,
    gatewayRestart,
    skippedRestart: skipRestart,
    createdFreshState: Boolean(ensuredAuthState.createdFreshState),
    replacedExistingKey: Boolean(ensuredAuthState.replacedExistingKey),
    status,
    error:
      gatewayRestart && !gatewayRestart.ok
        ? gatewayRestart.error || "本地 API Key 已写入，但本地网关重载失败。"
        : "",
  };
}

function normalizeGatewaySessionPatchKeys(sessionKey) {
  const normalized = typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : "main";
  return [normalized];
}

function parseLocalGatewayCliJsonOutput(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    throw new Error("local gateway CLI returned empty output");
  }
  return JSON.parse(trimmed);
}

async function callLocalOpenClawGatewayRpcViaCli({
  dashboardUrl,
  method,
  params = {},
  timeoutMs = 10000,
}) {
  const { token, wsUrl } = buildGatewayConnectionFromDashboardUrl(dashboardUrl);
  const args = [
    "gateway",
    "call",
    method,
    "--url",
    wsUrl,
    "--timeout",
    String(Math.max(Number(timeoutMs) || 10000, 1000)),
    "--json",
  ];

  if (token) {
    args.push("--token", token);
  }
  args.push("--params", JSON.stringify(params ?? {}));

  const result = await tryRunLocalOpenClawGatewayCommand(args);
  if (!result?.ok) {
    throw new Error(result?.error || `local gateway CLI failed for ${method}`);
  }

  try {
    return parseLocalGatewayCliJsonOutput(result.stdout);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `${method} returned invalid JSON: ${error.message}`
        : `${method} returned invalid JSON`,
    );
  }
}

const LOCAL_GATEWAY_RPC_CLIENT_IDLE_MS = 30_000;
const ENABLE_LOCAL_GATEWAY_RPC_CLIENT_CACHE = !IS_DESKTOP_HELPER_MODE;
const localGatewayRpcClientCache = new Map();

function buildLocalGatewayRpcClientCacheKey({
  dashboardUrl,
  scopes,
  omitDeviceIdentity = false,
}) {
  const normalizedDashboardUrl =
    typeof dashboardUrl === "string" ? dashboardUrl.trim() : "";
  const normalizedScopes =
    Array.isArray(scopes) && scopes.length > 0
      ? scopes
          .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
          .filter(Boolean)
          .sort()
          .join(",")
      : "";
  return JSON.stringify({
    dashboardUrl: normalizedDashboardUrl,
    scopes: normalizedScopes,
    omitDeviceIdentity: omitDeviceIdentity === true,
  });
}

function releaseCachedLocalGatewayRpcClient(key, entry, idleMs = LOCAL_GATEWAY_RPC_CLIENT_IDLE_MS) {
  if (!entry || typeof entry !== "object") {
    return;
  }

  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
  }

  entry.closeTimer = setTimeout(() => {
    const current = localGatewayRpcClientCache.get(key);
    if (current !== entry) {
      return;
    }

    localGatewayRpcClientCache.delete(key);
    Promise.resolve(entry.clientPromise)
      .then((client) => {
        try {
          client.close();
        } catch {
          // ignore close failure
        }
      })
      .catch(() => {
        // ignore creation failure during cached close
      });
  }, Math.max(Number(idleMs) || LOCAL_GATEWAY_RPC_CLIENT_IDLE_MS, 1000));
  entry.closeTimer?.unref?.();
}

function invalidateCachedLocalGatewayRpcClient(key, entry) {
  if (!key) {
    return;
  }

  const current = localGatewayRpcClientCache.get(key);
  if (entry && current !== entry) {
    return;
  }

  localGatewayRpcClientCache.delete(key);
  const target = entry ?? current;
  if (!target) {
    return;
  }

  if (target.closeTimer) {
    clearTimeout(target.closeTimer);
    target.closeTimer = null;
  }

  Promise.resolve(target.clientPromise)
    .then((client) => {
      try {
        client.close();
      } catch {
        // ignore close failure
      }
    })
    .catch(() => {
      // ignore creation failure during invalidation
    });
}

async function acquireCachedLocalGatewayRpcClient({
  dashboardUrl,
  connectTimeoutMs = 15000,
  scopes,
  omitDeviceIdentity = false,
}) {
  if (!ENABLE_LOCAL_GATEWAY_RPC_CLIENT_CACHE) {
    const client = await createGatewayRpcClient({
      dashboardUrl,
      connectTimeoutMs,
      scopes,
      omitDeviceIdentity,
    });
    let released = false;
    return {
      key: "",
      entry: null,
      client,
      release() {
        if (released) {
          return;
        }
        released = true;
        try {
          client.close();
        } catch {
          // ignore close failure
        }
      },
      invalidate() {
        if (released) {
          return;
        }
        released = true;
        try {
          client.close();
        } catch {
          // ignore close failure
        }
      },
    };
  }

  const key = buildLocalGatewayRpcClientCacheKey({
    dashboardUrl,
    scopes,
    omitDeviceIdentity,
  });
  let entry = localGatewayRpcClientCache.get(key);

  if (!entry) {
    entry = {
      clientPromise: createGatewayRpcClient({
        dashboardUrl,
        connectTimeoutMs,
        scopes,
        omitDeviceIdentity,
      }),
      closeTimer: null,
    };
    localGatewayRpcClientCache.set(key, entry);
    entry.clientPromise.catch(() => {
      invalidateCachedLocalGatewayRpcClient(key, entry);
    });
  } else if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  }

  const client = await entry.clientPromise;
  let released = false;

  return {
    key,
    entry,
    client,
    release() {
      if (released) {
        return;
      }
      released = true;
      releaseCachedLocalGatewayRpcClient(key, entry);
    },
    invalidate() {
      if (released) {
        return;
      }
      released = true;
      invalidateCachedLocalGatewayRpcClient(key, entry);
    },
  };
}

function isRetryableLocalGatewayRpcError(error) {
  const message =
    error instanceof Error ? error.message.trim().toLowerCase() : String(error || "").trim().toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes("gateway websocket closed") ||
    message.includes("gateway closed") ||
    message.includes("gateway connect timeout") ||
    message.includes("gateway connect challenge timeout") ||
    message.includes("gateway websocket error") ||
    message.includes("timeout")
  );
}

async function requestGatewayRpcWithTimeout(client, method, params, timeoutMs) {
  const normalizedTimeoutMs = Math.max(Number(timeoutMs) || 10000, 1000);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${method} timeout after ${normalizedTimeoutMs}ms`));
    }, normalizedTimeoutMs);

    Promise.resolve(client.request(method, params))
      .then((payload) => {
        clearTimeout(timer);
        resolve(payload);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function callLocalOpenClawGatewayRpc({
  dashboardUrl,
  method,
  params = {},
  timeoutMs = 10000,
}) {
  let directError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await acquireCachedLocalGatewayRpcClient({
        dashboardUrl,
        connectTimeoutMs: Math.min(Math.max(Number(timeoutMs) || 10000, 3000), 15000),
      });
      const payload = await requestGatewayRpcWithTimeout(
        handle.client,
        method,
        params,
        timeoutMs,
      );
      handle.release();
      return payload;
    } catch (error) {
      directError = error;
      if (handle) {
        handle.invalidate();
      }

      if (attempt === 0 && isRetryableLocalGatewayRpcError(error)) {
        continue;
      }

      break;
    }
  }

  try {
    return await callLocalOpenClawGatewayRpcViaCli({
      dashboardUrl,
      method,
      params,
      timeoutMs,
    });
  } catch (cliError) {
    if (directError instanceof Error) {
      throw new Error(`${directError.message}; CLI fallback failed: ${cliError instanceof Error ? cliError.message : String(cliError)}`);
    }
    throw cliError;
  }
}

async function waitForGatewayModelAvailability(dashboardUrl, modelId, timeoutMs = 4000) {
  const normalizedModelId = normalizeConcreteManagedModelId(modelId);
  if (!normalizedModelId) {
    return {
      ok: false,
      error: "invalid model id",
      availableModels: [],
    };
  }

  const deadline = Date.now() + Math.max(timeoutMs, 500);
  let availableModels = [];

  while (Date.now() <= deadline) {
    const payload = await callLocalOpenClawGatewayRpc({
      dashboardUrl,
      method: "models.list",
      params: {},
      timeoutMs: Math.min(timeoutMs, 5000),
    });
    availableModels = Array.isArray(payload?.models)
      ? payload.models
          .map((entry) => normalizeConcreteManagedModelId(entry?.id))
          .filter(Boolean)
      : [];
    if (availableModels.includes(normalizedModelId)) {
      return {
        ok: true,
        availableModels,
      };
    }
    await delay(250);
  }

  return {
    ok: false,
    error: `model not available in local gateway catalog: ${normalizedModelId}`,
    availableModels,
  };
}

async function patchLocalOpenClawSessionModel(payload) {
  const dashboardUrl =
    typeof payload?.dashboardUrl === "string" && payload.dashboardUrl.trim()
      ? payload.dashboardUrl.trim()
      : "";
  const modelId = normalizeConcreteManagedModelId(payload?.modelId);
  if (!dashboardUrl || !modelId) {
    return {
      ok: false,
      error: "缺少本地会话模型切换参数。",
      status: await getLocalOpenClawStatus(),
    };
  }

  const sessionKeys = normalizeGatewaySessionPatchKeys(payload?.sessionKey);

  try {
    const patchSessionsOnce = async () => {
      const patched = [];
      for (const key of sessionKeys) {
        try {
          const result = await callLocalOpenClawGatewayRpc({
            dashboardUrl,
            method: "sessions.patch",
            params: {
              key,
              model: modelId,
            },
            timeoutMs: 15000,
          });
          patched.push(result);
        } catch (error) {
          if (key === sessionKeys[0]) {
            throw error;
          }
        }
      }
      return patched;
    };

    let patched;
    try {
      patched = await patchSessionsOnce();
    } catch (initialError) {
      const availability = await waitForGatewayModelAvailability(dashboardUrl, modelId);
      if (!availability.ok) {
        return {
          ok: false,
          error: `本地网关尚未加载模型 ${modelId}。`,
          availableModels: availability.availableModels,
          status: await getLocalOpenClawStatus(),
        };
      }

      patched = await patchSessionsOnce().catch(() => {
        throw initialError;
      });
    }

    const resolved = [];
    for (const key of sessionKeys) {
      try {
        resolved.push(
          await callLocalOpenClawGatewayRpc({
            dashboardUrl,
            method: "sessions.resolve",
            params: { key },
            timeoutMs: 10000,
          }),
        );
      } catch {
        // ignore best-effort alias resolve failures
      }
    }

    return {
      ok: true,
      modelId,
      patched,
      resolved,
      status: await getLocalOpenClawStatus(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "本地会话模型切换失败。",
      status: await getLocalOpenClawStatus(),
    };
  }
}

async function clearLocalOpenClawApiKeyState() {
  sanitizeLocalOpenClawCredentials();
  const currentStatus = await getLocalOpenClawStatus();
  let gatewayRestart = null;

  if (
    currentStatus.installed ||
    currentStatus.ready ||
    currentStatus.dashboardPortOpen ||
    currentStatus.browserControlPortOpen
  ) {
    gatewayRestart = await restartLocalOpenClawGatewayService("auth-clear");
  }

  return {
    ok: gatewayRestart ? Boolean(gatewayRestart.ok) : true,
    logPath: LOCAL_BOOTSTRAP_LOG,
    gatewayRestart,
    status: await getLocalOpenClawStatus(),
    error:
      gatewayRestart && !gatewayRestart.ok
        ? gatewayRestart.error || "本地 API Key 已清除，但本地网关重载失败。"
        : "",
  };
}

function listListeningPids(port) {
  if (process.platform === "win32") {
    try {
      const output = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      const portSuffix = `:${String(port)}`;
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("TCP"))
        .map((line) => line.split(/\s+/))
        .filter(
          (parts) =>
            parts.length >= 5 &&
            parts[1].endsWith(portSuffix) &&
            parts[3].toUpperCase() === "LISTENING",
        )
        .map((parts) => Number(parts[4]))
        .filter((pid) => Number.isFinite(pid));
    } catch {
      return [];
    }
  }

  try {
    const output = execFileSync("lsof", [`-tiTCP:${String(port)}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

function killProcessesByPid(pids) {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isFinite(pid));
  for (const pid of uniquePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore already-exited processes.
    }
  }

  return uniquePids;
}

function extractLaunchAgentLabel(plistPath) {
  try {
    const content = fs.readFileSync(plistPath, "utf8");
    const match = content.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function listManagedOpenClawLaunchAgents() {
  if (process.platform !== "darwin") {
    return [];
  }

  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  if (!fs.existsSync(launchAgentsDir)) {
    return [];
  }

  return fs
    .readdirSync(launchAgentsDir)
    .filter((entry) => entry.endsWith(".plist"))
    .map((entry) => path.join(launchAgentsDir, entry))
    .filter((plistPath) => {
      const fileName = path.basename(plistPath).toLowerCase();
      if (fileName.includes("openclaw") || fileName.includes("clawdbot")) {
        return true;
      }

      try {
        const content = fs.readFileSync(plistPath, "utf8").toLowerCase();
        return content.includes("openclaw") || content.includes("clawdbot");
      } catch {
        return false;
      }
    })
    .map((plistPath) => ({
      plistPath,
      label: extractLaunchAgentLabel(plistPath),
    }));
}

function bootoutLaunchAgent(agent) {
  if (process.platform !== "darwin") {
    return false;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const domain = uid ? `gui/${String(uid)}` : "gui";

  try {
    execFileSync("launchctl", ["bootout", domain, agent.plistPath], {
      stdio: "ignore",
    });
    return true;
  } catch {
    if (agent.label) {
      try {
        execFileSync("launchctl", ["remove", agent.label], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

function bootstrapLaunchAgent(agent) {
  if (process.platform !== "darwin" || !agent?.plistPath) {
    return false;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const domain = uid ? `gui/${String(uid)}` : "gui";

  try {
    execFileSync("launchctl", ["bootstrap", domain, agent.plistPath], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function kickstartLaunchAgent(agent) {
  if (process.platform !== "darwin" || !agent?.label) {
    return false;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const domain = uid ? `gui/${String(uid)}` : "gui";

  try {
    execFileSync("launchctl", ["kickstart", "-k", `${domain}/${agent.label}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function syncLegacyGatewayTunnelKey() {
  const legacyPrivateKeyPath = LEGACY_LOCAL_GATEWAY_TUNNEL_KEY_PATH;
  const legacyPublicKeyPath = `${legacyPrivateKeyPath}.pub`;
  const currentPrivateKeyPath = LOCAL_GATEWAY_TUNNEL_KEY_PATH;
  const currentPublicKeyPath = `${currentPrivateKeyPath}.pub`;

  ensureDirectory(path.dirname(currentPrivateKeyPath));

  if (!fs.existsSync(currentPrivateKeyPath) && fs.existsSync(legacyPrivateKeyPath)) {
    fs.copyFileSync(legacyPrivateKeyPath, currentPrivateKeyPath);
    try {
      fs.chmodSync(currentPrivateKeyPath, 0o600);
    } catch {
      // Ignore chmod errors on copied key material.
    }
    if (fs.existsSync(legacyPublicKeyPath)) {
      fs.copyFileSync(legacyPublicKeyPath, currentPublicKeyPath);
    }
  }
}

function runSpawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }

      const error = new Error(
        stderr.trim() || stdout.trim() || `${command} exited with code ${String(code)}`,
      );
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = code;
      reject(error);
    });
  });
}

async function detectLocalOpenClawRuntime() {
  try {
    const result = IS_WINDOWS
      ? await runSpawnCapture("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          [
            `$env:Path = ${JSON.stringify(buildLocalRuntimePath())} + ';' + $env:Path`,
            "$cmd = Get-Command openclaw -ErrorAction SilentlyContinue",
            "if (-not $cmd) { exit 9 }",
            "$version = (& $cmd.Source --version 2>$null | Select-Object -First 1)",
            'Write-Output ("BINARY=" + $cmd.Source)',
            'Write-Output ("VERSION=" + $version)',
          ].join("; "),
        ])
      : await runSpawnCapture("/bin/bash", [
          "-lc",
          [
            `export PATH=${shellEscape(buildLocalRuntimePath())}`,
            "if ! command -v openclaw >/dev/null 2>&1; then exit 9; fi",
            'binary_path="$(command -v openclaw)"',
            'version="$($binary_path --version 2>/dev/null | head -n 1 || true)"',
            'printf "BINARY=%s\\nVERSION=%s\\n" "$binary_path" "$version"',
          ].join("\n"),
        ]);

    const binaryPath =
      result.stdout
        .split("\n")
        .find((line) => line.startsWith("BINARY="))
        ?.replace(/^BINARY=/, "")
        .trim() ?? "";
    let version =
      result.stdout
        .split("\n")
        .find((line) => line.startsWith("VERSION="))
        ?.replace(/^VERSION=/, "")
        .trim() ?? "";

    if (!version && binaryPath) {
      try {
        version = execFileSync(binaryPath, ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? "";
      } catch {
        // Ignore version fallback errors and keep the runtime marked as installed.
      }
    }

    return {
      ok: true,
      installed: Boolean(binaryPath),
      binaryPath,
      version,
    };
  } catch (error) {
    if (error?.code === 9) {
      return {
        ok: true,
        installed: false,
        binaryPath: "",
        version: "",
      };
    }

    return {
      ok: false,
      installed: false,
      binaryPath: "",
      version: "",
      error: error instanceof Error ? error.message : "detect-openclaw-failed",
    };
  }
}

function readTail(filePath, maxBytes = 4096) {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return "";
    }

    const start = Math.max(0, stats.size - maxBytes);
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

function readFileMtime(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return 0;
    }

    const stats = fs.statSync(filePath);
    return stats.isFile() ? stats.mtimeMs || 0 : 0;
  } catch {
    return 0;
  }
}

function deriveLocalBootstrapProgress(logTail, runtime) {
  const normalizedTail = typeof logTail === "string" ? logTail.trim() : "";
  const lines = normalizedTail ? normalizedTail.split("\n").filter(Boolean) : [];
  const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";

  const parseDownloadProgress = () => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      const percentMatch = line.match(/runtime bundle download progress\s+(\d{1,3})%\s+\(([^)]+)\)/i);
      if (percentMatch) {
        const percent = Number(percentMatch[1]);
        return {
          line,
          progressPercent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
          progressDetail: percentMatch[2].trim(),
        };
      }

      const detailMatch = line.match(/runtime bundle download progress\s+(.+)/i);
      if (detailMatch) {
        return {
          line,
          progressPercent: null,
          progressDetail: detailMatch[1].trim(),
        };
      }
    }

    return null;
  };

  if (runtime.dashboardPortOpen && runtime.browserControlPortOpen) {
    return {
      stage: "ready",
      message: "本地控制台已启动，可以直接开始聊天。",
      lastLine,
      progressPercent: null,
      progressDetail: "",
    };
  }

  if (runtime.dashboardPortOpen && !runtime.browserControlPortOpen) {
    return {
      stage: "service-start",
      message: "本地控制台主端口已启动，正在等待 Browser Control 就绪。",
      lastLine,
      progressPercent: null,
      progressDetail: "",
    };
  }

  if (!normalizedTail) {
    return {
      stage: runtime.installed ? "runtime-installed" : "idle",
      message: runtime.installed ? "运行时已安装，等待初始化。" : "尚未开始本地部署。",
      lastLine: "",
      progressPercent: null,
      progressDetail: "",
    };
  }

  const downloadProgress = parseDownloadProgress();
  if (downloadProgress) {
    return {
      stage: "runtime-download",
      message:
        typeof downloadProgress.progressPercent === "number"
          ? `正在下载本地运行时包（${downloadProgress.progressPercent}% · ${downloadProgress.progressDetail}）。`
          : `正在下载本地运行时包（${downloadProgress.progressDetail}）。`,
      lastLine: downloadProgress.line,
      progressPercent: downloadProgress.progressPercent,
      progressDetail: downloadProgress.progressDetail,
    };
  }

  const checks = [
    [
      "service-start",
      /loading launch agent|installed scheduled task|restarted scheduled task|scheduled task launch requested|gateway\.cmd launch requested|restarting local gateway service|waiting for ports|local gateway is ready|bootstrap finished/i,
      "正在启动本地控制台服务。",
    ],
    [
      "onboarding",
      /openclaw onboard|running onboard|binding state updated|updated OpenClaw auth\/config state/i,
      "正在初始化本地 OpenClaw 配置。",
    ],
    ["runtime-detected", /using packaged Xiaolanbu runtime|using existing OpenClaw/i, "已检测到本地运行时，正在初始化 OpenClaw。"],
    ["runtime-install", /installed Xiaolanbu runtime bundle/i, "运行时已下载完成，正在准备初始化环境。"],
    ["runtime-download", /downloading Xiaolanbu runtime bundle/i, "正在下载本地运行时包，首次部署通常需要几十秒。"],
  ];

  for (const [stage, pattern, message] of checks) {
    if (pattern.test(normalizedTail)) {
      return { stage, message, lastLine, progressPercent: null, progressDetail: "" };
    }
  }

  return {
    stage: runtime.installed ? "runtime-installed" : "working",
    message: runtime.installed ? "运行时已安装，正在继续初始化。" : "正在准备本地部署环境。",
    lastLine,
    progressPercent: null,
    progressDetail: "",
  };
}

async function waitForStableLocalOpenClawStatus(options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 15_000;
  const requireReady = options.requireReady !== false;
  const requireAuth = options.requireAuth === true;
  const startedAt = Date.now();
  let lastStatus = await getLocalOpenClawStatus();

  while (Date.now() - startedAt < timeoutMs) {
    const readySatisfied = requireReady ? Boolean(lastStatus.ready) : true;
    const authSatisfied = requireAuth ? Boolean(lastStatus.localApiKeyConfigured) : true;

    if (readySatisfied && authSatisfied) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    lastStatus = await getLocalOpenClawStatus();
  }

  return lastStatus;
}

async function tryRunLocalOpenClawGatewayCommand(args) {
  const runtime = await detectLocalOpenClawRuntime();
  if (!runtime.installed || !runtime.binaryPath) {
    return { ok: false, skipped: true, reason: "openclaw-not-installed" };
  }

  try {
    if (IS_WINDOWS) {
      const command = [`& ${powershellEscape(runtime.binaryPath)}`, ...args.map((item) => powershellEscape(item))].join(" ");
      const result = await runSpawnCapture("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ], {
        env: {
          ...process.env,
          PATH: buildLocalRuntimePath(),
        },
      });
      return { ok: true, ...result };
    }

    const result = await runSpawnCapture(runtime.binaryPath, args, {
      env: {
        ...process.env,
        PATH: buildLocalRuntimePath(),
      },
    });
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "openclaw-command-failed",
    };
  }
}

async function runWindowsScheduledTaskCommand(args) {
  if (!IS_WINDOWS) {
    return { ok: false, skipped: true, reason: "not-windows" };
  }

  try {
    const result = await runSpawnCapture("schtasks.exe", args, {
      env: {
        ...process.env,
        SystemRoot: process.env.SystemRoot || "C:\\Windows",
      },
    });
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "schtasks-failed",
    };
  }
}

async function stopWindowsGatewayScheduledTask() {
  return runWindowsScheduledTaskCommand([
    "/End",
    "/TN",
    WINDOWS_OPENCLAW_GATEWAY_TASK_NAME,
  ]);
}

async function deleteWindowsGatewayScheduledTask() {
  return runWindowsScheduledTaskCommand([
    "/Delete",
    "/TN",
    WINDOWS_OPENCLAW_GATEWAY_TASK_NAME,
    "/F",
  ]);
}

function createLocalBootstrapScriptWindows(payload) {
  const {
    apiKey,
    providerId,
    baseUrl,
    modelId,
    allowedModelIds = [],
    localDeviceId = "",
    localDeviceLabel = "",
    gatewayPort,
    gatewayBind,
    gatewayToken,
    browserControlPort,
    runtimePackages = [],
  } = payload;

  const runtimePackagesByArch = new Map(
    Array.isArray(runtimePackages)
      ? runtimePackages
          .filter((item) => item && typeof item === "object" && typeof item.arch === "string")
          .map((item) => [item.arch, item])
      : [],
  );
  const runtimeX64 = runtimePackagesByArch.get("x64") ?? null;
  let effectiveBaseUrl = baseUrl;
  let tunnelHost = "";
  let tunnelEnabled = false;
  const gatewayTunnel =
    payload && typeof payload.gatewayTunnel === "object" ? payload.gatewayTunnel : null;
  const tunnelRequested = Boolean(
    gatewayTunnel &&
      (typeof gatewayTunnel.host === "string" ||
        typeof gatewayTunnel.privateKey === "string" ||
        gatewayTunnel.localPort ||
        gatewayTunnel.remotePort),
  );
  const gatewayTunnelUser =
    typeof gatewayTunnel?.user === "string" && gatewayTunnel.user.trim()
      ? gatewayTunnel.user.trim()
      : "root";
  const gatewayTunnelLocalPort = Number(
    gatewayTunnel?.localPort || LOCAL_GATEWAY_TUNNEL_PORT,
  );
  const gatewayTunnelRemotePort = Number(
    gatewayTunnel?.remotePort || LOCAL_GATEWAY_TUNNEL_REMOTE_PORT,
  );
  const gatewayTunnelPrivateKey =
    typeof gatewayTunnel?.privateKey === "string" ? gatewayTunnel.privateKey.trim() : "";

  try {
    const parsedBaseUrl = new URL(baseUrl);
    const isLoopbackHost =
      parsedBaseUrl.hostname === "127.0.0.1" ||
      parsedBaseUrl.hostname === "localhost" ||
      parsedBaseUrl.hostname === "::1";
    if (!isLoopbackHost && tunnelRequested && fs.existsSync(LOCAL_GATEWAY_TUNNEL_KEY_PATH)) {
      tunnelEnabled = true;
      tunnelHost = parsedBaseUrl.hostname;
      effectiveBaseUrl = `http://127.0.0.1:${String(gatewayTunnelLocalPort)}${parsedBaseUrl.pathname.replace(/\/$/, "") || ""}`;
    } else if (!isLoopbackHost && tunnelRequested && gatewayTunnelPrivateKey) {
      tunnelEnabled = true;
      tunnelHost =
        typeof gatewayTunnel?.host === "string" && gatewayTunnel.host.trim()
          ? gatewayTunnel.host.trim()
          : parsedBaseUrl.hostname;
      effectiveBaseUrl = `http://127.0.0.1:${String(gatewayTunnelLocalPort)}${parsedBaseUrl.pathname.replace(/\/$/, "") || ""}`;
    }
  } catch {
    effectiveBaseUrl = baseUrl;
  }
  const localWorkspaceDir = LOCAL_OPENCLAW_WORKSPACE_DIR;
  const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaolanbu-local-"));
  const launcherPath = path.join(launcherDir, "bootstrap-local-openclaw.ps1");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$env:PATH = ${powershellEscape(buildLocalRuntimePath())} + ';' + $env:PATH
$env:OPENCLAW_API_KEY = ${powershellEscape(apiKey)}
$env:OPENCLAW_STATE_DIR = ${powershellEscape(LOCAL_OPENCLAW_STATE_DIR)}
$env:OPENCLAW_CONFIG_PATH = ${powershellEscape(LOCAL_OPENCLAW_CONFIG_PATH)}
$env:XLB_LOCAL_AGENT_DIR = ${powershellEscape(LOCAL_OPENCLAW_AGENT_DIR)}
$env:XLB_LOCAL_WORKSPACE_DIR = ${powershellEscape(localWorkspaceDir)}
$env:XLB_LEGACY_STATE_DIR = ${powershellEscape(LEGACY_LOCAL_OPENCLAW_STATE_DIR)}
$env:XLB_LEGACY_PROFILE_STATE_DIR = ${powershellEscape(LEGACY_LOCAL_PROFILE_STATE_DIR)}
$env:XLB_OPENCLAW_ROOT = ${powershellEscape(LOCAL_MANAGED_RUNTIME_ROOT)}
$env:XLB_NODE_ROOT = ${powershellEscape(LOCAL_MANAGED_NODE_ROOT)}
$env:XLB_NODE_CURRENT = ${powershellEscape(LOCAL_MANAGED_NODE_CURRENT)}
$env:XLB_NODE_VERSION = ${powershellEscape(LOCAL_MANAGED_NODE_VERSION)}
$env:XLB_NPM_PREFIX = ${powershellEscape(LOCAL_MANAGED_NPM_PREFIX)}
$env:XLB_MANAGED_BIN_DIR = ${powershellEscape(LOCAL_MANAGED_WRAPPER_BIN_DIR)}
$env:XLB_MANAGED_OPENCLAW_BIN = ${powershellEscape(LOCAL_MANAGED_CLAW_BIN)}
$env:XLB_MANAGED_NODE_BIN = ${powershellEscape(LOCAL_MANAGED_NODE_BIN)}
$env:XLB_MANAGED_NPM_BIN = ${powershellEscape(LOCAL_MANAGED_NPM_BIN)}
$env:XLB_GATEWAY_BASE_URL = ${powershellEscape(effectiveBaseUrl)}
$env:XLB_GATEWAY_TUNNEL_ENABLED = ${powershellEscape(tunnelEnabled ? "1" : "0")}
$env:XLB_GATEWAY_TUNNEL_HOST = ${powershellEscape(tunnelHost)}
$env:XLB_GATEWAY_TUNNEL_USER = ${powershellEscape(gatewayTunnelUser)}
$env:XLB_GATEWAY_TUNNEL_LOCAL_PORT = ${powershellEscape(String(gatewayTunnelLocalPort))}
$env:XLB_GATEWAY_TUNNEL_REMOTE_PORT = ${powershellEscape(String(gatewayTunnelRemotePort))}
$env:XLB_GATEWAY_TUNNEL_KEY = ${powershellEscape(LOCAL_GATEWAY_TUNNEL_KEY_PATH)}
$env:XLB_GATEWAY_TUNNEL_PRIVATE_KEY_B64 = ${powershellEscape(
    gatewayTunnelPrivateKey ? Buffer.from(gatewayTunnelPrivateKey, "utf8").toString("base64") : "",
  )}
$env:XLB_RUNTIME_X64_URL = ${powershellEscape(runtimeX64?.downloadUrl ?? "")}
$env:XLB_RUNTIME_X64_SHA256 = ${powershellEscape(runtimeX64?.sha256 ?? "")}
$env:XLB_LOCAL_SESSIONS_DIR = ${powershellEscape(path.join(LOCAL_OPENCLAW_STATE_DIR, "agents", "main", "sessions"))}
$env:XLB_LOCAL_BINDING_STATE_PATH = ${powershellEscape(LOCAL_BINDING_STATE_PATH)}
$env:XLB_LOCAL_WORKSPACE_ID = ${powershellEscape(
    typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "",
  )}
$env:XLB_LOCAL_DEPLOYMENT_ID = ${powershellEscape(
    typeof payload.deploymentId === "string" ? payload.deploymentId.trim() : "",
  )}
$env:XLB_LOCAL_DEVICE_ID = ${powershellEscape(localDeviceId)}
$env:XLB_LOCAL_DEVICE_LABEL = ${powershellEscape(localDeviceLabel)}
$env:XLB_LOCAL_BOOTSTRAP_LOG = ${powershellEscape(LOCAL_BOOTSTRAP_LOG)}

function Write-Log([string]$Message) {
  $line = "[xiaolanbu-local] $Message"
  Write-Output $line
  Add-Content -Path $env:XLB_LOCAL_BOOTSTRAP_LOG -Value $line -Encoding UTF8
}

function Ensure-Dir([string]$TargetPath) {
  New-Item -ItemType Directory -Force -Path $TargetPath | Out-Null
}

function Copy-DirectoryContents([string]$SourcePath, [string]$DestinationPath) {
  Ensure-Dir $DestinationPath
  $entries = Get-ChildItem -LiteralPath $SourcePath -Force -ErrorAction SilentlyContinue
  foreach ($entry in $entries) {
    Copy-Item -LiteralPath $entry.FullName -Destination $DestinationPath -Recurse -Force
  }
}

function Write-Utf8File([string]$TargetPath, [string]$Content) {
  $directory = [System.IO.Path]::GetDirectoryName($TargetPath)
  if ($directory) {
    Ensure-Dir $directory
  }
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($TargetPath, $Content, $encoding)
}

function Format-ByteSize([int64]$Bytes) {
  if ($Bytes -lt 1KB) { return "$Bytes B" }
  if ($Bytes -lt 1MB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
  if ($Bytes -lt 1GB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  return ('{0:N2} GB' -f ($Bytes / 1GB))
}

function Format-ByteRate([double]$BytesPerSecond) {
  if ($BytesPerSecond -lt 1KB) { return ('{0:N0} B/s' -f $BytesPerSecond) }
  if ($BytesPerSecond -lt 1MB) { return ('{0:N1} KB/s' -f ($BytesPerSecond / 1KB)) }
  if ($BytesPerSecond -lt 1GB) { return ('{0:N1} MB/s' -f ($BytesPerSecond / 1MB)) }
  return ('{0:N2} GB/s' -f ($BytesPerSecond / 1GB))
}

function Test-NodeSatisfiesMinimum([string]$NodePath) {
  if (-not (Test-Path $NodePath)) {
    return $false
  }

  try {
    $version = (& $NodePath -p "process.versions.node" 2>$null)
    if (-not $version) {
      return $false
    }
    return ([version]($version.Trim()) -ge [version]'22.16.0')
  } catch {
    return $false
  }
}

function Download-File([string]$Url, [string]$OutputPath) {
  Add-Type -AssemblyName System.Net.Http

  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $true
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(30)

  try {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
    $response = $client.SendAsync(
      $request,
      [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
    ).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode()

    $directory = [System.IO.Path]::GetDirectoryName($OutputPath)
    if ($directory) {
      Ensure-Dir $directory
    }

    $contentStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $fileStream = [System.IO.File]::Open(
      $OutputPath,
      [System.IO.FileMode]::Create,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )

    try {
      $totalBytes = if ($response.Content.Headers.ContentLength.HasValue) {
        [int64]$response.Content.Headers.ContentLength.Value
      } else {
        [int64]0
      }
      $downloadedBytes = [int64]0
      $lastLoggedPercent = -5
      $lastLoggedBytes = [int64]0
      $logByteStep = 10MB
      $buffer = New-Object byte[] 65536
      $downloadStopwatch = [System.Diagnostics.Stopwatch]::StartNew()

      while (($read = $contentStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $fileStream.Write($buffer, 0, $read)
        $downloadedBytes += $read
        $elapsedSeconds = [Math]::Max($downloadStopwatch.Elapsed.TotalSeconds, 1.0)
        $byteRate = $downloadedBytes / $elapsedSeconds
        $formattedRate = Format-ByteRate $byteRate

        if ($totalBytes -gt 0) {
          $percent = [Math]::Min(100, [int][Math]::Floor(($downloadedBytes * 100.0) / $totalBytes))
          if ($percent -ge ($lastLoggedPercent + 5)) {
            Write-Log ("runtime bundle download progress {0}% ({1} / {2} @ {3})" -f $percent, (Format-ByteSize $downloadedBytes), (Format-ByteSize $totalBytes), $formattedRate)
            $lastLoggedPercent = $percent
          }
        } elseif (($downloadedBytes - $lastLoggedBytes) -ge $logByteStep) {
          Write-Log ("runtime bundle download progress {0} downloaded @ {1}" -f (Format-ByteSize $downloadedBytes), $formattedRate)
          $lastLoggedBytes = $downloadedBytes
        }
      }

      $elapsedSeconds = [Math]::Max($downloadStopwatch.Elapsed.TotalSeconds, 1.0)
      $byteRate = $downloadedBytes / $elapsedSeconds
      $formattedRate = Format-ByteRate $byteRate
      if ($totalBytes -gt 0 -and $lastLoggedPercent -lt 100) {
        Write-Log ("runtime bundle download progress 100% ({0} / {1} @ {2})" -f (Format-ByteSize $downloadedBytes), (Format-ByteSize $totalBytes), $formattedRate)
      } elseif ($totalBytes -le 0 -and $downloadedBytes -gt $lastLoggedBytes) {
        Write-Log ("runtime bundle download progress {0} downloaded @ {1}" -f (Format-ByteSize $downloadedBytes), $formattedRate)
      }
    } finally {
      $fileStream.Dispose()
      $contentStream.Dispose()
      $response.Dispose()
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Test-Url([string]$Url) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source '--head' '--silent' '--show-error' '--location' '--max-time' '6' $Url | Out-Null
    return ($LASTEXITCODE -eq 0)
  }

  try {
    Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 6 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-ListeningPids([int]$Port) {
  try {
    $output = & netstat.exe -ano -p tcp
    $portSuffix = ':' + [string]$Port
    return @(
      $output -split [System.Environment]::NewLine |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -like 'TCP*' } |
        ForEach-Object { ($_ -split '\s+') } |
        Where-Object { $_.Length -ge 5 -and $_[1].EndsWith($portSuffix) -and $_[3].ToUpperInvariant() -eq 'LISTENING' } |
        ForEach-Object { [int]$_[4] }
    )
  } catch {
    return @()
  }
}

function Stop-ListeningProcesses([int]$Port) {
  $pids = Get-ListeningPids $Port | Select-Object -Unique
  foreach ($pid in $pids) {
    try {
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    } catch {
      # Ignore already-exited processes.
    }
  }
  return @($pids)
}

function Resolve-SshClientPath {
  $command = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
  $candidates = @(
    (Join-Path $systemRoot 'System32\OpenSSH\ssh.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return ''
}

function Ensure-GatewayTunnel {
  if ($env:XLB_GATEWAY_TUNNEL_ENABLED -eq '1') {
    Write-Log 'gateway tunnel is managed by Xiaolanbu desktop helper'
  }
}

function Verify-Sha256([string]$Expected, [string]$TargetPath) {
  if (-not $Expected) {
    return $true
  }

  $hash = (Get-FileHash -Path $TargetPath -Algorithm SHA256).Hash
  return $hash.Trim().ToLowerInvariant() -eq $Expected.Trim().ToLowerInvariant()
}

function Expand-ZipArchive([string]$ArchivePath, [string]$DestinationPath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $DestinationPath)
}

function Resolve-RuntimeRoot([string]$SearchRoot) {
  $directCandidates = @(
    $SearchRoot
    Get-ChildItem -Path $SearchRoot -Directory | Select-Object -ExpandProperty FullName
  ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'bin\\openclaw.cmd')) }

  if ($directCandidates) {
    return $directCandidates | Select-Object -First 1
  }

  $entry = Get-ChildItem -Path $SearchRoot -Recurse -File -Filter 'openclaw.cmd' -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory -and $_.Directory.Name -ieq 'bin' } |
    Select-Object -First 1
  if (-not $entry) {
    return $null
  }

  return $entry.Directory.Parent.FullName
}

function Install-RuntimeBundle {
  $bundledOpenClaw = Join-Path $env:XLB_OPENCLAW_ROOT 'bin\\openclaw.cmd'
  if (Test-Path $bundledOpenClaw) {
    Write-Log 'reusing existing Xiaolanbu runtime bundle'
    return $true
  }

  if (-not $env:XLB_RUNTIME_X64_URL) {
    return $false
  }

  if (-not $env:XLB_RUNTIME_X64_URL.ToLowerInvariant().EndsWith('.zip')) {
    Write-Log 'windows runtime bundle is not a zip archive, skipping bundled runtime'
    return $false
  }

  $tmpDir = Join-Path $env:TEMP ('xiaolanbu-runtime-' + [guid]::NewGuid().ToString('N'))
  $archivePath = Join-Path $tmpDir 'runtime.zip'
  $extractDir = Join-Path $tmpDir 'extract'
  Ensure-Dir $tmpDir
  Ensure-Dir $extractDir
  Write-Log 'downloading Xiaolanbu runtime bundle'
  Download-File $env:XLB_RUNTIME_X64_URL $archivePath
  if (-not (Verify-Sha256 $env:XLB_RUNTIME_X64_SHA256 $archivePath)) {
    Write-Log 'runtime bundle checksum mismatch'
    Remove-Item -Recurse -Force $tmpDir
    return $false
  }

  Expand-ZipArchive $archivePath $extractDir
  $extractedRoot = Resolve-RuntimeRoot $extractDir
  if (-not (Test-Path (Join-Path $extractedRoot 'bin\\openclaw.cmd'))) {
    Write-Log 'runtime bundle is missing bin/openclaw.cmd'
    Remove-Item -Recurse -Force $tmpDir
    return $false
  }

  Write-Log ("resolved runtime bundle root " + $extractedRoot)

  if (Test-Path $env:XLB_OPENCLAW_ROOT) {
    Remove-Item -Recurse -Force $env:XLB_OPENCLAW_ROOT
  }
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($env:XLB_OPENCLAW_ROOT))
  Move-Item -Path $extractedRoot -Destination $env:XLB_OPENCLAW_ROOT
  Remove-Item -Recurse -Force $tmpDir
  Write-Log ("installed Xiaolanbu runtime bundle into " + $env:XLB_OPENCLAW_ROOT)
  return $true
}

function Install-ManagedNode {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -notin @('AMD64', 'x86_64')) {
    throw "unsupported Windows architecture: $arch"
  }

  $versionTag = 'v' + $env:XLB_NODE_VERSION
  $zipName = "node-$versionTag-win-x64.zip"
  $downloadUrl = "https://nodejs.org/dist/$versionTag/$zipName"
  $tmpDir = Join-Path $env:TEMP ('xiaolanbu-node-' + [guid]::NewGuid().ToString('N'))
  $archivePath = Join-Path $tmpDir 'node.zip'
  Ensure-Dir $tmpDir
  Write-Log ("installing managed Node.js " + $versionTag + " (x64)")
  Download-File $downloadUrl $archivePath
  Expand-ZipArchive $archivePath $tmpDir
  $extractedDir = Get-ChildItem -Path $tmpDir -Directory | Where-Object { $_.Name -like 'node-*' } | Select-Object -First 1
  if (-not $extractedDir) {
    throw 'failed to extract managed Node.js'
  }
  if (Test-Path $env:XLB_NODE_CURRENT) {
    Remove-Item -Recurse -Force $env:XLB_NODE_CURRENT
  }
  Ensure-Dir $env:XLB_NODE_ROOT
  Move-Item -Path $extractedDir.FullName -Destination $env:XLB_NODE_CURRENT
  Remove-Item -Recurse -Force $tmpDir
}

function Write-ManagedOpenClawWrapper {
  $moduleEntry = Join-Path $env:XLB_NPM_PREFIX 'node_modules\\openclaw\\openclaw.mjs'
  if (-not (Test-Path $moduleEntry)) {
    $moduleEntry = Join-Path $env:XLB_NPM_PREFIX 'lib\\node_modules\\openclaw\\openclaw.mjs'
  }
  if (-not (Test-Path $moduleEntry)) {
    throw "managed OpenClaw entry missing at $moduleEntry"
  }

  Ensure-Dir $env:XLB_MANAGED_BIN_DIR
  $wrapper = @"
@echo off
set "PATH=$env:XLB_MANAGED_BIN_DIR;$env:XLB_NPM_PREFIX;$env:XLB_NODE_CURRENT;%PATH%"
"$env:XLB_MANAGED_NODE_BIN" "$moduleEntry" %*
"@
  Set-Content -Path $env:XLB_MANAGED_OPENCLAW_BIN -Value $wrapper -Encoding Ascii
}

function Ensure-NodeRuntime {
  if (Test-NodeSatisfiesMinimum $env:XLB_MANAGED_NODE_BIN) {
    Write-Log ("using cached managed Node.js " + (& $env:XLB_MANAGED_NODE_BIN -p "process.versions.node"))
    return
  }

  Install-ManagedNode
}

function Test-MainlandFriendlyNetwork {
  if ($env:XLB_FORCE_MAINLAND_NETWORK -eq '1') {
    return $true
  }

  $githubOk = Test-Url 'https://github.com'
  $rawOk = Test-Url 'https://raw.githubusercontent.com'
  $npmmirrorOk = Test-Url 'https://registry.npmmirror.com/openclaw'
  $baiduOk = Test-Url 'https://www.baidu.com'

  return ($npmmirrorOk -and $baiduOk -and (-not $githubOk -or -not $rawOk))
}

function Install-OpenClawWithManagedNpm {
  Ensure-NodeRuntime
  $env:PATH = "$env:XLB_MANAGED_BIN_DIR;$env:XLB_NPM_PREFIX;$env:XLB_NODE_CURRENT;$env:PATH"
  $env:NPM_CONFIG_PREFIX = $env:XLB_NPM_PREFIX
  $env:npm_config_prefix = $env:XLB_NPM_PREFIX
  $env:npm_config_update_notifier = 'false'
  $env:npm_config_fund = 'false'
  $env:npm_config_audit = 'false'
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  if (Test-MainlandFriendlyNetwork) {
    $env:NPM_CONFIG_REGISTRY = 'https://registry.npmmirror.com'
    Write-Log ("using npm mirror: " + $env:NPM_CONFIG_REGISTRY)
  } else {
    $env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org'
  }
  $env:npm_config_registry = $env:NPM_CONFIG_REGISTRY
  Write-Log 'installing OpenClaw from npm'
  & $env:XLB_MANAGED_NPM_BIN install -g --force openclaw@latest
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
  }
  Write-ManagedOpenClawWrapper
}

function Resolve-OpenClawBin {
  if (Test-Path $env:XLB_MANAGED_OPENCLAW_BIN) {
    return $env:XLB_MANAGED_OPENCLAW_BIN
  }

  $command = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return ''
}

function Install-OpenClawRuntime {
  if (Install-RuntimeBundle) {
    $existing = Resolve-OpenClawBin
    if ($existing) {
      Write-Log 'using packaged Xiaolanbu runtime'
      return
    }
    Write-Log 'runtime bundle installed but openclaw is still unavailable, falling back'
  }

  $existing = Resolve-OpenClawBin
  if ($existing) {
    Write-Log ("using existing OpenClaw at " + $existing)
    return
  }

  Install-OpenClawWithManagedNpm
}

function Test-LocalPortOpen([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $asyncResult = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne(600)) {
      return $false
    }
    $client.EndConnect($asyncResult) | Out-Null
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

Ensure-Dir ${powershellEscape(LOCAL_LOG_DIR)}

if ((Test-Path $env:XLB_LEGACY_STATE_DIR) -and -not (Test-Path $env:OPENCLAW_STATE_DIR)) {
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($env:OPENCLAW_STATE_DIR))
  Copy-DirectoryContents $env:XLB_LEGACY_STATE_DIR $env:OPENCLAW_STATE_DIR
  Write-Log ("migrated legacy state dir " + $env:XLB_LEGACY_STATE_DIR + " -> " + $env:OPENCLAW_STATE_DIR)
}

if ((Test-Path $env:XLB_LEGACY_PROFILE_STATE_DIR) -and -not (Test-Path $env:OPENCLAW_STATE_DIR)) {
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($env:OPENCLAW_STATE_DIR))
  Copy-DirectoryContents $env:XLB_LEGACY_PROFILE_STATE_DIR $env:OPENCLAW_STATE_DIR
  Write-Log ("migrated legacy profile state dir " + $env:XLB_LEGACY_PROFILE_STATE_DIR + " -> " + $env:OPENCLAW_STATE_DIR)
}

Ensure-Dir $env:OPENCLAW_STATE_DIR
Ensure-Dir $env:XLB_LOCAL_WORKSPACE_DIR
Ensure-Dir $env:XLB_LOCAL_AGENT_DIR
Write-Log ("bootstrap started at " + (Get-Date).ToString('o'))

Install-OpenClawRuntime

$openclawBin = Resolve-OpenClawBin
if (-not $openclawBin) {
  throw 'openclaw installation did not expose binary on PATH'
}

Write-Log ("using openclaw at " + $openclawBin)
Ensure-GatewayTunnel

Ensure-Dir $env:XLB_LOCAL_SESSIONS_DIR

Write-Log 'running onboard'
$onboardArgs = @(
  'onboard',
  '--non-interactive',
  '--accept-risk',
  '--mode',
  'local',
  '--auth-choice',
  'custom-api-key',
  '--custom-provider-id',
  ${powershellEscape(providerId)},
  '--custom-base-url',
  $env:XLB_GATEWAY_BASE_URL,
  '--custom-model-id',
  ${powershellEscape(modelId)},
  '--custom-compatibility',
  'openai',
  '--gateway-port',
  '${String(gatewayPort)}',
  '--gateway-bind',
  ${powershellEscape(gatewayBind)},
  '--gateway-auth',
  'token',
  '--gateway-token',
  ${powershellEscape(gatewayToken)},
  '--install-daemon',
  '--skip-ui',
  '--workspace',
  $env:XLB_LOCAL_WORKSPACE_DIR
)
& $openclawBin @onboardArgs

if ($LASTEXITCODE -ne 0) {
  throw "openclaw onboard failed with exit code $LASTEXITCODE"
}

Ensure-Dir ([System.IO.Path]::GetDirectoryName($env:XLB_LOCAL_BINDING_STATE_PATH))
$bindingState = @{
  workspaceId = $env:XLB_LOCAL_WORKSPACE_ID
  deploymentId = $env:XLB_LOCAL_DEPLOYMENT_ID
  localDeviceId = $env:XLB_LOCAL_DEVICE_ID
  localDeviceLabel = $env:XLB_LOCAL_DEVICE_LABEL
  localPlatform = ${powershellEscape(process.platform)}
  providerId = ${powershellEscape(providerId)}
  managedProviderIds = @(${powershellEscape(providerId)})
  managedProfileIds = @(${powershellEscape(`${providerId}:default`)})
  baseUrl = $env:XLB_GATEWAY_BASE_URL
  updatedAt = (Get-Date).ToString('o')
} | ConvertTo-Json
Set-Content -Path $env:XLB_LOCAL_BINDING_STATE_PATH -Value $bindingState -Encoding UTF8
Write-Log 'binding state updated'

if ((Test-Path $env:XLB_MANAGED_NODE_BIN) -and (Test-Path $env:OPENCLAW_CONFIG_PATH)) {
  try {
@'
const fs = require("fs");
const path = require("path");
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const agentDir = process.env.XLB_LOCAL_AGENT_DIR;
const workspaceDir = process.env.XLB_LOCAL_WORKSPACE_DIR;
const apiKey = process.env.OPENCLAW_API_KEY;
const bindingStatePath = process.env.XLB_LOCAL_BINDING_STATE_PATH;
const workspaceId = process.env.XLB_LOCAL_WORKSPACE_ID || "";
const deploymentId = process.env.XLB_LOCAL_DEPLOYMENT_ID || "";
const localDeviceId = process.env.XLB_LOCAL_DEVICE_ID || "";
const localDeviceLabel = process.env.XLB_LOCAL_DEVICE_LABEL || "";
const providerId = ${JSON.stringify(providerId)};
const modelId = ${JSON.stringify(modelId)};
const managedAllowedModelIds = ${JSON.stringify(
    Array.isArray(allowedModelIds)
      ? allowedModelIds
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => value.trim())
      : [],
  )};
const targetBaseUrl = process.env.XLB_GATEWAY_BASE_URL || ${JSON.stringify(baseUrl)};
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const resolveCompatForModel = (value) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const compat = {
    supportsUsageInStreaming: false,
  };
  if (!normalized) {
    return compat;
  }
  if (normalized.startsWith("qwen")) {
    compat.supportsStrictMode = false;
    compat.thinkingFormat = "qwen";
    return compat;
  }
  if (normalized.startsWith("glm")) {
    compat.thinkingFormat = "zai";
    return compat;
  }
  if (
    normalized.startsWith("gpt-") ||
    normalized === "gpt-4o" ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    compat.thinkingFormat = "openai";
    return compat;
  }
  return compat;
};
const collectManagedModelIds = (providers, preferredProviderId) => {
  const values = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    values.push(normalized);
  };
  if (Array.isArray(managedAllowedModelIds)) {
    managedAllowedModelIds.forEach(push);
  }
  push(modelId);
  const providerOrder = [];
  if (typeof preferredProviderId === "string" && preferredProviderId.trim()) {
    providerOrder.push(preferredProviderId.trim());
  }
  for (const providerName of providerOrder) {
    const providerConfig = isRecord(providers?.[providerName]) ? providers[providerName] : {};
    const providerModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    for (const item of providerModels) {
      if (item && typeof item === "object") {
        push(item.id);
      }
    }
  }
  return values;
};
const applyCompatForModel = (target, value) => {
  if (!isRecord(target)) {
    return;
  }
  const nextCompat = resolveCompatForModel(value);
  target.compat = isRecord(target.compat) ? target.compat : {};
  target.compat.supportsUsageInStreaming = nextCompat.supportsUsageInStreaming;
  if (Object.prototype.hasOwnProperty.call(nextCompat, "supportsStrictMode")) {
    target.compat.supportsStrictMode = nextCompat.supportsStrictMode;
  } else {
    delete target.compat.supportsStrictMode;
  }
  if (typeof nextCompat.thinkingFormat === "string" && nextCompat.thinkingFormat.trim()) {
    target.compat.thinkingFormat = nextCompat.thinkingFormat;
  } else {
    delete target.compat.thinkingFormat;
  }
};
const readJsonFile = (filePath, fallback) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) {
    return fallback;
  }
  return JSON.parse(raw);
};
const warn = (message, error) => {
  const detail = error && error.stack ? error.stack : error && error.message ? error.message : String(error);
  console.error("[xiaolanbu-local] " + message + ": " + detail);
};
const existingBinding = bindingStatePath ? readJsonFile(bindingStatePath, {}) : {};
const hadManagedOpenAiAlias =
  Boolean(existingBinding) &&
  (
    (Array.isArray(existingBinding.managedProviderIds) && existingBinding.managedProviderIds.includes("openai")) ||
    (Array.isArray(existingBinding.managedProfileIds) && existingBinding.managedProfileIds.includes("openai:default"))
  );
const shouldReplaceManagedOpenAiAlias = hadManagedOpenAiAlias && providerId !== "openai";

if (agentDir && apiKey) {
  try {
  const authStorePath = path.join(agentDir, "auth-profiles.json");
  const existingStore = readJsonFile(authStorePath, {});
  const store = isRecord(existingStore) ? existingStore : {};
  store.version = 1;
  store.profiles = isRecord(store.profiles) ? store.profiles : {};
  store.lastGood = isRecord(store.lastGood) ? store.lastGood : {};
  store.usageStats = isRecord(store.usageStats) ? store.usageStats : {};
  store.profiles[providerId + ":default"] = {
    type: "api_key",
    provider: providerId,
    key: apiKey,
  };
  store.lastGood[providerId] = providerId + ":default";
  if (shouldReplaceManagedOpenAiAlias) {
    delete store.profiles["openai:default"];
    delete store.lastGood.openai;
  }
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(authStorePath, JSON.stringify(store, null, 2) + "\n");
  } catch (error) {
    warn("auth store normalization skipped", error);
  }
}

if (configPath && workspaceDir) {
  try {
    const config = readJsonFile(configPath, {});
    if (!isRecord(config)) {
      throw new Error("openclaw.json is not an object");
    }
    config.models = isRecord(config.models) ? config.models : {};
    const existingProviders = isRecord(config.models.providers) ? config.models.providers : {};
    config.models.providers = {};
    for (const [alias, providerConfig] of Object.entries(existingProviders)) {
      if (
        alias === providerId ||
        alias.startsWith(providerId + ":") ||
        alias.startsWith(providerId + "-") ||
        (
          shouldReplaceManagedOpenAiAlias &&
          (alias === "openai" || alias.startsWith("openai:") || alias.startsWith("openai-"))
        )
      ) {
        continue;
      }
      config.models.providers[alias] = providerConfig;
    }
    const ensureProviderConfig = (id) => {
      const providerConfig = isRecord(config.models.providers[id]) ? config.models.providers[id] : {};
      providerConfig.api = "openai-completions";
      providerConfig.apiKey = apiKey;
      providerConfig.baseUrl = targetBaseUrl;
      const currentModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];
      if (!currentModels.some((model) => model && typeof model === "object" && model.id === modelId)) {
        currentModels.push({
          id: modelId,
          name: modelId + " (Custom Provider)",
          input: ["text", "image"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });
      }
      for (const model of currentModels) {
        if (model && typeof model === "object") {
          if (typeof model.name !== "string" || !model.name.trim()) {
            model.name = String(model.id || modelId) + " (Custom Provider)";
          }
          const nextInput = new Set(
            Array.isArray(model.input)
              ? model.input
                  .map((value) => (typeof value === "string" ? value.trim() : ""))
                  .filter(Boolean)
              : [],
          );
          nextInput.add("text");
          nextInput.add("image");
          model.input = Array.from(nextInput);
          model.cost = isRecord(model.cost) ? model.cost : {};
          model.cost.input = Number(model.cost.input || 0);
          model.cost.output = Number(model.cost.output || 0);
          model.cost.cacheRead = Number(model.cost.cacheRead || 0);
          model.cost.cacheWrite = Number(model.cost.cacheWrite || 0);
          model.contextWindow = Math.max(Number(model.contextWindow || 0), 262144);
          model.maxTokens = Math.max(Number(model.maxTokens || 0), 8192);
          model.reasoning = false;
          applyCompatForModel(model, model.id || modelId);
        }
      }
      providerConfig.models = currentModels;
      config.models.providers[id] = providerConfig;
    };
    ensureProviderConfig(providerId);
    config.agents = isRecord(config.agents) ? config.agents : {};
    config.agents.defaults = isRecord(config.agents.defaults) ? config.agents.defaults : {};
    config.agents.defaults.model = isRecord(config.agents.defaults.model)
      ? config.agents.defaults.model
      : {};
    config.agents.defaults.model.primary = providerId + "/" + modelId;
    const managedModelIds = collectManagedModelIds(config.models.providers, providerId);
    const existingDefaultModels = isRecord(config.agents.defaults.models) ? config.agents.defaults.models : {};
    for (const managedModelId of managedModelIds) {
      const managedModelKey = providerId + "/" + managedModelId;
      existingDefaultModels[managedModelKey] = isRecord(existingDefaultModels[managedModelKey])
        ? existingDefaultModels[managedModelKey]
        : {};
    }
    config.agents.defaults.models = existingDefaultModels;
    config.agents.defaults.model.fallbacks = managedModelIds
      .filter((value) => value !== modelId)
      .map((value) => providerId + "/" + value);
    config.agents.defaults.workspace = workspaceDir;
    delete config.agents.defaults.skipBootstrap;
    delete config.agents.defaults.bootstrapMaxChars;
    delete config.agents.defaults.bootstrapTotalMaxChars;
    const existingAgentList = Array.isArray(config.agents.list) ? config.agents.list : [];
    const mainAgentIndex = existingAgentList.findIndex((entry) => isRecord(entry) && entry.id === "main");
    const mainAgent =
      mainAgentIndex >= 0 && isRecord(existingAgentList[mainAgentIndex])
        ? existingAgentList[mainAgentIndex]
        : { id: "main", default: true };
    mainAgent.id = "main";
    if (typeof mainAgent.default !== "boolean") {
      mainAgent.default = true;
    }
    mainAgent.workspace = workspaceDir;
    if (mainAgentIndex >= 0) {
      existingAgentList[mainAgentIndex] = mainAgent;
      config.agents.list = existingAgentList;
    } else {
      config.agents.list = [mainAgent, ...existingAgentList];
    }
    config.auth = isRecord(config.auth) ? config.auth : {};
    config.auth.profiles = isRecord(config.auth.profiles) ? config.auth.profiles : {};
    config.auth.profiles[providerId + ":default"] = {
      provider: providerId,
      mode: "api_key",
    };
    if (shouldReplaceManagedOpenAiAlias) {
      delete config.auth.profiles["openai:default"];
    }
    config.skills = isRecord(config.skills) ? config.skills : {};
    config.skills.limits = isRecord(config.skills.limits) ? config.skills.limits : {};
    if (
      Array.isArray(config.skills.allowBundled) &&
      config.skills.allowBundled.length === 1 &&
      config.skills.allowBundled[0] === "__xlb_none__"
    ) {
      delete config.skills.allowBundled;
    }
    delete config.skills.limits.maxSkillsInPrompt;
    delete config.skills.limits.maxSkillsPromptChars;
    if (!Object.keys(config.skills.limits).length) {
      delete config.skills.limits;
    }
    if (!Object.keys(config.skills).length) {
      delete config.skills;
    }
    config.gateway = isRecord(config.gateway) ? config.gateway : {};
    config.gateway.http = isRecord(config.gateway.http) ? config.gateway.http : {};
    config.gateway.http.endpoints = isRecord(config.gateway.http.endpoints)
      ? config.gateway.http.endpoints
      : {};
    config.gateway.http.endpoints.responses = isRecord(config.gateway.http.endpoints.responses)
      ? config.gateway.http.endpoints.responses
      : {};
    config.gateway.http.endpoints.responses.enabled = true;
    config.tools = isRecord(config.tools) ? config.tools : {};
    if (typeof config.tools.profile !== "string" || !config.tools.profile.trim()) {
      config.tools.profile = "coding";
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  } catch (error) {
    warn("config normalization skipped", error);
  }
}

if (bindingStatePath) {
  fs.mkdirSync(path.dirname(bindingStatePath), { recursive: true });
  fs.writeFileSync(
    bindingStatePath,
    JSON.stringify(
      {
        workspaceId,
        deploymentId,
        localDeviceId,
        localDeviceLabel,
        localPlatform: process.platform,
        providerId,
        managedProviderIds: ${JSON.stringify([providerId])},
        managedProfileIds: ${JSON.stringify([`${providerId}:default`])},
        baseUrl: targetBaseUrl,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

if (workspaceDir) {
  fs.mkdirSync(workspaceDir, { recursive: true });
}
'@ | & $env:XLB_MANAGED_NODE_BIN

    if ($LASTEXITCODE -ne 0) {
      throw "failed to normalize OpenClaw config with managed Node.js"
    }
    Write-Log 'updated OpenClaw auth/config state'
  } catch {
    Write-Log ("warning: config normalization skipped: " + $_.Exception.Message)
  }
}

Write-Log 'restarting local gateway service'
try {
  schtasks.exe /Run /TN ${powershellEscape(WINDOWS_OPENCLAW_GATEWAY_TASK_NAME)} | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "scheduled task run failed with exit code $LASTEXITCODE"
  }
  Write-Log 'scheduled task launch requested'
} catch {
  $gatewayScriptPath = Join-Path $env:OPENCLAW_STATE_DIR 'gateway.cmd'
  Write-Log ("scheduled task launch failed, falling back to gateway.cmd: " + $_.Exception.Message)
  if (-not (Test-Path $gatewayScriptPath)) {
    throw "gateway launcher missing at $gatewayScriptPath"
  }
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $gatewayScriptPath -WindowStyle Hidden
  Write-Log 'gateway.cmd launch requested'
}

Write-Log 'waiting for ports ${String(gatewayPort)} and ${String(browserControlPort)}'
for ($i = 0; $i -lt 45; $i++) {
  if ((Test-LocalPortOpen ${String(gatewayPort)}) -and (Test-LocalPortOpen ${String(browserControlPort)})) {
    Write-Log 'local gateway is ready'
    Write-Log ('bootstrap finished at ' + (Get-Date).ToString('o'))
    exit 0
  }
  Start-Sleep -Seconds 2
}

throw 'local gateway did not become ready in time'
`;

  fs.writeFileSync(launcherPath, script, "utf8");
  return launcherPath;
}

function createLocalBootstrapScript(payload) {
  syncLegacyGatewayTunnelKey();
  if (IS_WINDOWS) {
    return createLocalBootstrapScriptWindows(payload);
  }
  const {
    apiKey,
    providerId,
    baseUrl,
    modelId,
    allowedModelIds = [],
    localDeviceId = "",
    localDeviceLabel = "",
    gatewayPort,
    gatewayBind,
    gatewayToken,
    browserControlPort,
    runtimePackages = [],
  } = payload;

  const runtimePackagesByArch = new Map(
    Array.isArray(runtimePackages)
      ? runtimePackages
          .filter((item) => item && typeof item === "object" && typeof item.arch === "string")
          .map((item) => [item.arch, item])
      : [],
  );
  const runtimeArm64 = runtimePackagesByArch.get("arm64") ?? null;
  const runtimeX64 = runtimePackagesByArch.get("x64") ?? null;
  let effectiveBaseUrl = baseUrl;
  let tunnelHost = "";
  let tunnelEnabled = false;
  const gatewayTunnel =
    payload && typeof payload.gatewayTunnel === "object" ? payload.gatewayTunnel : null;
  const tunnelRequested = Boolean(
    gatewayTunnel &&
      (typeof gatewayTunnel.host === "string" ||
        typeof gatewayTunnel.privateKey === "string" ||
        gatewayTunnel.localPort ||
        gatewayTunnel.remotePort),
  );
  const gatewayTunnelUser =
    typeof gatewayTunnel?.user === "string" && gatewayTunnel.user.trim()
      ? gatewayTunnel.user.trim()
      : "root";
  const gatewayTunnelLocalPort = Number(
    gatewayTunnel?.localPort || LOCAL_GATEWAY_TUNNEL_PORT,
  );
  const gatewayTunnelRemotePort = Number(
    gatewayTunnel?.remotePort || LOCAL_GATEWAY_TUNNEL_REMOTE_PORT,
  );
  const gatewayTunnelPrivateKey =
    typeof gatewayTunnel?.privateKey === "string" ? gatewayTunnel.privateKey.trim() : "";

  try {
    const parsedBaseUrl = new URL(baseUrl);
    const isLoopbackHost =
      parsedBaseUrl.hostname === "127.0.0.1" ||
      parsedBaseUrl.hostname === "localhost" ||
      parsedBaseUrl.hostname === "::1";
    if (!isLoopbackHost && tunnelRequested && fs.existsSync(LOCAL_GATEWAY_TUNNEL_KEY_PATH)) {
      tunnelEnabled = true;
      tunnelHost = parsedBaseUrl.hostname;
      effectiveBaseUrl = `http://127.0.0.1:${String(gatewayTunnelLocalPort)}${parsedBaseUrl.pathname.replace(/\/$/, "") || ""}`;
    } else if (!isLoopbackHost && tunnelRequested && gatewayTunnelPrivateKey) {
      tunnelEnabled = true;
      tunnelHost = typeof gatewayTunnel?.host === "string" && gatewayTunnel.host.trim()
        ? gatewayTunnel.host.trim()
        : parsedBaseUrl.hostname;
      effectiveBaseUrl = `http://127.0.0.1:${String(gatewayTunnelLocalPort)}${parsedBaseUrl.pathname.replace(/\/$/, "") || ""}`;
    }
  } catch {
    effectiveBaseUrl = baseUrl;
  }

  ensureDirectory(LOCAL_LOG_DIR);
  const localWorkspaceDir = LOCAL_OPENCLAW_WORKSPACE_DIR;

  const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaolanbu-local-"));
  const launcherPath = path.join(launcherDir, "bootstrap-local-openclaw.sh");
const script = `#!/bin/bash
set -euo pipefail
exec > >(tee -a ${shellEscape(LOCAL_BOOTSTRAP_LOG)}) 2>&1

export PATH="${getShellScriptRuntimePathExpression()}"
export HOME=${shellEscape(os.homedir())}
export USER=${shellEscape(os.userInfo().username)}
export LOGNAME=${shellEscape(os.userInfo().username)}
export OPENCLAW_API_KEY=${shellEscape(apiKey)}
export OPENCLAW_STATE_DIR=${shellEscape(LOCAL_OPENCLAW_STATE_DIR)}
export OPENCLAW_CONFIG_PATH=${shellEscape(LOCAL_OPENCLAW_CONFIG_PATH)}
export XLB_LOCAL_AGENT_DIR=${shellEscape(LOCAL_OPENCLAW_AGENT_DIR)}
export XLB_LOCAL_WORKSPACE_DIR=${shellEscape(localWorkspaceDir)}
export XLB_LEGACY_STATE_DIR=${shellEscape(LEGACY_LOCAL_OPENCLAW_STATE_DIR)}
export XLB_LEGACY_PROFILE_STATE_DIR=${shellEscape(LEGACY_LOCAL_PROFILE_STATE_DIR)}
export XLB_OPENCLAW_ROOT=${shellEscape(LOCAL_MANAGED_RUNTIME_ROOT)}
export XLB_NODE_ROOT=${shellEscape(LOCAL_MANAGED_NODE_ROOT)}
export XLB_NODE_VERSION=${shellEscape(LOCAL_MANAGED_NODE_VERSION)}
export XLB_NPM_PREFIX=${shellEscape(LOCAL_MANAGED_NPM_PREFIX)}
export XLB_MANAGED_BIN_DIR=${shellEscape(LOCAL_MANAGED_WRAPPER_BIN_DIR)}
export XLB_MANAGED_CLAW_BIN=${shellEscape(LOCAL_MANAGED_CLAW_BIN)}
export XLB_MANAGED_OPENCLAW_BIN=${shellEscape(LOCAL_MANAGED_CLAW_BIN)}
export XLB_MANAGED_NODE_BIN=${shellEscape(LOCAL_MANAGED_NODE_BIN)}
export XLB_MANAGED_NPM_BIN=${shellEscape(LOCAL_MANAGED_NPM_BIN)}
export XLB_RUNTIME_ARM64_URL=${shellEscape(runtimeArm64?.downloadUrl ?? "")}
export XLB_RUNTIME_ARM64_SHA256=${shellEscape(runtimeArm64?.sha256 ?? "")}
export XLB_RUNTIME_X64_URL=${shellEscape(runtimeX64?.downloadUrl ?? "")}
export XLB_RUNTIME_X64_SHA256=${shellEscape(runtimeX64?.sha256 ?? "")}
export XLB_GATEWAY_BASE_URL=${shellEscape(effectiveBaseUrl)}
export XLB_GATEWAY_TUNNEL_ENABLED=${shellEscape(tunnelEnabled ? "1" : "0")}
export XLB_GATEWAY_TUNNEL_HOST=${shellEscape(tunnelHost)}
export XLB_GATEWAY_TUNNEL_USER=${shellEscape(gatewayTunnelUser)}
export XLB_GATEWAY_TUNNEL_LOCAL_PORT=${shellEscape(String(gatewayTunnelLocalPort))}
export XLB_GATEWAY_TUNNEL_REMOTE_PORT=${shellEscape(String(gatewayTunnelRemotePort))}
export XLB_GATEWAY_TUNNEL_KEY=${shellEscape(LOCAL_GATEWAY_TUNNEL_KEY_PATH)}
export XLB_GATEWAY_TUNNEL_PRIVATE_KEY_B64=${shellEscape(
    gatewayTunnelPrivateKey ? Buffer.from(gatewayTunnelPrivateKey, "utf8").toString("base64") : "",
  )}
export XLB_LOCAL_SESSIONS_DIR=${shellEscape(path.join(LOCAL_OPENCLAW_STATE_DIR, "agents", "main", "sessions"))}
export XLB_LOCAL_BINDING_STATE_PATH=${shellEscape(LOCAL_BINDING_STATE_PATH)}
export XLB_LOCAL_WORKSPACE_ID=${shellEscape(
    typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "",
  )}
export XLB_LOCAL_DEPLOYMENT_ID=${shellEscape(
    typeof payload.deploymentId === "string" ? payload.deploymentId.trim() : "",
  )}
export XLB_LOCAL_DEVICE_ID=${shellEscape(localDeviceId)}
export XLB_LOCAL_DEVICE_LABEL=${shellEscape(localDeviceLabel)}

iso_now() {
  date "+%Y-%m-%dT%H:%M:%S%z"
}

echo "[xiaolanbu-local] bootstrap started at $(iso_now)"

if [[ -d "$XLB_LEGACY_STATE_DIR" && ! -e "$OPENCLAW_STATE_DIR" ]]; then
  mkdir -p "$(dirname "$OPENCLAW_STATE_DIR")"
  if command -v ditto >/dev/null 2>&1; then
    ditto "$XLB_LEGACY_STATE_DIR" "$OPENCLAW_STATE_DIR"
  else
    cp -R "$XLB_LEGACY_STATE_DIR" "$OPENCLAW_STATE_DIR"
  fi
  echo "[xiaolanbu-local] migrated legacy state dir $XLB_LEGACY_STATE_DIR -> $OPENCLAW_STATE_DIR"
fi

if [[ -d "$XLB_LEGACY_PROFILE_STATE_DIR" && ! -e "$OPENCLAW_STATE_DIR" ]]; then
  mkdir -p "$(dirname "$OPENCLAW_STATE_DIR")"
  if command -v ditto >/dev/null 2>&1; then
    ditto "$XLB_LEGACY_PROFILE_STATE_DIR" "$OPENCLAW_STATE_DIR"
  else
    cp -R "$XLB_LEGACY_PROFILE_STATE_DIR" "$OPENCLAW_STATE_DIR"
  fi
  echo "[xiaolanbu-local] migrated legacy profile state dir $XLB_LEGACY_PROFILE_STATE_DIR -> $OPENCLAW_STATE_DIR"
fi

mkdir -p "$XLB_OPENCLAW_ROOT" "$XLB_NODE_ROOT" "$XLB_NPM_PREFIX" "$XLB_MANAGED_BIN_DIR" "$OPENCLAW_STATE_DIR" "$XLB_LOCAL_WORKSPACE_DIR" "$XLB_LOCAL_AGENT_DIR"

log() {
  echo "[xiaolanbu-local] $*"
}

format_bytes() {
  local bytes="\${1:-0}"
  awk -v bytes="$bytes" '
    BEGIN {
      if (bytes < 1024) { printf "%d B", bytes; exit }
      if (bytes < 1048576) { printf "%.1f KB", bytes / 1024; exit }
      if (bytes < 1073741824) { printf "%.1f MB", bytes / 1048576; exit }
      printf "%.2f GB", bytes / 1073741824
    }
  '
}

format_rate() {
  local bytes_per_second="\${1:-0}"
  awk -v bytes_per_second="$bytes_per_second" '
    BEGIN {
      if (bytes_per_second < 1024) { printf "%.0f B/s", bytes_per_second; exit }
      if (bytes_per_second < 1048576) { printf "%.1f KB/s", bytes_per_second / 1024; exit }
      if (bytes_per_second < 1073741824) { printf "%.1f MB/s", bytes_per_second / 1048576; exit }
      printf "%.2f GB/s", bytes_per_second / 1073741824
    }
  '
}

get_remote_content_length() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSLI "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -n 1
    return
  fi
  wget --server-response --spider --timeout=8 "$url" 2>&1 | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -n 1
}

get_file_size_bytes() {
  local target="$1"
  [[ -f "$target" ]] || {
    echo 0
    return
  }
  wc -c < "$target" | tr -d ' '
}

download_file() {
  local url="$1"
  local output="$2"
  local total_bytes=""
  total_bytes="$(get_remote_content_length "$url")"
  local downloader_pid=""

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 --retry-connrefused -o "$output" "$url" &
    downloader_pid=$!
  else
    wget -q --tries=3 --timeout=20 -O "$output" "$url" &
    downloader_pid=$!
  fi

  local last_percent=-5
  local last_logged_bytes=0
  local started_at
  started_at="$(date +%s)"

  while kill -0 "$downloader_pid" >/dev/null 2>&1; do
    local downloaded_bytes
    downloaded_bytes="$(get_file_size_bytes "$output")"
    local now
    now="$(date +%s)"
    local elapsed_seconds=$(( now - started_at ))
    (( elapsed_seconds < 1 )) && elapsed_seconds=1
    local bytes_per_second=$(( downloaded_bytes / elapsed_seconds ))
    if [[ "$total_bytes" =~ ^[0-9]+$ ]] && (( total_bytes > 0 )); then
      local percent=$(( downloaded_bytes * 100 / total_bytes ))
      (( percent > 100 )) && percent=100
      if (( percent >= last_percent + 5 )); then
        log "runtime bundle download progress \${percent}% ($(format_bytes "$downloaded_bytes") / $(format_bytes "$total_bytes") @ $(format_rate "$bytes_per_second"))"
        last_percent=$percent
      fi
    elif (( downloaded_bytes - last_logged_bytes >= 10485760 )); then
      log "runtime bundle download progress $(format_bytes "$downloaded_bytes") downloaded @ $(format_rate "$bytes_per_second")"
      last_logged_bytes=$downloaded_bytes
    fi
    sleep 1
  done

  wait "$downloader_pid"
  local exit_code=$?
  if (( exit_code != 0 )); then
    return "$exit_code"
  fi

  local downloaded_bytes
  downloaded_bytes="$(get_file_size_bytes "$output")"
  local finished_at
  finished_at="$(date +%s)"
  local elapsed_seconds=$(( finished_at - started_at ))
  (( elapsed_seconds < 1 )) && elapsed_seconds=1
  local bytes_per_second=$(( downloaded_bytes / elapsed_seconds ))
  if [[ "$total_bytes" =~ ^[0-9]+$ ]] && (( total_bytes > 0 )); then
    log "runtime bundle download progress 100% ($(format_bytes "$downloaded_bytes") / $(format_bytes "$total_bytes") @ $(format_rate "$bytes_per_second"))"
  elif (( downloaded_bytes > last_logged_bytes )); then
    log "runtime bundle download progress $(format_bytes "$downloaded_bytes") downloaded @ $(format_rate "$bytes_per_second")"
  fi
}

probe_url() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -IfsSL --max-time 6 "$url" >/dev/null 2>&1
    return
  fi
  wget -q --spider --timeout=6 "$url" >/dev/null 2>&1
}

verify_sha256() {
  local expected="$1"
  local target_file="$2"
  [[ -n "$expected" ]] || return 0
  if command -v shasum >/dev/null 2>&1; then
    local actual
    actual="$(shasum -a 256 "$target_file" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]]
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    local actual
    actual="$(sha256sum "$target_file" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]]
    return
  fi
  return 0
}

ensure_gateway_tunnel() {
  if [[ "$XLB_GATEWAY_TUNNEL_ENABLED" == "1" ]]; then
    log "gateway tunnel is managed by Xiaolanbu desktop helper"
  fi
  return 0
}

version_gte() {
  local current="$1"
  local minimum="$2"
  local current_major=0 current_minor=0 current_patch=0
  local minimum_major=0 minimum_minor=0 minimum_patch=0

  current="\${current#v}"
  minimum="\${minimum#v}"
  IFS=. read -r current_major current_minor current_patch <<<"$current"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<<"$minimum"

  current_major="\${current_major:-0}"
  current_minor="\${current_minor:-0}"
  current_patch="\${current_patch:-0}"
  minimum_major="\${minimum_major:-0}"
  minimum_minor="\${minimum_minor:-0}"
  minimum_patch="\${minimum_patch:-0}"

  if (( current_major > minimum_major )); then
    return 0
  fi
  if (( current_major < minimum_major )); then
    return 1
  fi
  if (( current_minor > minimum_minor )); then
    return 0
  fi
  if (( current_minor < minimum_minor )); then
    return 1
  fi
  if (( current_patch >= minimum_patch )); then
    return 0
  fi
  return 1
}

node_satisfies_minimum() {
  local node_bin="$1"
  if [[ ! -x "$node_bin" ]]; then
    return 1
  fi
  local current_version
  current_version="$("$node_bin" -p "process.versions.node" 2>/dev/null || true)"
  [[ -n "$current_version" ]] || return 1
  version_gte "$current_version" "22.16.0"
}

detect_mainland_network() {
  if [[ "\${XLB_FORCE_MAINLAND_NETWORK:-0}" == "1" ]]; then
    return 0
  fi

  local github_ok=0
  local raw_ok=0
  local npmmirror_ok=0
  local baidu_ok=0

  probe_url "https://github.com" && github_ok=1 || true
  probe_url "https://raw.githubusercontent.com" && raw_ok=1 || true
  probe_url "https://registry.npmmirror.com/openclaw" && npmmirror_ok=1 || true
  probe_url "https://www.baidu.com" && baidu_ok=1 || true

  if [[ $npmmirror_ok -eq 1 && $baidu_ok -eq 1 && ( $github_ok -eq 0 || $raw_ok -eq 0 ) ]]; then
    return 0
  fi

  return 1
}

select_runtime_bundle() {
  case "$(uname -m)" in
    arm64|aarch64)
      echo "$XLB_RUNTIME_ARM64_URL|$XLB_RUNTIME_ARM64_SHA256"
      ;;
    x86_64|amd64)
      echo "$XLB_RUNTIME_X64_URL|$XLB_RUNTIME_X64_SHA256"
      ;;
    *)
      echo "|"
      ;;
  esac
}

install_runtime_bundle() {
  if [[ -x "$XLB_OPENCLAW_ROOT/bin/openclaw" ]]; then
    log "reusing existing Xiaolanbu runtime bundle"
    return 0
  fi

  if [[ -x "$XLB_MANAGED_CLAW_BIN" ]]; then
    log "reusing existing Xiaolanbu runtime wrapper"
    return 0
  fi

  local bundle_info
  bundle_info="$(select_runtime_bundle)"
  local bundle_url="\${bundle_info%%|*}"
  local bundle_sha256="\${bundle_info#*|}"

  if [[ -z "$bundle_url" ]]; then
    return 1
  fi

  local tmp_dir archive_path extracted_root
  tmp_dir="$(mktemp -d)"
  archive_path="$tmp_dir/runtime.tar.gz"
  extracted_root="$tmp_dir/openclaw-runtime"

  log "downloading Xiaolanbu runtime bundle"
  download_file "$bundle_url" "$archive_path"
  if ! verify_sha256 "$bundle_sha256" "$archive_path"; then
    log "runtime bundle checksum mismatch"
    rm -rf "$tmp_dir"
    return 1
  fi

  tar -xzf "$archive_path" -C "$tmp_dir"
  if [[ ! -x "$extracted_root/bin/openclaw" ]]; then
    log "runtime bundle is missing bin/openclaw"
    rm -rf "$tmp_dir"
    return 1
  fi

  rm -rf "$XLB_OPENCLAW_ROOT"
  mkdir -p "$(dirname "$XLB_OPENCLAW_ROOT")"
  mv "$extracted_root" "$XLB_OPENCLAW_ROOT"
  rm -rf "$tmp_dir"
  log "installed Xiaolanbu runtime bundle into $XLB_OPENCLAW_ROOT"
  return 0
}

install_managed_node() {
  local version_tag="v$XLB_NODE_VERSION"
  local arch
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      log "unsupported macOS architecture: $(uname -m)"
      exit 1
      ;;
  esac

  local node_archive="node-$version_tag-darwin-$arch.tar.gz"
  local base_url
  if detect_mainland_network; then
    base_url="https://registry.npmmirror.com/-/binary/node"
    log "detected mainland-friendly network mode"
  else
    base_url="https://nodejs.org/dist"
    log "detected global network mode"
  fi

  local target_dir="$XLB_NODE_ROOT/versions/$version_tag"
  local tmp_archive
  tmp_archive="$(mktemp)"

  log "installing managed Node.js $version_tag ($arch)"
  download_file "$base_url/$version_tag/$node_archive" "$tmp_archive"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  tar -xzf "$tmp_archive" -C "$target_dir" --strip-components=1
  rm -f "$tmp_archive"
  ln -sfn "$target_dir" "$XLB_NODE_ROOT/current"
  export PATH="$XLB_NODE_ROOT/current/bin:$PATH"
}

ensure_node_runtime() {
  if node_satisfies_minimum "$XLB_MANAGED_NODE_BIN"; then
    export PATH="$XLB_NODE_ROOT/current/bin:$PATH"
    log "using cached managed Node.js $("$XLB_MANAGED_NODE_BIN" -p 'process.versions.node')"
    return 0
  fi

  install_managed_node
}

write_managed_openclaw_wrapper() {
  local module_entry="$XLB_NPM_PREFIX/lib/node_modules/openclaw/openclaw.mjs"
  if [[ ! -f "$module_entry" ]]; then
    log "managed OpenClaw entry missing at $module_entry"
    exit 1
  fi
  cat > "$XLB_MANAGED_OPENCLAW_BIN" <<EOF
#!/bin/bash
set -euo pipefail
export PATH="$XLB_NODE_ROOT/current/bin:$XLB_NPM_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$XLB_NODE_ROOT/current/bin/node" "$module_entry" "\$@"
EOF
  chmod +x "$XLB_MANAGED_OPENCLAW_BIN"
}

install_openclaw_with_managed_npm() {
  ensure_node_runtime
  export PATH="$XLB_MANAGED_BIN_DIR:$XLB_NPM_PREFIX/bin:$XLB_NODE_ROOT/current/bin:$PATH"
  export NPM_CONFIG_PREFIX="$XLB_NPM_PREFIX"
  export npm_config_prefix="$XLB_NPM_PREFIX"
  export npm_config_update_notifier="false"
  export npm_config_fund="false"
  export npm_config_audit="false"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"

  if detect_mainland_network; then
    export NPM_CONFIG_REGISTRY="https://registry.npmmirror.com"
    export npm_config_registry="$NPM_CONFIG_REGISTRY"
    log "using npm mirror: $NPM_CONFIG_REGISTRY"
  else
    export NPM_CONFIG_REGISTRY="https://registry.npmjs.org"
    export npm_config_registry="$NPM_CONFIG_REGISTRY"
  fi

  log "installing OpenClaw from npm"
  "$XLB_MANAGED_NPM_BIN" install -g --force "openclaw@latest"
  write_managed_openclaw_wrapper
}

resolve_openclaw_bin() {
  if [[ -x "$XLB_MANAGED_OPENCLAW_BIN" ]]; then
    echo "$XLB_MANAGED_OPENCLAW_BIN"
    return 0
  fi
  if command -v openclaw >/dev/null 2>&1; then
    command -v openclaw
    return 0
  fi
  return 1
}

run_official_installer() {
  log "trying official OpenClaw installer"
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
}

install_openclaw_runtime() {
  local existing_bin=""

  if install_runtime_bundle; then
    existing_bin="$(resolve_openclaw_bin || true)"
    if [[ -n "$existing_bin" ]]; then
      log "using packaged Xiaolanbu runtime"
      return 0
    fi
    log "runtime bundle installed but openclaw is still unavailable, falling back"
  fi

  existing_bin="$(resolve_openclaw_bin || true)"
  if [[ -n "$existing_bin" ]]; then
    log "using existing OpenClaw at $existing_bin"
    return 0
  fi

  if detect_mainland_network; then
    log "mainland network detected, using managed npm path"
    install_openclaw_with_managed_npm
    return 0
  fi

  if run_official_installer; then
    existing_bin="$(resolve_openclaw_bin || true)"
    if [[ -n "$existing_bin" ]]; then
      log "official installer succeeded"
      return 0
    fi
    log "official installer finished without exposing openclaw on PATH, falling back"
  else
    log "official installer failed, falling back to managed npm path"
  fi

  install_openclaw_with_managed_npm
}

install_openclaw_runtime

OPENCLAW_BIN="$(resolve_openclaw_bin || true)"
if [[ -z "$OPENCLAW_BIN" ]]; then
  echo "[xiaolanbu-local] openclaw installation did not expose binary on PATH"
  exit 1
fi

echo "[xiaolanbu-local] using openclaw at $OPENCLAW_BIN"
ensure_gateway_tunnel

mkdir -p "$XLB_LOCAL_SESSIONS_DIR"

echo "[xiaolanbu-local] running onboard"

"$OPENCLAW_BIN" onboard \\
  --non-interactive \\
  --accept-risk \\
  --mode local \\
  --auth-choice custom-api-key \\
  --custom-provider-id ${shellEscape(providerId)} \\
  --custom-base-url "$XLB_GATEWAY_BASE_URL" \\
  --custom-model-id ${shellEscape(modelId)} \\
  --custom-compatibility openai \\
  --gateway-port ${String(gatewayPort)} \\
  --gateway-bind ${shellEscape(gatewayBind)} \\
  --gateway-auth token \\
  --gateway-token ${shellEscape(gatewayToken)} \\
  --install-daemon \\
  --skip-ui \\
  --workspace ${shellEscape(localWorkspaceDir)}

if [[ -x "$XLB_MANAGED_NODE_BIN" && -f "$OPENCLAW_CONFIG_PATH" ]]; then
  "$XLB_MANAGED_NODE_BIN" <<'EOF'
const fs = require("fs");
const path = require("path");
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const agentDir = process.env.XLB_LOCAL_AGENT_DIR;
const workspaceDir = process.env.XLB_LOCAL_WORKSPACE_DIR;
const apiKey = process.env.OPENCLAW_API_KEY;
const bindingStatePath = process.env.XLB_LOCAL_BINDING_STATE_PATH;
const workspaceId = process.env.XLB_LOCAL_WORKSPACE_ID || "";
const deploymentId = process.env.XLB_LOCAL_DEPLOYMENT_ID || "";
const localDeviceId = process.env.XLB_LOCAL_DEVICE_ID || "";
const localDeviceLabel = process.env.XLB_LOCAL_DEVICE_LABEL || "";
const providerId = ${JSON.stringify(providerId)};
const modelId = ${JSON.stringify(modelId)};
const managedAllowedModelIds = ${JSON.stringify(
    Array.isArray(allowedModelIds)
      ? allowedModelIds
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => value.trim())
      : [],
  )};
const targetBaseUrl = process.env.XLB_GATEWAY_BASE_URL || ${JSON.stringify(effectiveBaseUrl)};
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const resolveCompatForModel = (value) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const compat = {
    supportsUsageInStreaming: false,
  };
  if (!normalized) {
    return compat;
  }
  if (normalized.startsWith("qwen")) {
    compat.supportsStrictMode = false;
    compat.thinkingFormat = "qwen";
    return compat;
  }
  if (normalized.startsWith("glm")) {
    compat.thinkingFormat = "zai";
    return compat;
  }
  if (
    normalized.startsWith("gpt-") ||
    normalized === "gpt-4o" ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    compat.thinkingFormat = "openai";
    return compat;
  }
  return compat;
};
const collectManagedModelIds = (providers, preferredProviderId) => {
  const values = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    values.push(normalized);
  };
  if (Array.isArray(managedAllowedModelIds)) {
    managedAllowedModelIds.forEach(push);
  }
  push(modelId);
  const providerOrder = [];
  if (typeof preferredProviderId === "string" && preferredProviderId.trim()) {
    providerOrder.push(preferredProviderId.trim());
  }
  for (const providerName of providerOrder) {
    const providerConfig = isRecord(providers?.[providerName]) ? providers[providerName] : {};
    const providerModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    for (const item of providerModels) {
      if (item && typeof item === "object") {
        push(item.id);
      }
    }
  }
  return values;
};
const applyCompatForModel = (target, value) => {
  if (!isRecord(target)) {
    return;
  }
  const nextCompat = resolveCompatForModel(value);
  target.compat = isRecord(target.compat) ? target.compat : {};
  target.compat.supportsUsageInStreaming = nextCompat.supportsUsageInStreaming;
  if (Object.prototype.hasOwnProperty.call(nextCompat, "supportsStrictMode")) {
    target.compat.supportsStrictMode = nextCompat.supportsStrictMode;
  } else {
    delete target.compat.supportsStrictMode;
  }
  if (typeof nextCompat.thinkingFormat === "string" && nextCompat.thinkingFormat.trim()) {
    target.compat.thinkingFormat = nextCompat.thinkingFormat;
  } else {
    delete target.compat.thinkingFormat;
  }
};
const readJsonFile = (filePath, fallback) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\\uFEFF/, "");
  if (!raw.trim()) {
    return fallback;
  }
  return JSON.parse(raw);
};
const warn = (message, error) => {
  const detail = error && error.stack ? error.stack : error && error.message ? error.message : String(error);
  console.error("[xiaolanbu-local] " + message + ": " + detail);
};
const existingBinding = bindingStatePath ? readJsonFile(bindingStatePath, {}) : {};
const hadManagedOpenAiAlias =
  Boolean(existingBinding) &&
  (
    (Array.isArray(existingBinding.managedProviderIds) && existingBinding.managedProviderIds.includes("openai")) ||
    (Array.isArray(existingBinding.managedProfileIds) && existingBinding.managedProfileIds.includes("openai:default"))
  );
const shouldReplaceManagedOpenAiAlias = hadManagedOpenAiAlias && providerId !== "openai";

if (agentDir && apiKey) {
  try {
  const authStorePath = path.join(agentDir, "auth-profiles.json");
  const existingStore = readJsonFile(authStorePath, {});
  const store = isRecord(existingStore) ? existingStore : {};
  store.version = 1;
  store.profiles = isRecord(store.profiles) ? store.profiles : {};
  store.lastGood = isRecord(store.lastGood) ? store.lastGood : {};
  store.usageStats = isRecord(store.usageStats) ? store.usageStats : {};
  store.profiles[providerId + ":default"] = {
    type: "api_key",
    provider: providerId,
    key: apiKey,
  };
  store.lastGood[providerId] = providerId + ":default";
  if (shouldReplaceManagedOpenAiAlias) {
    delete store.profiles["openai:default"];
    delete store.lastGood.openai;
  }
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(authStorePath, JSON.stringify(store, null, 2) + "\\n");
  } catch (error) {
    warn("auth store normalization skipped", error);
  }
}

if (configPath && workspaceDir) {
  try {
    const config = readJsonFile(configPath, {});
    if (!isRecord(config)) {
      throw new Error("openclaw.json is not an object");
    }
    config.models = isRecord(config.models) ? config.models : {};
    const existingProviders = isRecord(config.models.providers) ? config.models.providers : {};
    config.models.providers = {};
    for (const [alias, providerConfig] of Object.entries(existingProviders)) {
      if (
        alias === providerId ||
        alias.startsWith(providerId + ":") ||
        alias.startsWith(providerId + "-") ||
        (
          shouldReplaceManagedOpenAiAlias &&
          (alias === "openai" || alias.startsWith("openai:") || alias.startsWith("openai-"))
        )
      ) {
        continue;
      }
      config.models.providers[alias] = providerConfig;
    }
    const ensureProviderConfig = (id) => {
      const providerConfig = isRecord(config.models.providers[id]) ? config.models.providers[id] : {};
      providerConfig.api = "openai-completions";
      providerConfig.apiKey = apiKey;
      providerConfig.baseUrl = targetBaseUrl;
      const currentModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];
      if (!currentModels.some((model) => model && typeof model === "object" && model.id === modelId)) {
        currentModels.push({
          id: modelId,
          name: modelId + " (Custom Provider)",
          input: ["text", "image"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });
      }
      for (const model of currentModels) {
        if (model && typeof model === "object") {
          if (typeof model.name !== "string" || !model.name.trim()) {
            model.name = String(model.id || modelId) + " (Custom Provider)";
          }
          const nextInput = new Set(
            Array.isArray(model.input)
              ? model.input
                  .map((value) => (typeof value === "string" ? value.trim() : ""))
                  .filter(Boolean)
              : [],
          );
          nextInput.add("text");
          nextInput.add("image");
          model.input = Array.from(nextInput);
          model.cost = isRecord(model.cost) ? model.cost : {};
          model.cost.input = Number(model.cost.input || 0);
          model.cost.output = Number(model.cost.output || 0);
          model.cost.cacheRead = Number(model.cost.cacheRead || 0);
          model.cost.cacheWrite = Number(model.cost.cacheWrite || 0);
          model.contextWindow = Math.max(Number(model.contextWindow || 0), 262144);
          model.maxTokens = Math.max(Number(model.maxTokens || 0), 8192);
          model.reasoning = false;
          applyCompatForModel(model, model.id || modelId);
        }
      }
      providerConfig.models = currentModels;
      config.models.providers[id] = providerConfig;
    };
    ensureProviderConfig(providerId);
    config.agents = isRecord(config.agents) ? config.agents : {};
    config.agents.defaults = isRecord(config.agents.defaults) ? config.agents.defaults : {};
    config.agents.defaults.model = isRecord(config.agents.defaults.model)
      ? config.agents.defaults.model
      : {};
    config.agents.defaults.model.primary = providerId + "/" + modelId;
    const managedModelIds = collectManagedModelIds(config.models.providers, providerId);
    const existingDefaultModels = isRecord(config.agents.defaults.models) ? config.agents.defaults.models : {};
    for (const managedModelId of managedModelIds) {
      const managedModelKey = providerId + "/" + managedModelId;
      existingDefaultModels[managedModelKey] = isRecord(existingDefaultModels[managedModelKey])
        ? existingDefaultModels[managedModelKey]
        : {};
    }
    config.agents.defaults.models = existingDefaultModels;
    config.agents.defaults.model.fallbacks = managedModelIds
      .filter((value) => value !== modelId)
      .map((value) => providerId + "/" + value);
    config.agents.defaults.workspace = workspaceDir;
    delete config.agents.defaults.skipBootstrap;
    delete config.agents.defaults.bootstrapMaxChars;
    delete config.agents.defaults.bootstrapTotalMaxChars;
    const existingAgentList = Array.isArray(config.agents.list) ? config.agents.list : [];
    const mainAgentIndex = existingAgentList.findIndex((entry) => isRecord(entry) && entry.id === "main");
    const mainAgent =
      mainAgentIndex >= 0 && isRecord(existingAgentList[mainAgentIndex])
        ? existingAgentList[mainAgentIndex]
        : { id: "main", default: true };
    mainAgent.id = "main";
    if (typeof mainAgent.default !== "boolean") {
      mainAgent.default = true;
    }
    mainAgent.workspace = workspaceDir;
    if (mainAgentIndex >= 0) {
      existingAgentList[mainAgentIndex] = mainAgent;
      config.agents.list = existingAgentList;
    } else {
      config.agents.list = [mainAgent, ...existingAgentList];
    }
    config.auth = isRecord(config.auth) ? config.auth : {};
    config.auth.profiles = isRecord(config.auth.profiles) ? config.auth.profiles : {};
    config.auth.profiles[providerId + ":default"] = {
      provider: providerId,
      mode: "api_key",
    };
    if (shouldReplaceManagedOpenAiAlias) {
      delete config.auth.profiles["openai:default"];
    }
    config.skills = isRecord(config.skills) ? config.skills : {};
    config.skills.limits = isRecord(config.skills.limits) ? config.skills.limits : {};
    if (
      Array.isArray(config.skills.allowBundled) &&
      config.skills.allowBundled.length === 1 &&
      config.skills.allowBundled[0] === "__xlb_none__"
    ) {
      delete config.skills.allowBundled;
    }
    delete config.skills.limits.maxSkillsInPrompt;
    delete config.skills.limits.maxSkillsPromptChars;
    if (!Object.keys(config.skills.limits).length) {
      delete config.skills.limits;
    }
    if (!Object.keys(config.skills).length) {
      delete config.skills;
    }
    config.gateway = isRecord(config.gateway) ? config.gateway : {};
    config.gateway.http = isRecord(config.gateway.http) ? config.gateway.http : {};
    config.gateway.http.endpoints = isRecord(config.gateway.http.endpoints)
      ? config.gateway.http.endpoints
      : {};
    config.gateway.http.endpoints.responses = isRecord(config.gateway.http.endpoints.responses)
      ? config.gateway.http.endpoints.responses
      : {};
    config.gateway.http.endpoints.responses.enabled = true;
    config.tools = isRecord(config.tools) ? config.tools : {};
    if (typeof config.tools.profile !== "string" || !config.tools.profile.trim()) {
      config.tools.profile = "coding";
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
  } catch (error) {
    warn("config normalization skipped", error);
  }
}

if (bindingStatePath) {
  fs.mkdirSync(path.dirname(bindingStatePath), { recursive: true });
  fs.writeFileSync(
    bindingStatePath,
    JSON.stringify(
      {
        workspaceId,
        deploymentId,
        localDeviceId,
        localDeviceLabel,
        localPlatform: process.platform,
        providerId,
        managedProviderIds: ${JSON.stringify([providerId])},
        managedProfileIds: ${JSON.stringify([`${providerId}:default`])},
        baseUrl: process.env.XLB_GATEWAY_BASE_URL || ${JSON.stringify(effectiveBaseUrl)},
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\\n",
    "utf8",
  );
}

if (workspaceDir) {
  fs.mkdirSync(workspaceDir, { recursive: true });
}
EOF
fi

echo "[xiaolanbu-local] restarting local gateway"
"$OPENCLAW_BIN" gateway restart >/dev/null 2>&1 || true

echo "[xiaolanbu-local] waiting for ports ${String(gatewayPort)} and ${String(browserControlPort)}"
for _ in $(seq 1 45); do
  if lsof -n -iTCP:${String(gatewayPort)} -sTCP:LISTEN >/dev/null 2>&1 && lsof -n -iTCP:${String(
    browserControlPort,
  )} -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[xiaolanbu-local] local gateway is ready"
    echo "[xiaolanbu-local] bootstrap finished at $(iso_now)"
    exit 0
  fi
  sleep 2
done

echo "[xiaolanbu-local] local gateway did not become ready in time"
exit 1
`;

  fs.writeFileSync(launcherPath, script, { mode: 0o700 });
  return launcherPath;
}

function extractTunnelHost(command) {
  return parseManagedTunnelCommand(command)?.host ?? "";
}

function listActiveTunnelProcesses() {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const output = execFileSync("pgrep", ["-fal", "ssh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(" ");
        if (firstSpace <= 0) {
          return null;
        }

        const pid = Number(line.slice(0, firstSpace));
        const command = line.slice(firstSpace + 1);
        if (
          !Number.isFinite(pid) ||
          !/-L\s+\d+:127\.0\.0\.1:18789\b/.test(command) ||
          !/-L\s+\d+:127\.0\.0\.1:18791\b/.test(command)
        ) {
          return null;
        }

        return {
          pid,
          command,
          host: extractTunnelHost(command),
          kind: "dashboard",
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listGatewayTunnelProcesses() {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const output = execFileSync("pgrep", ["-fal", "ssh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(" ");
        if (firstSpace <= 0) {
          return null;
        }

        const pid = Number(line.slice(0, firstSpace));
        const command = line.slice(firstSpace + 1);
        if (
          !Number.isFinite(pid) ||
          !command.includes(`-L ${String(LOCAL_GATEWAY_TUNNEL_PORT)}:127.0.0.1:`)
        ) {
          return null;
        }

        return {
          pid,
          command,
          host: extractTunnelHost(command),
          kind: "gateway",
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function killTunnelProcesses(processes) {
  for (const processInfo of processes) {
    try {
      process.kill(processInfo.pid, "SIGTERM");
    } catch {
      // Ignore already-exited processes.
    }
  }
}

function createTunnelLauncherScript(command, password) {
  const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaolanbu-tunnel-"));
  const launcherPath = path.join(launcherDir, "launch-tunnel.sh");
  const script = `#!/bin/bash
set +e
export SSH_CMD=${shellEscape(command)}
export SSH_PASSWORD=${shellEscape(password)}
/usr/bin/expect <<'EOF'
set timeout -1
set ssh_cmd $env(SSH_CMD)
set ssh_password $env(SSH_PASSWORD)
spawn bash -lc $ssh_cmd
expect {
  -re {Are you sure you want to continue connecting \\(yes/no(/\\[fingerprint\\])?\\)\\?} {
    send -- "yes\\r"
    exp_continue
  }
  -re {(?i)(password|passphrase).*:} {
    send -- "$ssh_password\\r"
    exp_continue
  }
  eof
}
catch wait result
set exit_status [lindex $result 3]
exit $exit_status
EOF
status=$?
rm -f "$0"
rmdir ${shellEscape(launcherDir)} 2>/dev/null || true
exit $status
`;

  fs.writeFileSync(launcherPath, script, { mode: 0o700 });
  return launcherPath;
}

async function stopLocalOpenClaw(options = {}) {
  const clearBinding = options.clearBinding !== false;
  const clearCredentials =
    typeof options.clearCredentials === "boolean" ? options.clearCredentials : clearBinding;
  const clearTunnel =
    typeof options.clearTunnel === "boolean" ? options.clearTunnel : true;
  let windowsGatewayStop = null;
  let windowsGatewayTaskStop = null;

  if (IS_WINDOWS) {
    windowsGatewayStop = await tryRunLocalOpenClawGatewayCommand(["gateway", "stop", "--json"]);
    if (!windowsGatewayStop?.ok) {
      windowsGatewayTaskStop = await stopWindowsGatewayScheduledTask();
    }
  }

  const agents = listManagedOpenClawLaunchAgents();
  const stoppedAgents = [];

  for (const agent of agents) {
    if (bootoutLaunchAgent(agent)) {
      stoppedAgents.push(agent.label || path.basename(agent.plistPath));
    }
  }

  const stoppedBundledGatewayTunnel = clearTunnel
    ? stopBundledLocalGatewayTunnel({
        localPort:
          Number(readLocalBindingState()?.gatewayTunnel?.localPort) || LOCAL_GATEWAY_TUNNEL_PORT,
      })
    : { stoppedPids: [], tunnelPorts: [] };
  const stoppedGatewayTunnels = killProcessesByPid([
    ...listGatewayTunnelProcesses().map((item) => item.pid),
    ...stoppedBundledGatewayTunnel.stoppedPids,
    ...stoppedBundledGatewayTunnel.tunnelPorts.flatMap((port) => listListeningPids(port)),
  ]);
  const stoppedRuntimePids = killProcessesByPid([
    ...listListeningPids(LOCAL_DEFAULT_DASHBOARD_PORT),
    ...listListeningPids(LOCAL_DEFAULT_BROWSER_CONTROL_PORT),
  ]);

  if (clearCredentials) {
    sanitizeLocalOpenClawCredentials();
  }

  if (clearBinding) {
    clearLocalBindingState();
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  return {
    ok: true,
    windowsGatewayStop,
    windowsGatewayTaskStop,
    stoppedAgents,
    stoppedRuntimePids,
    stoppedGatewayTunnels,
    stoppedBundledGatewayTunnel,
    clearedBinding: clearBinding,
    status: await getLocalOpenClawStatus(),
  };
}

async function uninstallLocalOpenClaw() {
  const stopped = await stopLocalOpenClaw({ clearBinding: true });
  let windowsGatewayUninstall = null;
  let windowsGatewayTaskDelete = null;

  if (IS_WINDOWS) {
    windowsGatewayUninstall = await tryRunLocalOpenClawGatewayCommand([
      "gateway",
      "uninstall",
      "--json",
    ]);
    if (!windowsGatewayUninstall?.ok) {
      windowsGatewayTaskDelete = await deleteWindowsGatewayScheduledTask();
    }
  }

  const managedAgents = listManagedOpenClawLaunchAgents();
  const removedAgents = removeManagedOpenClawLaunchAgents(managedAgents);
  const removedPaths = [];

  const removablePaths = [
    LOCAL_OPENCLAW_STATE_DIR,
    LEGACY_LOCAL_OPENCLAW_STATE_DIR,
    LEGACY_LOCAL_PROFILE_STATE_DIR,
    LOCAL_MANAGED_RUNTIME_ROOT,
    LOCAL_GATEWAY_TUNNEL_KEY_DIR,
    path.dirname(LEGACY_LOCAL_GATEWAY_TUNNEL_KEY_PATH),
  ];

  for (const targetPath of removablePaths) {
    if (removePathIfExists(targetPath)) {
      removedPaths.push(targetPath);
    }
  }

  const removableFiles = [
    LOCAL_BINDING_STATE_PATH,
    LOCAL_BOOTSTRAP_LOG,
    LOCAL_GATEWAY_TUNNEL_STATE_PATH,
    LOCAL_GATEWAY_TUNNEL_CONFIG_PATH,
    `${LOCAL_GATEWAY_TUNNEL_KEY_PATH}.pub`,
    `${LEGACY_LOCAL_GATEWAY_TUNNEL_KEY_PATH}.pub`,
  ];

  for (const targetPath of removableFiles) {
    if (removeFileIfExists(targetPath)) {
      removedPaths.push(targetPath);
    }
  }

  removeEmptyDirectory(path.dirname(LEGACY_LOCAL_GATEWAY_TUNNEL_KEY_PATH));
  removeEmptyDirectory(path.dirname(path.dirname(LEGACY_LOCAL_GATEWAY_TUNNEL_KEY_PATH)));
  removeEmptyDirectory(LOCAL_LOG_DIR);

  return {
    ok: true,
    stopped,
    windowsGatewayUninstall,
    windowsGatewayTaskDelete,
    removedAgents,
    removedPaths,
    status: await getLocalOpenClawStatus(),
  };
}

function checkLocalPortOpen(port) {
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

    socket.setTimeout(600);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", () => finalize(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function getLocalOpenClawStatus() {
  const runtime = await detectLocalOpenClawRuntime();
  const [dashboardPortOpen, browserControlPortOpen] = await Promise.all([
    checkLocalPortOpen(LOCAL_DEFAULT_DASHBOARD_PORT),
    checkLocalPortOpen(LOCAL_DEFAULT_BROWSER_CONTROL_PORT),
  ]);
  const localDeviceIdentity = getOrCreateLocalDesktopDeviceIdentity();
  const binding = readLocalBindingState();
  if (binding?.gatewayTunnel && typeof binding.gatewayTunnel === "object") {
    try {
      await ensurePersistedLocalGatewayTunnel();
    } catch (error) {
      appendLocalBootstrapLog(
        `bundled gateway tunnel ensure failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const config = readJsonFile(LOCAL_OPENCLAW_CONFIG_PATH);
  const authStore = readLocalOpenClawAuthStore();
  const localApiKeyConfigured = hasLocalManagedProviderApiKey(binding, config, authStore);
  const currentModelId =
    extractConcreteManagedModelIdFromSessionStore(config) ||
    extractConcreteManagedModelIdFromConfig(config);
  const gatewayToken =
    isPlainObject(config?.gateway) &&
    isPlainObject(config.gateway.auth) &&
    typeof config.gateway.auth.token === "string"
      ? config.gateway.auth.token.trim()
      : "";
  const dashboardUrl = gatewayToken
    ? `http://127.0.0.1:${LOCAL_DEFAULT_DASHBOARD_PORT}/#token=${gatewayToken}`
    : `http://127.0.0.1:${LOCAL_DEFAULT_DASHBOARD_PORT}`;
  const browserControlUrl = `http://127.0.0.1:${LOCAL_DEFAULT_BROWSER_CONTROL_PORT}/`;
  const baseUrl =
    typeof binding?.baseUrl === "string" && binding.baseUrl.trim()
      ? binding.baseUrl.trim()
      : isPlainObject(config?.models?.providers)
        ? Object.values(config.models.providers).find(
            (provider) => isPlainObject(provider) && typeof provider.baseUrl === "string" && provider.baseUrl.trim(),
          )?.baseUrl || ""
        : "";
  const logTail = readTail(LOCAL_BOOTSTRAP_LOG);
  const bootstrapLogUpdatedAt = readFileMtime(LOCAL_BOOTSTRAP_LOG);
  const progress = deriveLocalBootstrapProgress(logTail, {
    installed: runtime.installed,
    dashboardPortOpen,
    browserControlPortOpen,
  });
  const bindingMissingDuringBootstrap =
    !binding?.accountScopeId &&
    !binding?.workspaceId &&
    !binding?.deploymentId &&
    Boolean(dashboardPortOpen || browserControlPortOpen) &&
    Boolean(bootstrapLogUpdatedAt) &&
    Date.now() - bootstrapLogUpdatedAt < 3 * 60 * 1000 &&
    ["runtime-download", "runtime-install", "runtime-detected", "onboarding", "service-start", "working"].includes(
      progress.stage,
    );

  return {
    ok: runtime.ok,
    installed: runtime.installed,
    binaryPath: runtime.binaryPath,
    version: runtime.version,
    dashboardPortOpen,
    browserControlPortOpen,
    ready: dashboardPortOpen && browserControlPortOpen && !bindingMissingDuringBootstrap,
    logPath: LOCAL_BOOTSTRAP_LOG,
    error: runtime.error,
    bootstrapStage: progress.stage,
    bootstrapMessage: progress.message,
    bootstrapLastLine: progress.lastLine,
    bootstrapProgressPercent:
      typeof progress.progressPercent === "number" ? progress.progressPercent : null,
    bootstrapProgressDetail:
      typeof progress.progressDetail === "string" ? progress.progressDetail : "",
    bootstrapLogUpdatedAt,
    bindingMissingDuringBootstrap,
    localDeviceId: localDeviceIdentity.deviceId,
    localDeviceLabel: localDeviceIdentity.deviceLabel,
    accountScopeId:
      typeof binding?.accountScopeId === "string" && binding.accountScopeId
        ? binding.accountScopeId
        : typeof binding?.ownerAccountScopeId === "string" && binding.ownerAccountScopeId
          ? binding.ownerAccountScopeId
          : typeof binding?.workspaceId === "string"
            ? binding.workspaceId
            : "",
    workspaceId: typeof binding?.workspaceId === "string" ? binding.workspaceId : "",
    deploymentId: typeof binding?.deploymentId === "string" ? binding.deploymentId : "",
    bindingLocalDeviceId:
      typeof binding?.localDeviceId === "string" ? binding.localDeviceId : "",
    bindingLocalDeviceLabel:
      typeof binding?.localDeviceLabel === "string" ? binding.localDeviceLabel : "",
    localApiKeyConfigured,
    currentModelId,
    ownerAccountScopeId:
      typeof binding?.ownerAccountScopeId === "string" && binding.ownerAccountScopeId
        ? binding.ownerAccountScopeId
        : typeof binding?.accountScopeId === "string" && binding.accountScopeId
          ? binding.accountScopeId
        : typeof binding?.workspaceId === "string"
          ? binding.workspaceId
          : "",
    ownerUserId: typeof binding?.ownerUserId === "string" ? binding.ownerUserId : "",
    ownerDisplayName:
      typeof binding?.ownerDisplayName === "string" ? binding.ownerDisplayName : "",
    ownerEmail: typeof binding?.ownerEmail === "string" ? binding.ownerEmail : "",
    authSyncedAt:
      typeof binding?.authSyncedAt === "string" && binding.authSyncedAt
        ? binding.authSyncedAt
        : typeof binding?.updatedAt === "string"
          ? binding.updatedAt
          : "",
    dashboardUrl,
    browserControlUrl,
    baseUrl,
    bindingUpdatedAt: typeof binding?.updatedAt === "string" ? binding.updatedAt : "",
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1560,
    height: 1040,
    minWidth: 1440,
    minHeight: 900,
    backgroundColor: "#f4efe7",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.XLB_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    return win;
  }

  const builtIndex = path.join(__dirname, "..", "app-dist", "index.html");
  if (fs.existsSync(builtIndex)) {
    win.loadFile(builtIndex);
    return win;
  }

  win.loadFile(path.join(__dirname, "..", "app", "index.html"));
  return win;
}

async function bootstrapLocalOpenClawPayload(payload) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return {
      ok: false,
      error: "当前一键本地部署仅支持 macOS 和 Windows。",
    };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.deploymentId !== "string" ||
    typeof payload.apiKey !== "string" ||
    typeof payload.baseUrl !== "string" ||
    typeof payload.modelId !== "string" ||
    typeof payload.providerId !== "string"
  ) {
    return {
      ok: false,
      error: "本地部署参数不完整。",
    };
  }

  const localDeviceIdentity = getOrCreateLocalDesktopDeviceIdentity();
  const localDeviceId =
    typeof payload.localDeviceId === "string" && payload.localDeviceId.trim()
      ? payload.localDeviceId.trim()
      : localDeviceIdentity.deviceId;
  const localDeviceLabel =
    typeof payload.localDeviceLabel === "string" && payload.localDeviceLabel.trim()
      ? payload.localDeviceLabel.trim()
      : localDeviceIdentity.deviceLabel;

  if (
    !payload.workspaceId.trim() ||
    !payload.deploymentId.trim() ||
    !payload.apiKey.trim() ||
    !payload.baseUrl.trim() ||
    !payload.modelId.trim() ||
    !payload.providerId.trim()
  ) {
    return {
      ok: false,
      error: "本地部署缺少模型密钥或网关参数，请重新一键部署。",
    };
  }

  const normalizedPayload = {
    ...payload,
    modelId: normalizeManagedModelId(payload.modelId, {
      preferredModelId:
        (typeof payload.concreteModelId === "string" && payload.concreteModelId.trim()) ||
        (typeof payload.requestedModelId === "string" && payload.requestedModelId.trim()) ||
        "",
      existingConfig: readJsonFile(LOCAL_OPENCLAW_CONFIG_PATH),
      providerId: payload.providerId,
    }),
  };

  let launcherPath = "";
  try {
    await stopLocalOpenClaw({ clearBinding: false });

    const preparedPayload = await prepareLocalGatewayTunnelPayload(normalizedPayload);
    if (!preparedPayload.ok) {
      return {
        ok: false,
        logPath: LOCAL_BOOTSTRAP_LOG,
        error: preparedPayload.error || "本地 SSH 隧道启动失败。",
      };
    }
    const effectivePayload = preparedPayload.payload;

    launcherPath = createLocalBootstrapScript({
      ...effectivePayload,
      gatewayPort: Number(effectivePayload.gatewayPort || LOCAL_DEFAULT_DASHBOARD_PORT),
      browserControlPort: Number(
        effectivePayload.browserControlPort || LOCAL_DEFAULT_BROWSER_CONTROL_PORT,
      ),
      gatewayBind: effectivePayload.gatewayBind || "loopback",
    });

    if (IS_WINDOWS) {
      await runSpawnCapture(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          launcherPath,
        ],
        {
          env: {
            ...process.env,
            PATH: buildLocalRuntimePath(),
          },
        },
      );
    } else {
      await runSpawnCapture("/bin/bash", [launcherPath], {
        env: {
          ...process.env,
          PATH: buildLocalRuntimePath(),
        },
      });
    }

    const ensuredAuthState = ensureLocalOpenClawAuthState(effectivePayload);
    if (!ensuredAuthState.ok) {
      return {
        ok: false,
        logPath: LOCAL_BOOTSTRAP_LOG,
        error: "本地部署后未能写入模型认证，请重新一键部署。",
      };
    }

    if (IS_WINDOWS) {
      const gatewayRestart = await restartLocalOpenClawGatewayService("bootstrap-auth-repair");
      if (!gatewayRestart.ok) {
        return {
          ok: false,
          logPath: LOCAL_BOOTSTRAP_LOG,
          error: "本地部署后未能重启本地网关，请重新修复本地部署。",
        };
      }
    }

    const status = await waitForStableLocalOpenClawStatus({
      timeoutMs: 15_000,
      requireReady: true,
      requireAuth: true,
    });
    return {
      ok: status.ready,
      logPath: LOCAL_BOOTSTRAP_LOG,
      dashboardUrl: payload.dashboardUrl,
      browserControlUrl: payload.browserControlUrl,
      status,
    };
  } catch (error) {
    return {
      ok: false,
      logPath: LOCAL_BOOTSTRAP_LOG,
      error: error instanceof Error ? error.message : "本地部署失败",
    };
  } finally {
    if (launcherPath) {
      removeFileIfExists(launcherPath);
      removeEmptyDirectory(path.dirname(launcherPath));
    }
  }
}

if (IS_DESKTOP_HELPER_MODE) {
  module.exports = {
    __helpers: {
      parseManagedTunnelCommand,
      buildManagedTunnelPortCandidates,
      isManagedTunnelRetryablePortError,
      detectLocalOpenClawRuntime,
      getLocalOpenClawStatus,
      syncLocalOpenClawAuthPayload,
      patchLocalOpenClawSessionModel,
      clearLocalOpenClawApiKeyState,
      stopLocalOpenClaw,
      uninstallLocalOpenClaw,
      bootstrapLocalOpenClawPayload,
    },
  };
} else {
app.whenReady().then(async () => {
  ipcMain.handle("xiaolanbu:open-external", async (_event, targetUrl) => {
    if (typeof targetUrl !== "string" || !targetUrl.trim()) {
      return { ok: false };
    }

    await shell.openExternal(targetUrl);
    return { ok: true };
  });

  ipcMain.handle("xiaolanbu:copy-text", (_event, value) => {
    if (typeof value !== "string") {
      return { ok: false };
    }

    clipboard.writeText(value);
    return { ok: true };
  });

  ipcMain.handle("xiaolanbu:launch-command", async (_event, command) => {
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, error: "invalid-command" };
    }

    launchInTerminal(command);
    return { ok: true };
  });

  ipcMain.handle("xiaolanbu:launch-tunnel", async (_event, command, password) => {
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, error: "invalid-command" };
    }

    try {
      return await startManagedCloudTunnel(command, password);
    } catch (error) {
      return {
        ok: false,
        code: typeof error?.code === "string" ? error.code : "launch-failed",
        error: formatManagedTunnelError(error),
      };
    }
  });

  ipcMain.handle("xiaolanbu:get-tunnel-status", async () => {
    const [dashboardPortOpen, browserControlPortOpen] = await Promise.all([
      checkLocalPortOpen(CLOUD_TUNNEL_LOCAL_DASHBOARD_PORT),
      checkLocalPortOpen(CLOUD_TUNNEL_LOCAL_BROWSER_CONTROL_PORT),
    ]);
    const managedConnected =
      managedCloudTunnelState.connected && dashboardPortOpen && browserControlPortOpen;
    const activeTunnel = managedConnected
      ? {
          host: managedCloudTunnelState.host,
          pid: process.pid,
        }
      : listActiveTunnelProcesses()[0] ?? null;

    return {
      ok: true,
      dashboardPortOpen,
      browserControlPortOpen,
      connected: managedConnected || Boolean(activeTunnel && dashboardPortOpen && browserControlPortOpen),
      host: activeTunnel?.host ?? "",
      pid: activeTunnel?.pid ?? null,
      managed: managedConnected,
      port: managedConnected ? managedCloudTunnelState.port : null,
      lastError: managedConnected ? "" : managedCloudTunnelState.lastError,
      dashboardPort: CLOUD_TUNNEL_LOCAL_DASHBOARD_PORT,
      browserControlPort: CLOUD_TUNNEL_LOCAL_BROWSER_CONTROL_PORT,
    };
  });

  ipcMain.handle("xiaolanbu:stop-tunnel", async () => {
    const activeTunnels = listActiveTunnelProcesses();
    const stoppedHosts = [];

    if (managedCloudTunnelState.connected || managedCloudTunnelState.host) {
      if (managedCloudTunnelState.host) {
        stoppedHosts.push(managedCloudTunnelState.host);
      }
      await teardownManagedCloudTunnel("cloud tunnel stopped");
    }

    if (activeTunnels.length > 0) {
      killTunnelProcesses(activeTunnels);
      stoppedHosts.push(
        ...activeTunnels.map((processInfo) => processInfo.host).filter(Boolean),
      );
    }

    return {
      ok: true,
      stopped: stoppedHosts.length > 0,
      hosts: Array.from(new Set(stoppedHosts)),
    };
  });

  ipcMain.handle("xiaolanbu:detect-local-openclaw", async () => {
    return detectLocalOpenClawRuntime();
  });

  ipcMain.handle("xiaolanbu:get-local-openclaw-status", async () => {
    return getLocalOpenClawStatus();
  });

  ipcMain.handle("xiaolanbu:sync-local-openclaw-auth", async (_event, payload) => {
    return syncLocalOpenClawAuthPayload(payload);
  });

  ipcMain.handle("xiaolanbu:clear-local-openclaw-api-key", async () => {
    return clearLocalOpenClawApiKeyState();
  });

  ipcMain.handle("xiaolanbu:reset-local-openclaw", async (_event, options) => {
    return stopLocalOpenClaw(options);
  });

  ipcMain.handle("xiaolanbu:uninstall-local-openclaw", async () => {
    return uninstallLocalOpenClaw();
  });

  ipcMain.handle("xiaolanbu:bootstrap-local-openclaw", async (_event, payload) => {
    return bootstrapLocalOpenClawPayload(payload);
  });

  ipcMain.handle("xiaolanbu:get-gateway-chat-history", async (_event, payload) => {
    return fetchGatewayChatHistory(payload);
  });

  ipcMain.handle("xiaolanbu:get-gateway-sessions", async (_event, payload) => {
    return fetchGatewaySessions(payload);
  });

  ipcMain.handle("xiaolanbu:patch-local-openclaw-session-model", async (_event, payload) => {
    return patchLocalOpenClawSessionModel(payload);
  });

  ipcMain.handle("xiaolanbu:abort-gateway-chat", async (_event, payload) => {
    return abortGatewayChat(payload);
  });

  ipcMain.on("xiaolanbu:start-gateway-chat-message", (event, payload) => {
    void sendGatewayChatMessage(event.sender, payload).catch((error) => {
      const requestId =
        typeof payload?.requestId === "string" && payload.requestId.trim()
          ? payload.requestId.trim()
          : createGatewayRequestId();
      const runId =
        typeof payload?.runId === "string" && payload.runId.trim()
          ? payload.runId.trim()
          : "";
      const sessionKey =
        typeof payload?.sessionKey === "string" && payload.sessionKey.trim()
          ? payload.sessionKey.trim()
          : "main";
      sendGatewayChatFrame(event.sender, {
        requestId,
        event: "chat",
        payload: {
          state: "error",
          errorMessage: error instanceof Error ? error.message : "消息发送失败。",
        },
        seq: null,
        stateVersion: null,
        sessionKey,
        runId,
        receivedAt: Date.now(),
      });
    });
  });

  ipcMain.handle("xiaolanbu:send-gateway-chat-message", async (event, payload) => {
    return sendGatewayChatMessage(event.sender, payload);
  });

  ipcMain.handle("xiaolanbu:save-markdown-export", async (_event, payload) => {
    return saveMarkdownExport(payload);
  });

  const win = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
