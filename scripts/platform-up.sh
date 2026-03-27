#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_DIR="$ROOT_DIR/deploy/single-node"

API_REPLICAS="${XLB_PLATFORM_API_REPLICAS:-2}"
WORKER_REPLICAS="${XLB_PLATFORM_WORKER_REPLICAS:-2}"
LITELLM_REPLICAS="${XLB_PLATFORM_LITELLM_REPLICAS:-2}"

echo "[xiaolanbu-platform] compose_dir=$COMPOSE_DIR api=$API_REPLICAS worker=$WORKER_REPLICAS litellm=$LITELLM_REPLICAS"

cd "$COMPOSE_DIR"
docker compose build api worker
docker compose up -d \
  --scale api="$API_REPLICAS" \
  --scale worker="$WORKER_REPLICAS" \
  --scale litellm="$LITELLM_REPLICAS"
docker compose ps
