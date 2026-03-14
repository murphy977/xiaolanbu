#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="${XLB_RUNTIME_DIST_DIR:-$ROOT_DIR/runtime-dist}"
TARGET_HOST="${XLB_RUNTIME_TARGET_HOST:-}"
TARGET_USER="${XLB_RUNTIME_TARGET_USER:-root}"
TARGET_PORT="${XLB_RUNTIME_TARGET_PORT:-22}"
TARGET_PATH="${XLB_RUNTIME_TARGET_PATH:-/root/xiaolanbu/runtime-dist}"

if [[ -z "$TARGET_HOST" ]]; then
  echo "Missing XLB_RUNTIME_TARGET_HOST" >&2
  exit 1
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Runtime dist directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi

if command -v rsync >/dev/null 2>&1; then
  echo "Publishing runtime-dist with rsync to ${TARGET_USER}@${TARGET_HOST}:${TARGET_PATH}"
  rsync -av --delete -e "ssh -p ${TARGET_PORT}" "$SOURCE_DIR"/ "${TARGET_USER}@${TARGET_HOST}:${TARGET_PATH}/"
  exit 0
fi

echo "rsync not found, falling back to scp"
ssh -p "$TARGET_PORT" "${TARGET_USER}@${TARGET_HOST}" "mkdir -p '$TARGET_PATH'"
scp -P "$TARGET_PORT" "$SOURCE_DIR"/* "${TARGET_USER}@${TARGET_HOST}:$TARGET_PATH/"
