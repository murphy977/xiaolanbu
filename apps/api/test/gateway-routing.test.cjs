const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");

const { LiteLlmProxyService } = require("../dist/modules/infrastructure/services/litellm-proxy.service.js");

async function readStream(stream) {
  if (!stream) {
    return "";
  }

  let output = "";
  for await (const chunk of stream) {
    output += chunk.toString();
  }
  return output;
}

test("proxyOpenAiRequest rewrites stable openclaw alias to deployment-selected model", async (t) => {
  let capturedBody = null;
  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      capturedBody = rawBody ? JSON.parse(rawBody) : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const previousProxyUrl = process.env.LITELLM_PROXY_URL;
  const previousAlias = process.env.XLB_GATEWAY_MODEL_ALIAS;
  const { port } = server.address();
  process.env.LITELLM_PROXY_URL = `http://127.0.0.1:${port}`;
  process.env.XLB_GATEWAY_MODEL_ALIAS = "openclaw";
  t.after(() => {
    if (previousProxyUrl === undefined) {
      delete process.env.LITELLM_PROXY_URL;
    } else {
      process.env.LITELLM_PROXY_URL = previousProxyUrl;
    }

    if (previousAlias === undefined) {
      delete process.env.XLB_GATEWAY_MODEL_ALIAS;
    } else {
      process.env.XLB_GATEWAY_MODEL_ALIAS = previousAlias;
    }
  });

  const service = new LiteLlmProxyService({
    getDeploymentByGatewaySecretAsync: async (secretKey) => {
      if (secretKey !== "secret-123") {
        return null;
      }

      return {
        id: "dep_local_demo",
        mode: "local",
        workspaceId: "ws_demo_user",
        name: "Local Demo",
        status: "running",
        provider: "local",
        region: "local-device",
        runtimeVersion: "openclaw-0.9.2",
        consoleUrl: "http://127.0.0.1:18789",
        gatewayUrl: "https://api.xiaolanbu.com/v1",
        createdAt: "2026-03-22T00:00:00.000Z",
        lastHeartbeatAt: "2026-03-22T00:00:00.000Z",
        gatewayKey: {
          tokenId: "tok_demo",
          secretKey: "secret-123",
          modelId: "qwen35-plus",
          baseUrl: "https://api.xiaolanbu.com/v1",
        },
        metadata: {
          modelId: "qwen35-plus",
        },
      };
    },
  });

  const upstream = await service.proxyOpenAiRequest({
    path: "chat/completions",
    method: "POST",
    headers: {
      authorization: "Bearer secret-123",
      "content-type": "application/json",
    },
    body: {
      model: "openclaw",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(upstream.status, 200);
  await readStream(upstream.body);
  assert.ok(capturedBody, "expected upstream body to be captured");
  assert.equal(capturedBody.model, "qwen35-plus");
  assert.equal(capturedBody.stream, true);
});
