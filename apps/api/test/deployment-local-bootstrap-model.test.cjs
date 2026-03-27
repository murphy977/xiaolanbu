const assert = require("node:assert/strict");
const test = require("node:test");

const { DeploymentsService } = require("../dist/modules/deployments/deployments.service.js");

test("local bootstrap keeps the concrete model id even when backend model routing is enabled", () => {
  const service = new DeploymentsService(
    {},
    {},
    {},
    {},
    {
      getProxyBaseUrl: () => "http://litellm:4000",
      getPublicBaseUrl: () => "https://gateway.xiaolanbu.test/v1",
      getStableModelAlias: () => "openclaw",
    },
    {
      getBootstrapPackagesForPlatform: () => [],
    },
  );

  const deployment = {
    id: "dep_local_demo",
    workspaceId: "ws_demo_user",
    ownerUserId: "user_001",
    name: "Local Demo",
    mode: "local",
    status: "running",
    provider: "local",
    region: "local-device",
    gatewayUrl: "https://gateway.xiaolanbu.test/v1",
    createdAt: "2026-03-24T00:00:00.000Z",
    lastHeartbeatAt: "2026-03-24T00:00:00.000Z",
    access: {
      dashboardUrl: "http://127.0.0.1:18789/#token=demo-token",
      browserControlUrl: "http://127.0.0.1:18791/",
      tokenSource: "desktop-local-bootstrap (gateway.auth.token)",
    },
    gatewayKey: {
      tokenId: "tok_demo",
      secretKey: "sk-managed-demo",
      keyName: "demo-key",
      keyAlias: "deployment:dep_local_demo",
      modelId: "gpt-4o",
      baseUrl: "https://gateway.xiaolanbu.test/v1",
    },
    metadata: {
      modelId: "gpt-4o",
      platform: "darwin",
      gatewayPort: 18789,
      browserControlPort: 18791,
      gatewayBind: "loopback",
    },
  };

  const refreshed = service.refreshLocalDeploymentBootstrap(deployment);
  assert.equal(refreshed.metadata.localGatewayRoutingMode, "backend-model-routing");
  assert.equal(refreshed.metadata.localGatewayModelId, "gpt-4o");

  const payload = service.buildLocalBootstrapPayload(refreshed);
  assert.equal(payload.modelId, "gpt-4o");
  assert.equal(payload.providerId, "openai");
});
