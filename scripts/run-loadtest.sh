#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-api-ready}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${XLB_LOADTEST_REPORT_DIR:-$ROOT_DIR/loadtest-reports}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$REPORT_DIR"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: $name" >&2
    exit 1
  fi
}

URL=""
METHOD="GET"
CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-200}"
DURATION="${XLB_LOADTEST_DURATION:-30}"
PIPELINING="${XLB_LOADTEST_PIPELINING:-1}"
BODY=""
AUTH_HEADER=""
HOST_HEADER=""
CONTENT_TYPE_HEADER=""
INSECURE_TLS="0"

case "$PROFILE" in
  api-ready)
    URL="${XLB_API_LOADTEST_URL:-http://127.0.0.1:3030/v1/health/ready}"
    CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-500}"
    DURATION="${XLB_LOADTEST_DURATION:-30}"
    ;;
  api-metrics)
    URL="${XLB_API_LOADTEST_URL:-http://127.0.0.1:3030/v1/metrics}"
    CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-200}"
    DURATION="${XLB_LOADTEST_DURATION:-30}"
    ;;
  litellm-models)
    require_env XLB_LITELLM_MASTER_KEY
    URL="${XLB_LITELLM_LOADTEST_URL:-http://127.0.0.1:4000/v1/models}"
    CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-500}"
    DURATION="${XLB_LOADTEST_DURATION:-30}"
    AUTH_HEADER="Authorization: Bearer ${XLB_LITELLM_MASTER_KEY}"
    ;;
  gateway-models)
    require_env XLB_LITELLM_MASTER_KEY
    URL="${XLB_GATEWAY_LOADTEST_URL:-https://gateway.xiaolanbu.com/v1/models}"
    CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-500}"
    DURATION="${XLB_LOADTEST_DURATION:-30}"
    AUTH_HEADER="Authorization: Bearer ${XLB_LITELLM_MASTER_KEY}"
    ;;
  gateway-models-local)
    require_env XLB_LITELLM_MASTER_KEY
    URL="${XLB_GATEWAY_LOADTEST_URL:-https://127.0.0.1/v1/models}"
    CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-500}"
    DURATION="${XLB_LOADTEST_DURATION:-30}"
    AUTH_HEADER="Authorization: Bearer ${XLB_LITELLM_MASTER_KEY}"
    HOST_HEADER="${XLB_GATEWAY_LOADTEST_HOST_HEADER:-gateway.xiaolanbu.com}"
    INSECURE_TLS="1"
    ;;
  gateway-chat)
    require_env XLB_LITELLM_MASTER_KEY
    URL="${XLB_GATEWAY_LOADTEST_URL:-https://gateway.xiaolanbu.com/v1/chat/completions}"
    METHOD="POST"
    CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-50}"
    DURATION="${XLB_LOADTEST_DURATION:-20}"
    BODY='{"model":"gpt-5.2","messages":[{"role":"user","content":"reply with just pong"}],"temperature":0,"max_tokens":8}'
    AUTH_HEADER="Authorization: Bearer ${XLB_LITELLM_MASTER_KEY}"
    CONTENT_TYPE_HEADER="Content-Type: application/json"
    ;;
  gateway-chat-local)
    require_env XLB_LITELLM_MASTER_KEY
    URL="${XLB_GATEWAY_LOADTEST_URL:-https://127.0.0.1/v1/chat/completions}"
    METHOD="POST"
    CONNECTIONS="${XLB_LOADTEST_CONNECTIONS:-50}"
    DURATION="${XLB_LOADTEST_DURATION:-20}"
    BODY='{"model":"gpt-5.2","messages":[{"role":"user","content":"reply with just pong"}],"temperature":0,"max_tokens":8}'
    AUTH_HEADER="Authorization: Bearer ${XLB_LITELLM_MASTER_KEY}"
    CONTENT_TYPE_HEADER="Content-Type: application/json"
    HOST_HEADER="${XLB_GATEWAY_LOADTEST_HOST_HEADER:-gateway.xiaolanbu.com}"
    INSECURE_TLS="1"
    ;;
  *)
    echo "Unsupported profile: $PROFILE" >&2
    exit 1
    ;;
esac

REPORT_FILE="$REPORT_DIR/${TIMESTAMP}-${PROFILE}.json"
CMD="npm_config_loglevel=error npx autocannon@8 -j -m ${METHOD} -c ${CONNECTIONS} -d ${DURATION} -p ${PIPELINING}"

if [[ "$INSECURE_TLS" == "1" ]]; then
  CMD="NODE_TLS_REJECT_UNAUTHORIZED=0 ${CMD}"
fi

if [[ -n "$AUTH_HEADER" ]]; then
  CMD="${CMD} -H $(printf '%q' "$AUTH_HEADER")"
fi
if [[ -n "$HOST_HEADER" ]]; then
  CMD="${CMD} -H $(printf '%q' "Host: ${HOST_HEADER}")"
fi
if [[ -n "$CONTENT_TYPE_HEADER" ]]; then
  CMD="${CMD} -H $(printf '%q' "$CONTENT_TYPE_HEADER")"
fi
if [[ -n "$BODY" ]]; then
  CMD="${CMD} -b $(printf '%q' "$BODY")"
fi
CMD="${CMD} $(printf '%q' "$URL") > /out/$(basename "$REPORT_FILE")"

echo "Running profile=${PROFILE} url=${URL} connections=${CONNECTIONS} duration=${DURATION}s"
docker run --rm --network host \
  -v "$REPORT_DIR:/out" \
  node:20-bookworm-slim \
  sh -lc "$CMD"

echo "Report written to $REPORT_FILE"
cat "$REPORT_FILE"
