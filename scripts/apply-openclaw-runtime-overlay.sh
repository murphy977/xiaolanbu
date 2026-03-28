#!/usr/bin/env bash
set -euo pipefail

REFERENCE_ROOT="${1:-}"
TARGET_ROOT="${2:-}"

if [[ -z "$REFERENCE_ROOT" || -z "$TARGET_ROOT" ]]; then
  echo "Usage: $0 <reference-runtime-root> <target-runtime-root>" >&2
  exit 1
fi

if [[ ! -d "$REFERENCE_ROOT" ]]; then
  echo "Reference runtime root does not exist: $REFERENCE_ROOT" >&2
  exit 1
fi

if [[ ! -d "$TARGET_ROOT" ]]; then
  echo "Target runtime root does not exist: $TARGET_ROOT" >&2
  exit 1
fi

find_single_bundle_file() {
  local root="$1"
  find "$root" -type f -path '*/openclaw/dist/pi-embedded-*.js' | head -n 1
}

SOURCE_FILE="$(find_single_bundle_file "$REFERENCE_ROOT")"
TARGET_FILE="$(find_single_bundle_file "$TARGET_ROOT")"

if [[ -z "$SOURCE_FILE" || ! -f "$SOURCE_FILE" ]]; then
  echo "Reference runtime is missing pi-embedded bundle under $REFERENCE_ROOT" >&2
  exit 1
fi

if [[ -z "$TARGET_FILE" || ! -f "$TARGET_FILE" ]]; then
  echo "Target runtime is missing pi-embedded bundle under $TARGET_ROOT" >&2
  exit 1
fi

cp "$SOURCE_FILE" "$TARGET_FILE"

echo "Applied OpenClaw runtime overlay:"
echo "  source: $SOURCE_FILE"
echo "  target: $TARGET_FILE"
