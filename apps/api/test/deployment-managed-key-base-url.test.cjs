const assert = require("node:assert/strict");
const test = require("node:test");

const { DeploymentsService } = require("../dist/modules/deployments/deployments.service.js");

test("managed deployment key reuse keeps LiteLLM proxy baseUrl when switching catalog models", () => {
  const previousCatalog = process.env.XLB_GATEWAY_MODEL_CATALOG;
  process.env.XLB_GATEWAY_MODEL_CATALOG = [
    "gpt-5.2@aportal",
    "gpt-4o@aportal",
    "qwen35-plus=qwen3.5-plus@qwen",
  ].join(",");

  try {
    const service = new DeploymentsService(
      {},
      {},
      {},
      {},
      {
        getPublicBaseUrl: () => "https://gateway.xiaolanbu.test/v1",
      },
      {},
    );

    const deployment = {
      id: "dep_local_demo",
      workspaceId: "ws_demo_user",
      name: "Local Demo",
      mode: "local",
      status: "running",
      provider: "local",
      region: "local-device",
      gatewayUrl: "https://gateway.xiaolanbu.test/v1",
      createdAt: "2026-03-23T00:00:00.000Z",
      lastHeartbeatAt: "2026-03-23T00:00:00.000Z",
      gatewayKey: {
        tokenId: "tok_demo",
        secretKey: "sk-managed-demo",
        keyName: "demo-key",
        keyAlias: "deployment:dep_local_demo",
        modelId: "qwen35-plus",
        baseUrl: "https://gateway.xiaolanbu.test/v1",
      },
      metadata: {
        gatewayKeyScope: "catalog",
        gatewayAllowedModelIds: ["gpt-5.2", "gpt-4o", "qwen35-plus"],
      },
    };

    const result = service.resolveReusableManagedGatewayConfigForModel(
      deployment,
      "gpt-5.4",
    );

    assert.ok(result, "expected a reusable managed config");
    assert.equal(result.apiKey, "sk-managed-demo");
    assert.equal(result.modelId, "gpt-5.4");
    assert.equal(result.providerId, "openai");
    assert.equal(result.baseUrl, "https://gateway.xiaolanbu.test/v1");
    assert.equal(result.managedByLiteLlm, true);
    assert.deepEqual(
      [...result.allowedModelIds].sort(),
      ["gpt-5.2", "gpt-5.4", "gpt-4o", "qwen35-plus"].sort(),
    );
  } finally {
    if (previousCatalog === undefined) {
      delete process.env.XLB_GATEWAY_MODEL_CATALOG;
    } else {
      process.env.XLB_GATEWAY_MODEL_CATALOG = previousCatalog;
    }
  }
});

test("gateway model catalog keeps built-in gpt-5.4 on aportal profile even when env catalog omits it", () => {
  const previousCatalog = process.env.XLB_GATEWAY_MODEL_CATALOG;
  process.env.XLB_GATEWAY_MODEL_CATALOG = [
    "gpt-5.2@aportal",
    "gpt-4o@aportal",
    "qwen35-plus=qwen3.5-plus@qwen",
  ].join(",");

  try {
    const service = new DeploymentsService(
      {},
      {},
      {},
      {},
      {
        getPublicBaseUrl: () => "https://gateway.xiaolanbu.test/v1",
      },
      {},
    );

    const catalog = service.getGatewayModelCatalog();
    const gpt54 = catalog.find((item) => item.id === "gpt-5.4");

    assert.ok(gpt54, "expected gpt-5.4 to be present in the merged catalog");
    assert.equal(gpt54.providerId, "openai");
    assert.equal(gpt54.profileId, "aportal");
    assert.equal(gpt54.upstreamModelId, "gpt-5.4");
  } finally {
    if (previousCatalog === undefined) {
      delete process.env.XLB_GATEWAY_MODEL_CATALOG;
    } else {
      process.env.XLB_GATEWAY_MODEL_CATALOG = previousCatalog;
    }
  }
});
