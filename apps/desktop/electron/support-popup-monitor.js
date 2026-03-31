process.env.XLB_DESKTOP_HELPERS = "1";

const { app } = require("electron");

function parseArgs(argv = []) {
  const result = {
    platform: "taobao",
    intervalMs: 1200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || "");
    const next = String(argv[index + 1] || "");
    if (current === "--platform" && next) {
      result.platform = next.trim().toLowerCase() || result.platform;
      index += 1;
      continue;
    }
    if (current === "--interval-ms" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed >= 500) {
        result.intervalMs = parsed;
      }
      index += 1;
    }
  }
  return result;
}

function logLine(message, payload = null) {
  const timestamp = new Date().toISOString();
  if (payload === null || payload === undefined) {
    process.stdout.write(`[support-popup-monitor] ${timestamp} ${message}\n`);
    return;
  }
  process.stdout.write(
    `[support-popup-monitor] ${timestamp} ${message} ${JSON.stringify(payload)}\n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { __helpers } = require("./main.js");
  if (!__helpers) {
    throw new Error("Desktop helper exports are unavailable.");
  }

  let closed = false;
  let inFlight = false;
  let lastHandledKey = "";

  async function tick() {
    if (closed || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const inspect = await __helpers.inspectSupportUI({ platform: options.platform });
      const reminderThread = inspect?.reminderThread || null;
      if (!inspect?.ok || !reminderThread?.threadId) {
        return;
      }

      const threadResult = await __helpers.getSupportThread({
        platform: options.platform,
        threadId: reminderThread.threadId,
      });
      if (!threadResult?.ok || !threadResult.thread) {
        logLine("读取弹窗线程失败", {
          threadId: reminderThread.threadId,
          error: threadResult?.error || "unknown",
        });
        return;
      }

      const thread = threadResult.thread;
      const latestBuyerMessage =
        typeof thread.latestMessage === "string" ? thread.latestMessage.trim() : "";
      const historyLength = Array.isArray(thread.history) ? thread.history.length : 0;
      const handledKey = `${thread.threadId}::${historyLength}::${latestBuyerMessage}`;
      if (!latestBuyerMessage || handledKey === lastHandledKey) {
        return;
      }

      logLine("检测到新的弹窗线程", {
        threadId: thread.threadId,
        buyerName: thread.buyerName || "",
        latestMessage: latestBuyerMessage,
      });

      const triage = await __helpers.runSupportTriage({
        platform: options.platform,
        threadId: thread.threadId,
      });
      if (!triage?.ok || !triage.decision) {
        logLine("客服分诊失败", {
          threadId: thread.threadId,
          error: triage?.error || "unknown",
        });
        return;
      }

      const decision = triage.decision;
      logLine("分诊完成", {
        threadId: thread.threadId,
        riskLevel: decision.riskLevel,
        nextAction: decision.nextAction,
      });

      if (
        decision.riskLevel === "low" &&
        decision.nextAction === "auto-reply" &&
        decision.replyDraft
      ) {
        const reply = await __helpers.approveSupportReplyAction({
          platform: options.platform,
          threadId: thread.threadId,
          automated: true,
          message: decision.replyDraft,
        });
        if (!reply?.ok) {
          logLine("自动发送失败", {
            threadId: thread.threadId,
            error: reply?.error || "unknown",
          });
          return;
        }
        lastHandledKey = handledKey;
        logLine("自动发送成功", {
          threadId: thread.threadId,
          latestMessage: latestBuyerMessage,
        });
        return;
      }

      lastHandledKey = handledKey;
      logLine("进入人工/待补上下文", {
        threadId: thread.threadId,
        riskLevel: decision.riskLevel,
        nextAction: decision.nextAction,
      });
    } catch (error) {
      logLine("监听循环异常", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs);
  void tick();

  function shutdown() {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(timer);
    logLine("监听已停止");
    void app.quit();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });
}

main().catch((error) => {
  process.stderr.write(
    `[support-popup-monitor] fatal ${error instanceof Error ? error.message : String(error)}\n`,
  );
  void app.quit();
});
