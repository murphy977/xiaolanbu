const { app, BrowserWindow, clipboard, ipcMain, shell } = require("electron");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const LOCAL_LOG_DIR = path.join(os.homedir(), "Library", "Logs", "Xiaolanbu");
const LOCAL_BOOTSTRAP_LOG = path.join(LOCAL_LOG_DIR, "local-bootstrap.log");
const LOCAL_DEFAULT_DASHBOARD_PORT = 18789;
const LOCAL_DEFAULT_BROWSER_CONTROL_PORT = 18791;

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
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
    const result = await runSpawnCapture("/bin/bash", [
      "-lc",
      [
        "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH",
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
    const version =
      result.stdout
        .split("\n")
        .find((line) => line.startsWith("VERSION="))
        ?.replace(/^VERSION=/, "")
        .trim() ?? "";

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

function createLocalBootstrapScript(payload) {
  const {
    apiKey,
    providerId,
    baseUrl,
    modelId,
    gatewayPort,
    gatewayBind,
    gatewayToken,
    browserControlPort,
  } = payload;

  ensureDirectory(LOCAL_LOG_DIR);

  const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaolanbu-local-"));
  const launcherPath = path.join(launcherDir, "bootstrap-local-openclaw.sh");
  const script = `#!/bin/bash
set -euo pipefail
exec > >(tee -a ${shellEscape(LOCAL_BOOTSTRAP_LOG)}) 2>&1

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
export HOME=${shellEscape(os.homedir())}
export USER=${shellEscape(os.userInfo().username)}
export LOGNAME=${shellEscape(os.userInfo().username)}
export OPENCLAW_API_KEY=${shellEscape(apiKey)}

echo "[xiaolanbu-local] bootstrap started at $(date -Is)"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[xiaolanbu-local] openclaw not found, installing runtime"
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[xiaolanbu-local] openclaw installation did not expose binary on PATH"
  exit 1
fi

echo "[xiaolanbu-local] using openclaw at $(command -v openclaw)"
echo "[xiaolanbu-local] running onboard"

openclaw onboard \\
  --non-interactive \\
  --accept-risk \\
  --mode local \\
  --auth-choice custom-api-key \\
  --custom-provider-id ${shellEscape(providerId)} \\
  --custom-base-url ${shellEscape(baseUrl)} \\
  --custom-model-id ${shellEscape(modelId)} \\
  --custom-compatibility openai \\
  --gateway-port ${String(gatewayPort)} \\
  --gateway-bind ${shellEscape(gatewayBind)} \\
  --gateway-auth token \\
  --gateway-token ${shellEscape(gatewayToken)} \\
  --install-daemon \\
  --skip-ui \\
  --skip-channels \\
  --skip-skills \\
  --skip-search

echo "[xiaolanbu-local] waiting for ports ${String(gatewayPort)} and ${String(browserControlPort)}"
for _ in $(seq 1 45); do
  if lsof -n -iTCP:${String(gatewayPort)} -sTCP:LISTEN >/dev/null 2>&1 && lsof -n -iTCP:${String(
    browserControlPort,
  )} -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[xiaolanbu-local] local gateway is ready"
    echo "[xiaolanbu-local] bootstrap finished at $(date -Is)"
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
  if (typeof command !== "string") {
    return "";
  }

  const match = command.match(/\broot@([0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/);
  return match?.[1] ?? "";
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
          !command.includes("-L 18789:127.0.0.1:18789") ||
          !command.includes("-L 18791:127.0.0.1:18791")
        ) {
          return null;
        }

        return {
          pid,
          command,
          host: extractTunnelHost(command),
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

  return {
    ok: runtime.ok,
    installed: runtime.installed,
    binaryPath: runtime.binaryPath,
    version: runtime.version,
    dashboardPortOpen,
    browserControlPortOpen,
    ready: dashboardPortOpen,
    logPath: LOCAL_BOOTSTRAP_LOG,
    error: runtime.error,
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
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
    return;
  }

  const builtIndex = path.join(__dirname, "..", "app-dist", "index.html");
  if (fs.existsSync(builtIndex)) {
    win.loadFile(builtIndex);
    return;
  }

  win.loadFile(path.join(__dirname, "..", "app", "index.html"));
}

app.whenReady().then(() => {
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

    const normalizedCommand = normalizeTunnelCommand(command);
    const targetHost = extractTunnelHost(normalizedCommand);
    const activeTunnels = listActiveTunnelProcesses();
    const sameHostTunnel = targetHost
      ? activeTunnels.find((processInfo) => processInfo.host === targetHost)
      : null;

    if (sameHostTunnel) {
      return { ok: true, automated: true, alreadyRunning: true, host: targetHost };
    }

    if (activeTunnels.length > 0) {
      killTunnelProcesses(activeTunnels);
    }

    if (typeof password === "string" && password.trim() && process.platform !== "win32") {
      const launcherPath = createTunnelLauncherScript(normalizedCommand, password.trim());
      launchDetached("/bin/bash", [launcherPath]);
      return { ok: true, automated: true, host: targetHost, replacedExisting: activeTunnels.length > 0 };
    }

    launchInTerminal(normalizedCommand);
    return { ok: true, automated: false, host: targetHost, replacedExisting: activeTunnels.length > 0 };
  });

  ipcMain.handle("xiaolanbu:get-tunnel-status", async () => {
    const [dashboardPortOpen, browserControlPortOpen] = await Promise.all([
      checkLocalPortOpen(18789),
      checkLocalPortOpen(18791),
    ]);
    const activeTunnels = listActiveTunnelProcesses();
    const activeTunnel = activeTunnels[0] ?? null;

    return {
      ok: true,
      dashboardPortOpen,
      browserControlPortOpen,
      connected: dashboardPortOpen,
      host: activeTunnel?.host ?? "",
      pid: activeTunnel?.pid ?? null,
    };
  });

  ipcMain.handle("xiaolanbu:stop-tunnel", async () => {
    const activeTunnels = listActiveTunnelProcesses();
    if (activeTunnels.length === 0) {
      return { ok: true, stopped: false };
    }

    killTunnelProcesses(activeTunnels);
    return {
      ok: true,
      stopped: true,
      hosts: activeTunnels.map((processInfo) => processInfo.host).filter(Boolean),
    };
  });

  ipcMain.handle("xiaolanbu:detect-local-openclaw", async () => {
    return detectLocalOpenClawRuntime();
  });

  ipcMain.handle("xiaolanbu:get-local-openclaw-status", async () => {
    return getLocalOpenClawStatus();
  });

  ipcMain.handle("xiaolanbu:bootstrap-local-openclaw", async (_event, payload) => {
    if (process.platform !== "darwin") {
      return {
        ok: false,
        error: "当前一键本地部署仅支持 macOS。",
      };
    }

    if (
      !payload ||
      typeof payload !== "object" ||
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

    try {
      const launcherPath = createLocalBootstrapScript({
        ...payload,
        gatewayPort: Number(payload.gatewayPort || LOCAL_DEFAULT_DASHBOARD_PORT),
        browserControlPort: Number(
          payload.browserControlPort || LOCAL_DEFAULT_BROWSER_CONTROL_PORT,
        ),
        gatewayBind: payload.gatewayBind || "loopback",
      });

      await runSpawnCapture("/bin/bash", [launcherPath], {
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}`,
        },
      });

      const status = await getLocalOpenClawStatus();
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
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
