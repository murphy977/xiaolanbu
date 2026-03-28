#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${XLB_RUNTIME_DIST_DIR:-$ROOT_DIR/runtime-dist}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PLATFORM="win32"
RAW_ARCH="${1:-x64}"
case "$RAW_ARCH" in
  x64|amd64|x86_64) ARCH="x64" ;;
  *)
    echo "Unsupported Windows arch: $RAW_ARCH" >&2
    exit 1
    ;;
esac

NODE_VERSION="${NODE_VERSION:-22.22.1}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
NODE_DOWNLOAD_BASE="${NODE_DOWNLOAD_BASE:-https://nodejs.org/dist}"
OPENCLAW_SPEC="${OPENCLAW_SPEC:-openclaw@latest}"
HOST_NODE_BIN="${HOST_NODE_BIN:-$(command -v node)}"
HOST_NPM_BIN="${HOST_NPM_BIN:-$(command -v npm)}"
RUNTIME_REFERENCE_DIR="${XLB_RUNTIME_REFERENCE_DIR:-}"

if [[ -z "$HOST_NODE_BIN" || -z "$HOST_NPM_BIN" ]]; then
  echo "Host node/npm are required to build the Windows runtime bundle." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

RUNTIME_ROOT="$WORK_DIR/openclaw-runtime"
NODE_ROOT="$RUNTIME_ROOT/node"
NODE_CURRENT="$NODE_ROOT/current"
NPM_PREFIX="$RUNTIME_ROOT/npm-global"
BIN_DIR="$RUNTIME_ROOT/bin"
NODE_ARCHIVE="$WORK_DIR/node-v${NODE_VERSION}-win-${ARCH}.zip"

echo "Preparing runtime bundle for ${PLATFORM}/${ARCH}"
echo "Downloading Node.js v${NODE_VERSION}"
curl -fsSL --retry 3 --retry-delay 1 -o "$NODE_ARCHIVE" \
  "$NODE_DOWNLOAD_BASE/v${NODE_VERSION}/node-v${NODE_VERSION}-win-${ARCH}.zip"

mkdir -p "$NODE_ROOT" "$NPM_PREFIX" "$BIN_DIR"
python3 - <<PY
import pathlib, shutil, zipfile

archive = pathlib.Path(r"""$NODE_ARCHIVE""")
target_root = pathlib.Path(r"""$NODE_ROOT""")
extract_dir = pathlib.Path(r"""$WORK_DIR""") / "node-extract"
if extract_dir.exists():
    shutil.rmtree(extract_dir)
extract_dir.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as zf:
    zf.extractall(extract_dir)
extracted = next((p for p in extract_dir.iterdir() if p.is_dir() and p.name.startswith("node-")), None)
if extracted is None:
    raise SystemExit("failed to extract node win zip")
current = target_root / "current"
if current.exists():
    shutil.rmtree(current)
shutil.move(str(extracted), str(current))
shutil.rmtree(extract_dir, ignore_errors=True)
PY

export PATH="$(dirname "$HOST_NODE_BIN"):$PATH"
export NPM_CONFIG_PREFIX="$NPM_PREFIX"
export npm_config_prefix="$NPM_PREFIX"
export NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
export npm_config_registry="$NPM_REGISTRY"
export npm_config_update_notifier="false"
export npm_config_fund="false"
export npm_config_audit="false"
export npm_config_platform="win32"
export npm_config_arch="x64"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"

echo "Installing ${OPENCLAW_SPEC}"
"$HOST_NPM_BIN" install -g --force "$OPENCLAW_SPEC"

if [[ -n "$RUNTIME_REFERENCE_DIR" ]]; then
  "$ROOT_DIR/scripts/apply-openclaw-runtime-overlay.sh" "$RUNTIME_REFERENCE_DIR" "$RUNTIME_ROOT"
fi

PACKAGE_JSON="$NPM_PREFIX/node_modules/openclaw/package.json"
if [[ ! -f "$PACKAGE_JSON" ]]; then
  PACKAGE_JSON="$NPM_PREFIX/lib/node_modules/openclaw/package.json"
fi
if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "Installed runtime is missing openclaw/package.json" >&2
  exit 1
fi

OPENCLAW_VERSION="$("$HOST_NODE_BIN" -p "require('$PACKAGE_JSON').version")"
FILENAME="openclaw-runtime-${PLATFORM}-${ARCH}-openclaw-${OPENCLAW_VERSION}-node-${NODE_VERSION}.zip"
OUTPUT_PATH="$DIST_DIR/$FILENAME"

cat > "$BIN_DIR/openclaw.cmd" <<'EOF'
@echo off
setlocal
set "RUNTIME_ROOT=%~dp0.."
set "NODE_EXE=%RUNTIME_ROOT%\node\current\node.exe"
set "MODULE_ENTRY=%RUNTIME_ROOT%\npm-global\node_modules\openclaw\openclaw.mjs"
if not exist "%MODULE_ENTRY%" set "MODULE_ENTRY=%RUNTIME_ROOT%\npm-global\lib\node_modules\openclaw\openclaw.mjs"
if not exist "%MODULE_ENTRY%" (
  echo managed OpenClaw entry missing at %MODULE_ENTRY% 1>&2
  exit /b 1
)
set "PATH=%RUNTIME_ROOT%\bin;%RUNTIME_ROOT%\npm-global;%RUNTIME_ROOT%\node\current;%PATH%"
"%NODE_EXE%" "%MODULE_ENTRY%" %*
EOF

cat > "$RUNTIME_ROOT/runtime-manifest.json" <<EOF
{
  "platform": "${PLATFORM}",
  "arch": "${ARCH}",
  "openclawVersion": "${OPENCLAW_VERSION}",
  "nodeVersion": "${NODE_VERSION}",
  "builtAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

python3 - <<PY
import pathlib, shutil
root = pathlib.Path(r"""$WORK_DIR""")
output = pathlib.Path(r"""$OUTPUT_PATH""")
if output.exists():
    output.unlink()
archive_base = str(output.with_suffix(""))
generated = shutil.make_archive(archive_base, "zip", root_dir=root, base_dir="openclaw-runtime")
if pathlib.Path(generated) != output:
    pathlib.Path(generated).replace(output)
PY

SIZE_BYTES="$("$HOST_NODE_BIN" -p "require('node:fs').statSync(process.argv[1]).size" "$OUTPUT_PATH")"
SHA256="$("$HOST_NODE_BIN" -e "const fs=require('node:fs');const crypto=require('node:crypto');const file=process.argv[1];const hash=crypto.createHash('sha256');hash.update(fs.readFileSync(file));process.stdout.write(hash.digest('hex'));" "$OUTPUT_PATH")"

MANIFEST_PATH="$DIST_DIR/manifest.json"
export XLB_RUNTIME_MANIFEST_PATH="$MANIFEST_PATH"
export XLB_RUNTIME_PLATFORM="$PLATFORM"
export XLB_RUNTIME_ARCH="$ARCH"
export XLB_RUNTIME_OPENCLAW_VERSION="$OPENCLAW_VERSION"
export XLB_RUNTIME_NODE_VERSION="$NODE_VERSION"
export XLB_RUNTIME_FILENAME="$FILENAME"
export XLB_RUNTIME_SIZE_BYTES="$SIZE_BYTES"
export XLB_RUNTIME_SHA256="$SHA256"
"$HOST_NODE_BIN" <<'EOF'
const fs = require("fs");
const manifestPath = process.env.XLB_RUNTIME_MANIFEST_PATH;
const nextEntry = {
  platform: process.env.XLB_RUNTIME_PLATFORM,
  arch: process.env.XLB_RUNTIME_ARCH,
  openclawVersion: process.env.XLB_RUNTIME_OPENCLAW_VERSION,
  nodeVersion: process.env.XLB_RUNTIME_NODE_VERSION,
  filename: process.env.XLB_RUNTIME_FILENAME,
  sizeBytes: Number(process.env.XLB_RUNTIME_SIZE_BYTES || 0),
  sha256: process.env.XLB_RUNTIME_SHA256,
  generatedAt: new Date().toISOString(),
};
let manifest = { generatedAt: new Date().toISOString(), packages: [] };
if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.packages)) {
    manifest.packages = [];
  }
}
manifest.generatedAt = new Date().toISOString();
manifest.packages = manifest.packages.filter(
  (item) => !(item.platform === nextEntry.platform && item.arch === nextEntry.arch),
);
manifest.packages.push(nextEntry);
manifest.packages.sort((left, right) =>
  `${left.platform}-${left.arch}`.localeCompare(`${right.platform}-${right.arch}`),
);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
EOF

echo "Runtime bundle ready:"
echo "  $OUTPUT_PATH"
echo "  sha256: $SHA256"
