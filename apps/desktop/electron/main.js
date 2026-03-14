const { app, BrowserWindow, clipboard, ipcMain, shell } = require("electron");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const LOCAL_APP_SUPPORT_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Xiaolanbu",
);
const LOCAL_LOG_DIR = path.join(os.homedir(), "Library", "Logs", "Xiaolanbu");
const LOCAL_BOOTSTRAP_LOG = path.join(LOCAL_LOG_DIR, "local-bootstrap.log");
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
const LOCAL_DEFAULT_DASHBOARD_PORT = 18789;
const LOCAL_DEFAULT_BROWSER_CONTROL_PORT = 18791;
const LOCAL_MANAGED_RUNTIME_ROOT = path.join(LOCAL_APP_SUPPORT_DIR, "runtime", "openclaw");
const LOCAL_MANAGED_NODE_ROOT = path.join(LOCAL_MANAGED_RUNTIME_ROOT, "node");
const LOCAL_MANAGED_NODE_CURRENT = path.join(LOCAL_MANAGED_NODE_ROOT, "current");
const LOCAL_MANAGED_NPM_PREFIX = path.join(LOCAL_MANAGED_RUNTIME_ROOT, "npm-global");
const LOCAL_MANAGED_WRAPPER_BIN_DIR = path.join(LOCAL_MANAGED_RUNTIME_ROOT, "bin");
const LOCAL_MANAGED_CLAW_BIN = path.join(LOCAL_MANAGED_WRAPPER_BIN_DIR, "openclaw");
const LOCAL_MANAGED_NODE_BIN = path.join(LOCAL_MANAGED_NODE_CURRENT, "bin", "node");
const LOCAL_MANAGED_NPM_BIN = path.join(LOCAL_MANAGED_NODE_CURRENT, "bin", "npm");
const LOCAL_MANAGED_NODE_VERSION = "22.22.1";
const LOCAL_GATEWAY_TUNNEL_KEY_PATH = path.join(
  LOCAL_APP_SUPPORT_DIR,
  "keys",
  "xlb-gateway-tunnel",
);
const LOCAL_GATEWAY_TUNNEL_PORT = 43030;
const LOCAL_GATEWAY_TUNNEL_REMOTE_PORT = 3030;
const LOCAL_CLEAN_WORKSPACE_KEEP = new Set([
  ".git",
  ".gitignore",
  ".openclaw",
  "README.md",
  "readme.md",
]);

function getLocalManagedPathEntries() {
  return [
    LOCAL_MANAGED_WRAPPER_BIN_DIR,
    path.join(LOCAL_MANAGED_NPM_PREFIX, "bin"),
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
    .join(":");
}

function getShellScriptRuntimePathExpression() {
  return [...getLocalManagedPathEntries(), "$PATH"].filter(Boolean).join(":");
}

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

function renderLocalWorkspaceCleanupList() {
  return [...LOCAL_CLEAN_WORKSPACE_KEEP].map((name) => JSON.stringify(name)).join(", ");
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

function deriveLocalBootstrapProgress(logTail, runtime) {
  const normalizedTail = typeof logTail === "string" ? logTail.trim() : "";
  const lastLine = normalizedTail ? normalizedTail.split("\n").filter(Boolean).pop() ?? "" : "";

  if (runtime.dashboardPortOpen) {
    return {
      stage: "ready",
      message: "本地控制台已启动，可以直接开始聊天。",
      lastLine,
    };
  }

  if (!normalizedTail) {
    return {
      stage: runtime.installed ? "runtime-installed" : "idle",
      message: runtime.installed ? "运行时已安装，等待初始化。" : "尚未开始本地部署。",
      lastLine: "",
    };
  }

  const checks = [
    ["runtime-download", /downloading Xiaolanbu runtime bundle/i, "正在下载本地运行时包，首次部署通常需要几十秒。"],
    ["runtime-install", /installed Xiaolanbu runtime bundle/i, "运行时已下载完成，正在准备初始化环境。"],
    ["runtime-detected", /using packaged Xiaolanbu runtime|using existing OpenClaw/i, "已检测到本地运行时，正在初始化 OpenClaw。"],
    ["onboarding", /openclaw onboard/i, "正在初始化本地 OpenClaw 配置。"],
    ["service-start", /loading launch agent|bootstrap finished/i, "正在启动本地控制台服务。"],
  ];

  for (const [stage, pattern, message] of checks) {
    if (pattern.test(normalizedTail)) {
      return { stage, message, lastLine };
    }
  }

  return {
    stage: runtime.installed ? "runtime-installed" : "working",
    message: runtime.installed ? "运行时已安装，正在继续初始化。" : "正在准备本地部署环境。",
    lastLine,
  };
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

  try {
    const parsedBaseUrl = new URL(baseUrl);
    const isLoopbackHost =
      parsedBaseUrl.hostname === "127.0.0.1" ||
      parsedBaseUrl.hostname === "localhost" ||
      parsedBaseUrl.hostname === "::1";
    if (!isLoopbackHost && fs.existsSync(LOCAL_GATEWAY_TUNNEL_KEY_PATH)) {
      tunnelEnabled = true;
      tunnelHost = parsedBaseUrl.hostname;
      effectiveBaseUrl = `http://127.0.0.1:${String(LOCAL_GATEWAY_TUNNEL_PORT)}${parsedBaseUrl.pathname.replace(/\/$/, "") || ""}`;
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
export XLB_GATEWAY_TUNNEL_LOCAL_PORT=${shellEscape(String(LOCAL_GATEWAY_TUNNEL_PORT))}
export XLB_GATEWAY_TUNNEL_REMOTE_PORT=${shellEscape(String(LOCAL_GATEWAY_TUNNEL_REMOTE_PORT))}
export XLB_GATEWAY_TUNNEL_KEY=${shellEscape(LOCAL_GATEWAY_TUNNEL_KEY_PATH)}
export XLB_LOCAL_SESSIONS_DIR=${shellEscape(path.join(LOCAL_OPENCLAW_STATE_DIR, "agents", "main", "sessions"))}

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

download_file() {
  local url="$1"
  local output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 --retry-connrefused -o "$output" "$url"
    return
  fi
  wget -q --tries=3 --timeout=20 -O "$output" "$url"
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
  if [[ "$XLB_GATEWAY_TUNNEL_ENABLED" != "1" ]]; then
    return 0
  fi

  if [[ -z "$XLB_GATEWAY_TUNNEL_HOST" ]]; then
    log "gateway tunnel requested but no host was provided"
    exit 1
  fi

  if [[ ! -f "$XLB_GATEWAY_TUNNEL_KEY" ]]; then
    log "gateway tunnel key is missing at $XLB_GATEWAY_TUNNEL_KEY"
    exit 1
  fi

  chmod 600 "$XLB_GATEWAY_TUNNEL_KEY" 2>/dev/null || true

  local existing_pids=""
  existing_pids="$(lsof -tiTCP:"$XLB_GATEWAY_TUNNEL_LOCAL_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$existing_pids" ]]; then
    log "reusing existing Xiaolanbu gateway tunnel on 127.0.0.1:$XLB_GATEWAY_TUNNEL_LOCAL_PORT"
    return 0
  fi

  log "starting Xiaolanbu gateway tunnel to $XLB_GATEWAY_TUNNEL_HOST:$XLB_GATEWAY_TUNNEL_REMOTE_PORT"
  ssh -f -N \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -i "$XLB_GATEWAY_TUNNEL_KEY" \
    -L "$XLB_GATEWAY_TUNNEL_LOCAL_PORT":127.0.0.1:"$XLB_GATEWAY_TUNNEL_REMOTE_PORT" \
    root@"$XLB_GATEWAY_TUNNEL_HOST"

  for _ in $(seq 1 15); do
    if lsof -n -iTCP:"$XLB_GATEWAY_TUNNEL_LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      log "Xiaolanbu gateway tunnel is ready on 127.0.0.1:$XLB_GATEWAY_TUNNEL_LOCAL_PORT"
      return 0
    fi
    sleep 1
  done

  log "Xiaolanbu gateway tunnel did not become ready in time"
  exit 1
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

if [[ -d "$XLB_LOCAL_SESSIONS_DIR" ]]; then
  rm -rf "$XLB_LOCAL_SESSIONS_DIR"
fi
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
  --skip-channels \\
  --skip-skills \\
  --skip-search \\
  --workspace ${shellEscape(localWorkspaceDir)}

if [[ -x "$XLB_MANAGED_NODE_BIN" && -f "$OPENCLAW_CONFIG_PATH" ]]; then
  "$XLB_MANAGED_NODE_BIN" <<'EOF'
const fs = require("fs");
const path = require("path");
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const agentDir = process.env.XLB_LOCAL_AGENT_DIR;
const workspaceDir = process.env.XLB_LOCAL_WORKSPACE_DIR;
const apiKey = process.env.OPENCLAW_API_KEY;
const providerId = ${JSON.stringify(providerId)};
if (!configPath || !workspaceDir) {
  process.exit(0);
}
const raw = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(raw);
config.models ||= {};
config.models.providers ||= {};
const ensureProviderConfig = (id) => {
  config.models.providers[id] ||= {};
  config.models.providers[id].api = "openai-completions";
  config.models.providers[id].apiKey = apiKey;
  config.models.providers[id].baseUrl =
    process.env.XLB_GATEWAY_BASE_URL || ${JSON.stringify(effectiveBaseUrl)};
  config.models.providers[id].models ||= [];
  if (config.models.providers[id].models.length === 0) {
    config.models.providers[id].models.push({ id: ${JSON.stringify(modelId)} });
  }
  for (const model of config.models.providers[id].models) {
    if (model && typeof model === "object") {
      model.contextWindow = Math.max(Number(model.contextWindow || 0), 262144);
      model.maxTokens = Math.max(Number(model.maxTokens || 0), 8192);
      model.reasoning = false;
      model.compat ||= {};
      model.compat.supportsUsageInStreaming = false;
      model.compat.supportsStrictMode = false;
      model.compat.thinkingFormat = "qwen";
    }
  }
};
ensureProviderConfig(providerId);
if (providerId !== "openai") {
  ensureProviderConfig("openai");
}
config.agents ||= {};
config.agents.defaults ||= {};
config.agents.defaults.workspace = workspaceDir;
config.agents.defaults.skipBootstrap = true;
config.agents.defaults.bootstrapMaxChars = 256;
config.agents.defaults.bootstrapTotalMaxChars = 512;
config.agents.list = [
  {
    id: "main",
    default: true,
    workspace: workspaceDir,
    skills: [],
  },
];
config.auth ||= {};
config.auth.profiles ||= {};
config.auth.profiles[\`\${providerId}:default\`] = {
  provider: providerId,
  mode: "api_key",
};
if (providerId !== "openai") {
  config.auth.profiles["openai:default"] = {
    provider: "openai",
    mode: "api_key",
  };
}
config.skills ||= {};
config.skills.allowBundled = ["__xlb_none__"];
config.skills.limits ||= {};
config.skills.limits.maxSkillsInPrompt = 0;
config.skills.limits.maxSkillsPromptChars = 0;
config.tools = {
  profile: "minimal",
  deny: ["session_status"],
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");

if (agentDir && apiKey) {
  const authStorePath = path.join(agentDir, "auth-profiles.json");
  let store = { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
  if (fs.existsSync(authStorePath)) {
    try {
      store = JSON.parse(fs.readFileSync(authStorePath, "utf8"));
    } catch {}
  }
  store.version = 1;
  store.profiles ||= {};
  store.lastGood ||= {};
  store.usageStats ||= {};
  store.profiles[\`\${providerId}:default\`] = {
    type: "api_key",
    provider: providerId,
    key: apiKey,
  };
  store.lastGood[providerId] = \`\${providerId}:default\`;
  if (providerId !== "openai") {
    store.profiles["openai:default"] = {
      type: "api_key",
      provider: "openai",
      key: apiKey,
    };
    store.lastGood.openai = "openai:default";
  }
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(authStorePath, JSON.stringify(store, null, 2) + "\\n");
}

if (workspaceDir) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const keep = new Set([${renderLocalWorkspaceCleanupList()}]);
  for (const entry of fs.readdirSync(workspaceDir)) {
    if (keep.has(entry)) {
      continue;
    }
    fs.rmSync(path.join(workspaceDir, entry), { recursive: true, force: true });
  }
  const readmePath = path.join(workspaceDir, "README.md");
  const readme = [
    "# Xiaolanbu Local Chat",
    "",
    "This workspace is intentionally minimal.",
    "OpenClaw local chat should not preload persona, memory, or bootstrap files here.",
    "",
  ].join("\\n");
  fs.writeFileSync(readmePath, readme, "utf8");
}
EOF
fi

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
  const logTail = readTail(LOCAL_BOOTSTRAP_LOG);
  const progress = deriveLocalBootstrapProgress(logTail, {
    installed: runtime.installed,
    dashboardPortOpen,
  });

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
    bootstrapStage: progress.stage,
    bootstrapMessage: progress.message,
    bootstrapLastLine: progress.lastLine,
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
          PATH: buildLocalRuntimePath(),
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
