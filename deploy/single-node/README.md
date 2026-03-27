# Xiaolanbu Single-Node Production Baseline

This directory contains the current production baseline for one Alibaba Cloud ECS:

- `Postgres` as the source of truth
- `Redis + BullMQ` for background jobs
- dedicated `worker` process for deployment mutations and billing sync jobs
- `api-router` as the internal load balancer for scaled API replicas
- `Kong` in front of LiteLLM as the public gateway edge
- `Prometheus + Grafana + exporters` for single-node observability
- `Caddy` as the HTTPS ingress / TLS terminator

## Target Host

- Region: `cn-hongkong`
- System: Alibaba Cloud Linux
- Spec: `4C8G`
- Public IP: `47.86.38.197` (用于 SSH / 运维入口)

## Services

- `api`: Xiaolanbu NestJS backend on internal port `3030`
- `api-router`: Nginx load balancer for `api` replicas on internal port `8080`
- `worker`: BullMQ worker for deployment and billing background jobs
- `litellm`: centralized LLM gateway on internal port `4000`
- `kong`: public gateway edge in front of LiteLLM on internal port `8000`
- `redis`: queue + edge rate-limit shared state
- `postgres`: source of truth for app state and LiteLLM state
- `prometheus`: metrics store on host-local `127.0.0.1:9090`
- `grafana`: dashboards on host-local `127.0.0.1:3001`
- `node-exporter`, `cadvisor`, `postgres-exporter`, `redis-exporter`: platform telemetry
- `caddy`: reverse proxy / TLS ingress on ports `80` and `443`

The host-local `127.0.0.1:3030` debug port now lands on `api-router`, so it still works after scaling `api`.
External traffic should go through Caddy. LiteLLM is not exposed publicly anymore; external gateway traffic is:

- `Caddy -> Kong -> LiteLLM`

API traffic is now:

- `Caddy -> api-router -> api`

Routing:

- `https://api.xiaolanbu.com/*` -> `api-router:8080`
- `https://gateway.xiaolanbu.com/*` -> `kong:8000`
- `https://xiaolanbu.com/` -> Caddy health response

## Alibaba Linux bootstrap

Run on the server:

```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
docker version
```

If `docker compose` is unavailable, install the compose plugin:

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/download/v2.35.1/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

## Deploy

Copy the repo to the server, then:

```bash
cd /path/to/xiaolanbu/deploy/single-node
cp .env.example .env
vi .env
docker compose build api worker
docker compose up -d
docker compose ps
```

If you prefer to sync a deployment bundle from macOS, use the helper script so AppleDouble files do not get packed
into Grafana provisioning directories:

```bash
cd /Users/wusongsong/Projects/openclaw/xiaolanbu
npm run platform:bundle
```

## Required secrets in `.env`

- `ALIBABA_CLOUD_ACCESS_KEY_ID`
- `ALIBABA_CLOUD_ACCESS_KEY_SECRET`
- `XLB_UPSTREAM_OPENAI_API_KEY`
- `LITELLM_MASTER_KEY`
- `POSTGRES_PASSWORD`

Recommended platform envs:

- `XLB_SESSION_TTL_MS=2592000000`
- `XLB_SESSION_TOUCH_INTERVAL_MS=3600000`
- `XLB_SESSION_CLEANUP_INTERVAL_MS=900000`
- `XLB_BILLING_SYNC_LOCK_ID=18032026`
- `XLB_DEPLOYMENT_JOB_TIMEOUT_MS=900000`
- `XLB_DEPLOYMENT_JOB_CONCURRENCY=8`
- `XLB_BILLING_JOB_CONCURRENCY=20`
- `LITELLM_NUM_WORKERS=4`
- `LITELLM_KEEPALIVE_TIMEOUT=30`
- `LITELLM_MAX_REQUESTS_BEFORE_RESTART=5000`
- `XLB_PLATFORM_API_REPLICAS=2`
- `XLB_PLATFORM_WORKER_REPLICAS=2`
- `XLB_PLATFORM_LITELLM_REPLICAS=2`
- `PROMETHEUS_RETENTION_TIME=15d`
- `GRAFANA_ADMIN_USER=admin`
- `GRAFANA_ADMIN_PASSWORD=replace-me`

Queue / worker notes:

- API replicas enqueue deployment mutations and billing sync jobs into Redis
- worker consumes those jobs and executes the heavy mutation path
- if Redis is unavailable, readiness will show degraded state
- if you run more than one API replica, the billing auto-sync cycle is still single-leader because it uses a Postgres advisory lock
- API now exposes Prometheus-style metrics at `GET /v1/metrics`
- Kong now points to a health-checked LiteLLM upstream, so scaling `litellm` on the same host is a first-class path

## Smoke tests

Backend:

```bash
curl https://api.xiaolanbu.com/v1/health
curl https://api.xiaolanbu.com/v1/health/ready
```

Gateway edge:

```bash
curl https://gateway.xiaolanbu.com/v1/models \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
```

Redis / worker quick checks:

```bash
docker compose ps
docker compose logs --tail=100 api worker kong redis
curl http://127.0.0.1:3030/v1/health/ready
curl http://127.0.0.1:3030/v1/metrics
curl http://127.0.0.1:9090/-/ready
```

Observability:

```bash
curl -I http://127.0.0.1:3001/login
curl -I http://127.0.0.1:9090
```

## Next step

After this is up, the OpenClaw instance init flow should use:

- `base_url = https://gateway.xiaolanbu.com/v1`
- `api_key = your Xiaolanbu virtual key`

Do not write the real upstream API key into user instances.

## Upstream model wiring

The default upstream is now an OpenAI-compatible endpoint:

- `XLB_UPSTREAM_OPENAI_BASE_URL=https://api.aportal.ai/v1`
- `XLB_UPSTREAM_OPENAI_MODEL=gpt-5.2`
- `XLB_GATEWAY_MODEL=gpt-5.2`

If you want to switch models later, update `.env` and then restart `api` + `litellm`:

```bash
# Example:
# XLB_GATEWAY_MODEL_CATALOG=gpt-5.2@aportal,gpt-5.4@aportal,gpt-4o@aportal,qwen35-plus=qwen3.5-plus@qwen
docker compose up -d --build api
docker compose up -d litellm
```

## Rollout notes for the DB-first platform backend

This backend now treats Postgres as the source of truth for sessions, workspaces, deployments, and billing.
For the one-time rollout from the old singleton compatibility model, clear the legacy `current_user` row and old
sessions before switching traffic:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "DELETE FROM xlb_app_state WHERE key = 'current_user'; DELETE FROM xlb_sessions;"
docker compose up -d --build api
```

That forces a one-time re-login for existing desktop users.

## Scale out

After readiness is healthy on a single replica, the supported scale-up path on one ECS is:

```bash
bash scripts/platform-up.sh
```

Or directly:

```bash
docker compose up -d \
  --scale api=2 \
  --scale worker=2 \
  --scale litellm=2
```

Only one API replica will run the automatic billing sync cycle at a time because it now uses a Postgres advisory
leader lock. Deployment mutations are serialized per deployment id and executed through Redis/BullMQ. Because Caddy
now hits `api-router` and Kong now hits a health-checked LiteLLM upstream, both the API path and the gateway path can
spread across replicas on the same host.

This is a stronger single-node baseline, not an honest guarantee of internet-scale by itself. To truly claim `1000+`
concurrent users, you still need:

- gateway pressure testing
- external pressure testing from another machine instead of self-looping on the same host
- enough CPU / memory headroom for the replica counts you choose
- multiple ECS nodes or a container orchestrator if you also want failure isolation
- database backups + monitoring + alerting
- LiteLLM upstream throughput validation against your provider quota
- log aggregation and dashboards

Keep `XLB_GATEWAY_MODEL` and `XLB_UPSTREAM_OPENAI_MODEL` the same unless you intentionally want the
gateway-facing alias to differ from the real upstream model name.

Public HTTPS gateway mode is now the default. Keep:

```text
XLB_GATEWAY_TUNNEL_ENABLED=0
```

Then local one-click deployments on both macOS and Windows will connect to the public gateway directly and will not start an SSH tunnel.

## Suggested pressure test

After deploy, run a controlled benchmark against the public gateway:

```bash
XLB_LITELLM_MASTER_KEY=your-master-key bash scripts/run-loadtest.sh gateway-models
XLB_LITELLM_MASTER_KEY=your-master-key bash scripts/run-loadtest.sh gateway-chat
XLB_LITELLM_MASTER_KEY=your-master-key bash scripts/run-loadtest.sh litellm-models
bash scripts/run-loadtest.sh api-ready
```

Do not treat config refactor as throughput proof. Use real pressure test results as the acceptance gate.

For a cleaner single-host benchmark of the full ingress chain without public DNS/TLS loopback noise, use:

```bash
XLB_LITELLM_MASTER_KEY=your-master-key bash scripts/run-loadtest.sh gateway-models-local
XLB_LITELLM_MASTER_KEY=your-master-key bash scripts/run-loadtest.sh gateway-chat-local
```

These profiles hit `https://127.0.0.1` directly, disable local cert verification, and keep `Host: gateway.xiaolanbu.com`,
so they still cover:

- `Caddy -> Kong -> LiteLLM`

## Suggested single-node production shape

For a stronger one-machine baseline, start from:

- `api=2`
- `worker=2`
- `litellm=2`
- `kong=1`
- `postgres=1`
- `redis=1`

Watch these while pressure testing:

- Grafana at `127.0.0.1:3001`
- Prometheus at `127.0.0.1:9090`
- `docker stats`
- `curl http://127.0.0.1:3030/v1/health/ready`

If LiteLLM or the upstream provider becomes the bottleneck first, adding more API replicas will not help. Scale the
gateway path first, then the API path.

## Restricted tunnel account

If you use the restricted `xlb-tunnel` account for local deployments, update its
`authorized_keys` rule to allow forwarding directly to LiteLLM:

```text
permitopen="127.0.0.1:4000"
```
