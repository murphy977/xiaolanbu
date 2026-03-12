const { app, BrowserWindow, clipboard, ipcMain, shell } = require("electron");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

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
