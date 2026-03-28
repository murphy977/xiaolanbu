const assert = require("node:assert/strict");
const test = require("node:test");

const { HttpException } = require("@nestjs/common");

const { DeploymentsService } = require("../dist/modules/deployments/deployments.service.js");
const { QueueService } = require("../dist/modules/queue/queue.service.js");

test("cloud deployment retries next instance type when current zone reports Zone.NotOnSale", async () => {
  const attempts = [];
  const store = {
    async createDeployment(input) {
      return {
        ...input,
        status: "creating",
        provider: input.provider ?? "aliyun",
        region: input.region ?? "cn-hongkong",
        createdAt: "2026-03-29T00:00:00.000Z",
      };
    },
  };
  const queue = {
    isEnabled: () => false,
    isWorkerMode: () => false,
  };
  const aliyun = {
    async runInstances(input) {
      attempts.push(input.instanceType);
      if (input.instanceType === "ecs.n1.small") {
        throw new Error(
          "Aliyun RunInstances failed: Zone.NotOnSale: code: 403, The resource in the specified zone is no longer available for sale.",
        );
      }
      return {
        requestId: "req-success",
        instanceIds: ["i-demo-1"],
      };
    },
  };
  const service = new DeploymentsService(
    store,
    {
      async withAdvisoryLock(_lockId, _timeoutMs, operation) {
        return {
          acquired: true,
          value: await operation(),
        };
      },
    },
    queue,
    aliyun,
    {
      getPublicBaseUrl: () => "",
      getProxyBaseUrl: () => "",
    },
    {},
  );

  const result = await service.createDeployment({
    workspaceId: "ws_demo",
    name: "Fallback Cloud",
    mode: "cloud",
    region: "cn-hongkong",
    imageId: "m-demo",
    securityGroupId: "sg-demo",
    vSwitchId: "vsw-demo",
    instanceTypes: ["ecs.n1.small", "ecs.n4.small", "ecs.t5-lc1m2.small"],
    waitForRunning: false,
  });

  assert.deepEqual(attempts, ["ecs.n1.small", "ecs.n4.small"]);
  assert.equal(result.vendor.requestId, "req-success");
  assert.equal(result.deployment.metadata.instanceType, "ecs.n4.small");
  assert.equal(result.deployment.metadata.instanceTypeCandidates.length, 3);
  assert.equal(result.deployment.metadata.instanceTypeAttempts[0].message, "当前可用区该资源已停售或暂不可用");
  assert.equal(result.deployment.metadata.instanceTypeAttempts[1].status, "success");
});

test("queue service restores serialized HttpException from deployment worker", () => {
  const service = new QueueService();
  const restored = service.parseSerializedHttpError(
    new Error(
      JSON.stringify({
        __xlbHttpError: true,
        statusCode: 400,
        response: {
          message: "实例创建失败，已尝试：ecs.n1.small（当前可用区该资源已停售或暂不可用）",
          attempts: [{ instanceType: "ecs.n1.small", status: "error" }],
        },
      }),
    ),
  );

  assert.ok(restored instanceof HttpException);
  assert.equal(restored.getStatus(), 400);
  assert.deepEqual(restored.getResponse(), {
    message: "实例创建失败，已尝试：ecs.n1.small（当前可用区该资源已停售或暂不可用）",
    attempts: [{ instanceType: "ecs.n1.small", status: "error" }],
  });
});
