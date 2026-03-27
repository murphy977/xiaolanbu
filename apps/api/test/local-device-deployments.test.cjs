const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const test = require("node:test");

const API_ROOT = "/Users/wusongsong/Projects/openclaw/xiaolanbu/apps/api";

async function waitForServer(baseUrl, child, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`API server exited early with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError || new Error("Timed out waiting for API server.");
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    body: text ? JSON.parse(text) : null,
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await request(baseUrl, path, options);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function startLiteLlmStub(t) {
  const keys = new Map();
  let sequence = 0;
  const server = http.createServer((req, res) => {
    const respondJson = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      const body = rawBody ? JSON.parse(rawBody) : {};

      if (req.method === "POST" && url.pathname === "/key/generate") {
        sequence += 1;
        const key = `sk-local-${sequence}`;
        const token = `vk-local-${sequence}`;
        const record = {
          key,
          token,
          key_name: `local-${sequence}`,
          key_alias: typeof body.key_alias === "string" ? body.key_alias : null,
          metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
          models: Array.isArray(body.models) ? body.models : [],
          max_budget: typeof body.max_budget === "number" ? body.max_budget : null,
          spend: 0,
          blocked: false,
        };
        keys.set(key, record);
        respondJson(200, record);
        return;
      }

      if (req.method === "GET" && url.pathname === "/key/info") {
        const key = url.searchParams.get("key") || "";
        const record = keys.get(key);
        if (!record) {
          respondJson(404, { error: "key not found" });
          return;
        }
        respondJson(200, {
          key,
          info: {
            spend: record.spend,
            max_budget: record.max_budget,
            blocked: record.blocked,
            key_alias: record.key_alias,
            key_name: record.key_name,
            metadata: record.metadata,
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/key/update") {
        const key = typeof body.key === "string" ? body.key : "";
        const record = keys.get(key);
        if (!record) {
          respondJson(404, { error: "key not found" });
          return;
        }
        if (typeof body.max_budget === "number") {
          record.max_budget = body.max_budget;
        }
        if (typeof body.blocked === "boolean") {
          record.blocked = body.blocked;
        }
        keys.set(key, record);
        respondJson(200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/spend/logs") {
        respondJson(200, []);
        return;
      }

      respondJson(404, { error: "not found" });
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function startApiServer(t, extraEnv = {}) {
  const port = 43050 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn("node", ["dist/main.js"], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: "",
      XLB_OPENAI_API_KEY: "sk-local-device-test",
      XLB_OPENAI_BASE_URL: "https://api.aportal.ai/v1",
      XLB_UPSTREAM_OPENAI_MODEL: "gpt-5.2",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  });

  await waitForServer(baseUrl, child);

  return {
    baseUrl,
    getLogs() {
      return `${stdout.join("")}\n${stderr.join("")}`;
    },
  };
}

async function loginDemoUser(baseUrl) {
  const login = await requestJson(baseUrl, "/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: "demo@xiaolanbu.app",
      password: "DemoUser123!",
    }),
  });

  return {
    sessionToken: login.sessionToken,
    headers: {
      "x-xlb-session": login.sessionToken,
    },
  };
}

test("runtime local bootstrap reuses one credential per account scope and deployments stay cloud-only", async (t) => {
  const liteLlm = await startLiteLlmStub(t);
  const server = await startApiServer(t, {
    LITELLM_PROXY_URL: liteLlm.baseUrl,
    LITELLM_MASTER_KEY: "test-master-key",
    XLB_GATEWAY_PUBLIC_BASE_URL: "https://gateway.xiaolanbu.test/v1",
  });
  const { baseUrl } = server;
  const { headers } = await loginDemoUser(baseUrl);

  const first = await requestJson(baseUrl, "/v1/runtime/local/bootstrap", {
    method: "POST",
    headers,
    body: JSON.stringify({
      accountScopeId: "ws_demo_user",
      platform: "darwin",
      localDeviceId: "device-a",
      localDeviceLabel: "Device A",
    }),
  });

  const second = await requestJson(baseUrl, "/v1/runtime/local/bootstrap", {
    method: "POST",
    headers,
    body: JSON.stringify({
      accountScopeId: "ws_demo_user",
      platform: "darwin",
      localDeviceId: "device-b",
      localDeviceLabel: "Device B",
    }),
  });

  assert.equal(first.ownerUserId, "user_002");
  assert.equal(first.accountScopeId, "ws_demo_user");
  assert.equal(typeof first.apiKey, "string");
  assert.ok(first.apiKey.startsWith("sk-"));
  assert.equal(second.apiKey, first.apiKey, "same user + scope should reuse the active local credential");
  assert.equal(second.baseUrl, first.baseUrl);
  assert.equal(second.providerId, first.providerId);
  assert.equal(second.defaultModelId, first.defaultModelId);
  assert.ok(Array.isArray(first.allowedModelIds));
  assert.ok(first.allowedModelIds.includes(first.defaultModelId));
  assert.ok(Array.isArray(first.modelCatalog));
  assert.ok(first.modelCatalog.length > 0);
  assert.ok(Array.isArray(first.runtimePackages));

  const listed = await requestJson(baseUrl, "/v1/deployments", { headers });
  assert.ok(Array.isArray(listed.items));
  assert.ok(listed.items.every((item) => item.mode === "cloud"));
  assert.ok(!listed.items.some((item) => item.id === `local:${first.accountScopeId}`));

  const createLocal = await request(baseUrl, "/v1/deployments", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Legacy Local",
      mode: "local",
      platform: "darwin",
      localDeviceId: "legacy-device",
      localDeviceLabel: "Legacy Device",
    }),
  });
  assert.equal(createLocal.status, 410);
  assert.match(createLocal.body?.message || "", /runtime\/local\/bootstrap/);

  const deprecatedBootstrap = await request(baseUrl, "/v1/deployments/dep_legacy/local-bootstrap", {
    method: "POST",
    headers,
  });
  assert.equal(deprecatedBootstrap.status, 410);
  assert.match(deprecatedBootstrap.body?.message || "", /runtime\/local\/bootstrap/);

  const deprecatedSync = await request(baseUrl, "/v1/deployments/dep_legacy/local-runtime-sync", {
    method: "POST",
    headers,
    body: JSON.stringify({
      deviceId: "legacy-device",
      installed: true,
      ready: true,
    }),
  });
  assert.equal(deprecatedSync.status, 410);
  assert.match(deprecatedSync.body?.message || "", /runtime\/local\/bootstrap/);

  const combinedLogs = server.getLogs();
  assert.ok(
    !/TypeError|ReferenceError/i.test(combinedLogs),
    "server logs should not contain runtime reference errors",
  );
});

test("account usage summary keeps localUsage separate from cloud deployment summaries", async (t) => {
  const liteLlm = await startLiteLlmStub(t);
  const server = await startApiServer(t, {
    LITELLM_PROXY_URL: liteLlm.baseUrl,
    LITELLM_MASTER_KEY: "test-master-key",
    XLB_GATEWAY_PUBLIC_BASE_URL: "https://gateway.xiaolanbu.test/v1",
  });
  const { baseUrl } = server;
  const { headers } = await loginDemoUser(baseUrl);

  await requestJson(baseUrl, "/v1/runtime/local/bootstrap", {
    method: "POST",
    headers,
    body: JSON.stringify({
      accountScopeId: "ws_demo_user",
      platform: "win32",
      localDeviceId: "win-device-a",
      localDeviceLabel: "Windows Device A",
    }),
  });

  const usage = await requestJson(baseUrl, "/v1/billing/account/usage?period=today", {
    headers,
  });
  assert.ok(usage.summary && typeof usage.summary === "object");
  assert.ok(usage.localUsage && typeof usage.localUsage === "object");
  assert.equal(usage.localUsage.workspaceId, "ws_demo_user");
  assert.equal(usage.localUsage.period, "today");

  const summaries = await requestJson(baseUrl, "/v1/billing/account/deployments/summary?period=today", {
    headers,
  });
  assert.ok(Array.isArray(summaries.items));
  assert.ok(summaries.items.every((item) => typeof item.deploymentId === "string"));
  assert.ok(summaries.items.every((item) => !item.deploymentId.startsWith("local:")));
});
