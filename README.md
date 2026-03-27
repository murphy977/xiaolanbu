# Xiaolanbu

`小懒布` is a standalone commercial product built around OpenClaw runtime.

This directory currently contains:

- `apps/desktop/` - Electron desktop app for end users
- `apps/api/` - NestJS backend API for auth, billing, deployments, runtime distribution, and gateway control
- `deploy/single-node/` - current single-node production baseline using `Postgres + Redis + Worker + Kong + Caddy`

## Backend architecture

The backend is no longer the old in-memory MVP. The current baseline is:

- `Postgres` as source of truth for sessions, workspaces, deployments, wallets, usage ledger, and transactions
- `Redis + BullMQ` for deployment jobs and billing background work
- dedicated `worker` process for asynchronous job execution
- `api-router` as the internal API load balancer
- `LiteLLM` as upstream model gateway
- `Kong` as public gateway edge for request shaping and rate limiting
- `Prometheus + Grafana + exporters` for observability on the single host
- `Caddy` as HTTPS ingress

What this gives us:

- multi-replica-safe auth/session/workspace/deployment/billing state
- queue-backed heavy mutations instead of tying everything to one API process
- a stronger gateway edge than direct public LiteLLM exposure
- a real single-machine path to scale `api` and `litellm` replicas
- a path to horizontal scale without rewriting the client contract

## Run the backend locally

```bash
cd /Users/wusongsong/Projects/openclaw/xiaolanbu
npm --prefix apps/api install
npm run api:dev
npm --prefix apps/api run dev:worker
```

The API starts on `http://127.0.0.1:3030` by default. Important routes:

- `GET /v1/health`
- `GET /v1/health/ready`
- `GET /v1/auth/me`
- `PATCH /v1/auth/account-scope`
- `GET /v1/deployments`
- `POST /v1/deployments`
- `PATCH /v1/deployments/:deploymentId/status`
- `GET /v1/billing/me/wallet`
- `GET /v1/billing/me/usage?period=today`
- `GET /v1/billing/account/deployments/summary?period=today`

Current product semantics are account-first:

- billing ownership is the user account, not an individual workspace
- one account can have multiple deployments and virtual API keys under the same balance pool
- when balance is insufficient, reconciliation blocks every gateway key owned by that account
- `workspace` fields and routes are kept only for compatibility with older runtime/bootstrap data

Recommended API usage:

```bash
GET /v1/auth/me
PATCH /v1/auth/account-scope
GET /v1/deployments
GET /v1/billing/me/wallet
GET /v1/billing/account/usage?period=today
POST /v1/billing/account/reconcile
```

Create a deployment with the account scope explicitly attached:

```json
{
  "accountScopeId": "ws_main",
  "name": "my-local-agent",
  "mode": "local",
  "platform": "darwin"
}
```

Legacy compatibility notes:

- `PATCH /v1/auth/workspace` is still accepted, but it is deprecated
- `/v1/billing/workspaces/:workspaceId/*` routes are still accepted, but they are deprecated
- deprecated compatibility routes now return `Deprecation: true` and `X-Xiaolanbu-Legacy-Route: true`

## Deployment baseline

For the real server layout, use:

- [deploy/single-node/README.md](/Users/wusongsong/Projects/openclaw/xiaolanbu/deploy/single-node/README.md)

External traffic is designed as:

- `https://api.xiaolanbu.com/*` -> `Caddy -> api-router -> api`
- `https://gateway.xiaolanbu.com/*` -> `Caddy -> Kong -> LiteLLM`

The single-node baseline is much stronger than the earlier MVP, but it is still not a truthful promise of unlimited
capacity. To claim stable `1000+` concurrent usage, we still need pressure testing, monitoring, and likely multi-node deployment.

To scale the current single-node stack on the server:

```bash
cd /Users/wusongsong/Projects/openclaw/xiaolanbu
npm run platform:up
curl http://127.0.0.1:3030/v1/health/ready
curl http://127.0.0.1:9090/-/ready
```

## Real Aliyun ECS provisioning

Set credentials in the backend environment:

```bash
export ALIBABA_CLOUD_ACCESS_KEY_ID=your-ak
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=your-sk
```

Then call `POST /v1/deployments` with `mode=cloud`. Example:

```json
{
  "accountScopeId": "ws_main",
  "name": "prod-agent-01",
  "mode": "cloud",
  "region": "cn-hangzhou",
  "imageId": "m-bpxxxxxxxxxxxx",
  "instanceType": "ecs.g7.large",
  "securityGroupId": "sg-bpxxxxxxxxxxxx",
  "vSwitchId": "vsw-bpxxxxxxxxxxxx",
  "systemDiskCategory": "cloud_essd",
  "systemDiskSize": 40,
  "internetMaxBandwidthOut": 5,
  "password": "YourStrongPassword123!",
  "openclawApiKey": "sk-xxxx",
  "waitForRunning": true,
  "dryRun": true
}
```

Recommended production flow:

1. First send `dryRun: true` to precheck quotas and parameter validity.
2. Then send the same request with `dryRun: false`.
3. After getting instance IDs, poll `DescribeInstances` or `DescribeInstanceStatus` until the instance becomes `Running`.
4. Once running, continue with startup script execution, agent registration, and console URL binding.
