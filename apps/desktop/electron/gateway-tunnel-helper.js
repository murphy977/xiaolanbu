const fs = require("fs");
const net = require("net");
const path = require("path");
const { Client: SshClient } = require("ssh2");

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function appendLog(logPath, message, details = {}) {
  if (!logPath) {
    return;
  }

  try {
    ensureDirectory(path.dirname(logPath));
    const line = `[${new Date().toISOString()}] [xlb-gateway-helper] ${message} ${JSON.stringify(details)}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Ignore helper log failures.
  }
}

function readConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeState(statePath, payload) {
  ensureDirectory(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
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

function resolveSshPortCandidates(config) {
  const explicitCandidates = normalizePortCandidates(config?.sshPortCandidates, []);
  if (explicitCandidates.length > 0) {
    return explicitCandidates;
  }

  const legacySshPort = Number(config?.sshPort || 0);
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

function verifyRemotePort(client, remotePort) {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (error, stream) => {
      if (error) {
        reject(error);
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
        } catch {}
        try {
          stream.destroy();
        } catch {}
        callback();
      };

      stream.once("error", (streamError) => {
        finish(() => reject(streamError));
      });
      finish(resolve);
    });
  });
}

function createForwardServer(client, localPort, remotePort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      client.forwardOut(
        socket.remoteAddress || "127.0.0.1",
        socket.remotePort || 0,
        "127.0.0.1",
        remotePort,
        (error, stream) => {
          if (error) {
            socket.destroy(error);
            return;
          }

          socket.pipe(stream).pipe(socket);
          stream.once("error", () => socket.destroy());
          socket.once("error", () => {
            try {
              stream.end();
            } catch {}
          });
        },
      );
    });

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(localPort, "127.0.0.1", () => resolve(server));
  });
}

function connectSshClientOnce({ host, user, privateKey, sshPort }) {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let settled = false;

    const cleanup = () => {
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        client.end();
      } catch {}
      try {
        client.destroy();
      } catch {}
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onReady = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(client);
    };

    const onError = (error) => {
      fail(error);
    };

    const onClose = () => {
      fail(new Error(`ssh connection closed during connect on port ${sshPort}`));
    };

    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);

    try {
      client.connect({
        host,
        port: sshPort,
        username: user,
        privateKey,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      });
    } catch (error) {
      fail(error);
    }
  });
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("missing gateway tunnel config path");
  }

  const config = readConfig(configPath);
  const {
    host,
    user,
    localPort,
    remotePort,
    sshPort = 22,
    keyPath,
    statePath,
    logPath,
  } = config || {};

  if (!host || !user || !localPort || !remotePort || !keyPath || !statePath) {
    throw new Error("incomplete gateway tunnel config");
  }

  if (!fs.existsSync(keyPath)) {
    throw new Error(`gateway tunnel key not found: ${keyPath}`);
  }

  const privateKey = fs.readFileSync(keyPath, "utf8");
  const sshPortCandidates = resolveSshPortCandidates(config);
  let client = null;
  let servers = [];
  let closed = false;
  let attemptedSshPorts = [];
  let currentSshPort =
    Number.isFinite(Number(sshPort)) && Number(sshPort) > 0 ? Number(sshPort) : sshPortCandidates[0] || 22;
  let actualSshPort = null;

  const updateState = (overrides = {}) => {
    writeState(statePath, {
      pid: process.pid,
      host,
      user,
      localPort,
      remotePort,
      sshPort: actualSshPort || currentSshPort,
      actualSshPort,
      sshPortCandidates,
      attemptedSshPorts,
      status: "starting",
      startedAt: new Date().toISOString(),
      ...overrides,
    });
  };

  const shutdown = async (reason = "", exitCode = 0) => {
    if (closed) {
      return;
    }
    closed = true;

    appendLog(logPath, "gateway tunnel shutting down", {
      host,
      localPort,
      remotePort,
      sshPort: actualSshPort || currentSshPort,
      sshPortCandidates,
      attemptedSshPorts,
      reason,
      exitCode,
    });

    await Promise.all(servers.map((server) => closeServer(server)));
    servers = [];

    try {
      client?.end();
    } catch {}
    try {
      client?.destroy();
    } catch {}

    if (exitCode === 0) {
      try {
        fs.rmSync(statePath, { force: true });
      } catch {}
    } else {
      updateState({
        status: "error",
        lastError: reason || "gateway tunnel stopped unexpectedly",
        stoppedAt: new Date().toISOString(),
      });
    }

    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    shutdown("received SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    shutdown("received SIGTERM", 0);
  });
  process.on("uncaughtException", (error) => {
    appendLog(logPath, "gateway tunnel uncaught exception", {
      error: error instanceof Error ? error.message : String(error),
    });
    shutdown(error instanceof Error ? error.message : String(error), 1);
  });
  process.on("unhandledRejection", (error) => {
    appendLog(logPath, "gateway tunnel unhandled rejection", {
      error: error instanceof Error ? error.message : String(error),
    });
    shutdown(error instanceof Error ? error.message : String(error), 1);
  });

  updateState({
    status: "starting",
    lastError: "",
  });
  appendLog(logPath, "starting bundled gateway tunnel", {
    host,
    user,
    sshPort: currentSshPort,
    sshPortCandidates,
    localPort,
    remotePort,
  });

  let lastConnectError = null;
  for (const port of sshPortCandidates) {
    currentSshPort = port;
    attemptedSshPorts = Array.from(new Set([...attemptedSshPorts, port]));
    updateState({
      status: "starting",
      sshPort: port,
      actualSshPort: null,
      lastError: "",
    });
    appendLog(logPath, "trying bundled gateway tunnel ssh port", {
      host,
      user,
      sshPort: port,
      sshPortCandidates,
      localPort,
      remotePort,
    });

    try {
      client = await connectSshClientOnce({
        host,
        user,
        privateKey,
        sshPort: port,
      });
      actualSshPort = port;
      currentSshPort = port;
      break;
    } catch (error) {
      lastConnectError = error instanceof Error ? error : new Error(String(error));
      appendLog(logPath, "bundled gateway tunnel ssh connect failed", {
        host,
        user,
        sshPort: port,
        error: lastConnectError.message,
      });
    }
  }

  if (!client) {
    throw new Error(
      `本地 SSH 隧道无法连接远端网关，已尝试端口 ${sshPortCandidates.join(" -> ")}。${
        lastConnectError?.message ? `最后错误：${lastConnectError.message}` : ""
      }`,
    );
  }

  client.on("error", (error) => {
    appendLog(logPath, "gateway tunnel client error", {
      sshPort: actualSshPort || currentSshPort,
      error: error instanceof Error ? error.message : String(error),
    });
    shutdown(error instanceof Error ? error.message : String(error), 1);
  });

  client.on("close", () => {
    shutdown("ssh connection closed", 1);
  });

  try {
    await verifyRemotePort(client, remotePort);
    const server = await createForwardServer(client, localPort, remotePort);
    servers.push(server);
    updateState({
      status: "ready",
      connectedAt: new Date().toISOString(),
      sshPort: actualSshPort || currentSshPort,
      actualSshPort: actualSshPort || currentSshPort,
      lastError: "",
    });
    appendLog(logPath, "bundled gateway tunnel ready", {
      host,
      sshPort: actualSshPort || currentSshPort,
      sshPortCandidates,
      localPort,
      remotePort,
    });
  } catch (error) {
    shutdown(error instanceof Error ? error.message : String(error), 1);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
