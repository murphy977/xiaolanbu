process.env.XLB_DESKTOP_HELPERS = "1";

const { app } = require("electron");
const fs = require("fs");

async function main() {
  const { __helpers } = require("./main.js");
  const { runLocalChatSmokeTest } = require("./smoke-local-chat.js");
  if (!__helpers) {
    throw new Error("Desktop helper exports are unavailable.");
  }

  const [command, payloadJson = ""] = process.argv.slice(2);
  const rawPayload = payloadJson.startsWith("@")
    ? fs.readFileSync(payloadJson.slice(1), "utf8")
    : payloadJson;
  const payload = rawPayload ? JSON.parse(rawPayload) : undefined;

  let result;
  switch (command) {
    case "detect":
      result = await __helpers.detectLocalOpenClawRuntime();
      break;
    case "status":
      result = await __helpers.getLocalOpenClawStatus();
      break;
    case "sync-auth":
      result = await __helpers.syncLocalOpenClawAuthPayload(payload);
      break;
    case "patch-session-model":
      result = await __helpers.patchLocalOpenClawSessionModel(payload);
      break;
    case "clear-auth":
      result = await __helpers.clearLocalOpenClawApiKeyState();
      break;
    case "reset":
      result = await __helpers.stopLocalOpenClaw(payload);
      break;
    case "uninstall":
      result = await __helpers.uninstallLocalOpenClaw();
      break;
    case "bootstrap":
      result = await __helpers.bootstrapLocalOpenClawPayload(payload);
      break;
    case "inspect-plugin":
      result = await __helpers.inspectLocalOpenClawPlugin(payload?.pluginId);
      break;
    case "ensure-commerce":
      result = await __helpers.ensureLocalCommerceTeam();
      break;
    case "open-commerce-session":
      result = await __helpers.openCommerceSession(payload);
      break;
    case "run-commerce-workflow":
      result = await __helpers.runCommerceWorkflow(payload);
      break;
    case "get-commerce-run":
      result = await __helpers.getCommerceRun(payload);
      break;
    case "list-commerce-runs":
      result = {
        ok: true,
        items: __helpers.listCommerceRuns(),
      };
      break;
    case "run-chat-task":
      result = await __helpers.runLocalGatewayChatTask(payload);
      break;
    case "smoke-chat":
      result = await runLocalChatSmokeTest();
      break;
    default:
      throw new Error(`Unsupported command: ${command || "<empty>"}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await app.whenReady();
    } catch {}
    app.exit(process.exitCode ?? 0);
  });
