#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${XLB_RUNTIME_DIST_DIR:-$ROOT_DIR/runtime-dist}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PLATFORM="darwin"
RAW_ARCH="${1:-$(uname -m)}"
case "$RAW_ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *)
    echo "Unsupported macOS arch: $RAW_ARCH" >&2
    exit 1
    ;;
esac

NODE_VERSION="${NODE_VERSION:-22.22.1}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_DOWNLOAD_BASE="${NODE_DOWNLOAD_BASE:-https://registry.npmmirror.com/-/binary/node}"
OPENCLAW_SPEC="${OPENCLAW_SPEC:-openclaw@latest}"

mkdir -p "$DIST_DIR"

RUNTIME_ROOT="$WORK_DIR/openclaw-runtime"
NODE_ROOT="$RUNTIME_ROOT/node"
NODE_CURRENT="$NODE_ROOT/current"
NPM_PREFIX="$RUNTIME_ROOT/npm-global"
BIN_DIR="$RUNTIME_ROOT/bin"
NODE_ARCHIVE="$WORK_DIR/node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz"

echo "Preparing runtime bundle for ${PLATFORM}/${ARCH}"
echo "Downloading Node.js v${NODE_VERSION}"
curl -fsSL --retry 3 --retry-delay 1 -o "$NODE_ARCHIVE" \
  "$NODE_DOWNLOAD_BASE/v${NODE_VERSION}/node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz"

mkdir -p "$NODE_CURRENT" "$NPM_PREFIX" "$BIN_DIR"
tar -xzf "$NODE_ARCHIVE" -C "$NODE_CURRENT" --strip-components=1

export PATH="$NODE_CURRENT/bin:$PATH"
export NPM_CONFIG_PREFIX="$NPM_PREFIX"
export npm_config_prefix="$NPM_PREFIX"
export NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
export npm_config_registry="$NPM_REGISTRY"
export npm_config_update_notifier="false"
export npm_config_fund="false"
export npm_config_audit="false"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"

echo "Installing ${OPENCLAW_SPEC}"
"$NODE_CURRENT/bin/npm" install -g --force "$OPENCLAW_SPEC"

PACKAGE_JSON="$NPM_PREFIX/lib/node_modules/openclaw/package.json"
if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "Installed runtime is missing openclaw/package.json" >&2
  exit 1
fi

OPENCLAW_VERSION="$("$NODE_CURRENT/bin/node" -p "require('$PACKAGE_JSON').version")"
FILENAME="openclaw-runtime-${PLATFORM}-${ARCH}-openclaw-${OPENCLAW_VERSION}-node-${NODE_VERSION}.tar.gz"
OUTPUT_PATH="$DIST_DIR/$FILENAME"

cat > "$BIN_DIR/openclaw" <<EOF
#!/bin/bash
set -euo pipefail
RUNTIME_ROOT="\$(cd "\$(dirname "\$0")/.." && pwd)"
export PATH="\$RUNTIME_ROOT/node/current/bin:\$RUNTIME_ROOT/npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "\$RUNTIME_ROOT/node/current/bin/node" "\$RUNTIME_ROOT/npm-global/lib/node_modules/openclaw/openclaw.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/openclaw"

cat > "$RUNTIME_ROOT/runtime-manifest.json" <<EOF
{
  "platform": "${PLATFORM}",
  "arch": "${ARCH}",
  "openclawVersion": "${OPENCLAW_VERSION}",
  "nodeVersion": "${NODE_VERSION}",
  "builtAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

tar -czf "$OUTPUT_PATH" -C "$WORK_DIR" openclaw-runtime
SIZE_BYTES="$(stat -f%z "$OUTPUT_PATH")"
SHA256="$(shasum -a 256 "$OUTPUT_PATH" | awk '{print $1}')"

MANIFEST_PATH="$DIST_DIR/manifest.json"
export XLB_RUNTIME_MANIFEST_PATH="$MANIFEST_PATH"
export XLB_RUNTIME_PLATFORM="$PLATFORM"
export XLB_RUNTIME_ARCH="$ARCH"
export XLB_RUNTIME_OPENCLAW_VERSION="$OPENCLAW_VERSION"
export XLB_RUNTIME_NODE_VERSION="$NODE_VERSION"
export XLB_RUNTIME_FILENAME="$FILENAME"
export XLB_RUNTIME_SIZE_BYTES="$SIZE_BYTES"
export XLB_RUNTIME_SHA256="$SHA256"
node <<'EOF'
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
  generatedAt: new Date().toISOString()
};
let manifest = { generatedAt: new Date().toISOString(), packages: [] };
if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.packages)) {
    manifest.packages = [];
  }
}
manifest.generatedAt = new Date().toISOString();
manifest.packages = manifest.packages.filter((item) => !(item.platform === nextEntry.platform && item.arch === nextEntry.arch));
manifest.packages.push(nextEntry);
manifest.packages.sort((left, right) =>
  `${left.platform}-${left.arch}`.localeCompare(`${right.platform}-${right.arch}`),
);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
EOF

echo "Runtime bundle ready:"
echo "  $OUTPUT_PATH"
echo "  sha256: $SHA256"
