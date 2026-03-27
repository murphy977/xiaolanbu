#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_PATH="${1:-/tmp/xiaolanbu-deploy-bundle.tar.gz}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

cd "$ROOT_DIR"

COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar \
  --exclude='.DS_Store' \
  --exclude='._*' \
  -czf "$OUTPUT_PATH" \
  deploy/single-node \
  scripts/platform-up.sh \
  scripts/run-loadtest.sh \
  package.json \
  README.md

echo "$OUTPUT_PATH"
