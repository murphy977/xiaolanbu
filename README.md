# Xiaolanbu

`小懒布` is a standalone commercial product built around OpenClaw runtime.

This directory currently contains:

- `apps/desktop/` - Electron desktop app for end users
- `apps/api/` - NestJS-based backend API skeleton for accounts, workspaces, deployments, and billing

## Run the backend

```bash
cd /Users/wusongsong/Projects/openclaw/xiaolanbu
npm --prefix apps/api install
npm run api:dev
```

The backend starts on `http://127.0.0.1:3030` by default with these initial routes:

- `GET /v1/health`
- `GET /v1/auth/me`
- `GET /v1/workspaces`
- `GET /v1/workspaces/ws_main`
- `GET /v1/deployments?workspaceId=ws_main`
- `POST /v1/deployments`
- `PATCH /v1/deployments/:deploymentId/status`
- `GET /v1/billing/workspaces/ws_main/wallet`
- `GET /v1/billing/workspaces/ws_main/usage?period=today`

The current storage layer is in-memory on purpose so the desktop app can start integrating immediately. The next step after this skeleton is replacing the store module with PostgreSQL and Redis.

## Real Aliyun ECS provisioning

Set credentials in the backend environment:

```bash
export ALIBABA_CLOUD_ACCESS_KEY_ID=your-ak
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=your-sk
```

Then call `POST /v1/deployments` with `mode=cloud`. Example:

```json
{
  "workspaceId": "ws_main",
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
