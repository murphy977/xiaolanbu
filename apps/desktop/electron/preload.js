const { contextBridge, ipcRenderer } = require("electron");
const GATEWAY_CHAT_EVENT_CHANNEL = "xiaolanbu:gateway-chat-event";

contextBridge.exposeInMainWorld("xiaolanbu", {
  platform: process.platform,
  openExternal: (targetUrl) => ipcRenderer.invoke("xiaolanbu:open-external", targetUrl),
  copyText: (value) => ipcRenderer.invoke("xiaolanbu:copy-text", value),
  launchCommand: (command) => ipcRenderer.invoke("xiaolanbu:launch-command", command),
  launchTunnel: (command, password) => ipcRenderer.invoke("xiaolanbu:launch-tunnel", command, password),
  getTunnelStatus: () => ipcRenderer.invoke("xiaolanbu:get-tunnel-status"),
  stopTunnel: () => ipcRenderer.invoke("xiaolanbu:stop-tunnel"),
  detectLocalOpenClaw: () => ipcRenderer.invoke("xiaolanbu:detect-local-openclaw"),
  getLocalOpenClawStatus: () => ipcRenderer.invoke("xiaolanbu:get-local-openclaw-status"),
  syncLocalOpenClawAuth: (payload) =>
    ipcRenderer.invoke("xiaolanbu:sync-local-openclaw-auth", payload),
  clearLocalOpenClawApiKey: () => ipcRenderer.invoke("xiaolanbu:clear-local-openclaw-api-key"),
  resetLocalOpenClaw: (options) => ipcRenderer.invoke("xiaolanbu:reset-local-openclaw", options),
  uninstallLocalOpenClaw: () => ipcRenderer.invoke("xiaolanbu:uninstall-local-openclaw"),
  bootstrapLocalOpenClaw: (payload) =>
    ipcRenderer.invoke("xiaolanbu:bootstrap-local-openclaw", payload),
  getGatewayChatHistory: (payload) =>
    ipcRenderer.invoke("xiaolanbu:get-gateway-chat-history", payload),
  getGatewaySessions: (payload) =>
    ipcRenderer.invoke("xiaolanbu:get-gateway-sessions", payload),
  patchLocalOpenClawSessionModel: (payload) =>
    ipcRenderer.invoke("xiaolanbu:patch-local-openclaw-session-model", payload),
  abortGatewayChat: (payload) =>
    ipcRenderer.invoke("xiaolanbu:abort-gateway-chat", payload),
  startGatewayChatMessage: (payload) =>
    ipcRenderer.send("xiaolanbu:start-gateway-chat-message", payload),
  sendGatewayChatMessage: (payload) =>
    ipcRenderer.invoke("xiaolanbu:send-gateway-chat-message", payload),
  saveMarkdownExport: (payload) =>
    ipcRenderer.invoke("xiaolanbu:save-markdown-export", payload),
  ensureCommerceTeam: () => ipcRenderer.invoke("xiaolanbu:ensure-commerce-team"),
  listCommerceAgents: () => ipcRenderer.invoke("xiaolanbu:list-commerce-agents"),
  listCommerceWorkflows: () => ipcRenderer.invoke("xiaolanbu:list-commerce-workflows"),
  openCommerceSession: (payload) => ipcRenderer.invoke("xiaolanbu:open-commerce-session", payload),
  runCommerceWorkflow: (payload) => ipcRenderer.invoke("xiaolanbu:run-commerce-workflow", payload),
  getCommerceRun: (payload) => ipcRenderer.invoke("xiaolanbu:get-commerce-run", payload),
  listCommerceRuns: () => ipcRenderer.invoke("xiaolanbu:list-commerce-runs"),
  exportCommerceRun: (payload) => ipcRenderer.invoke("xiaolanbu:export-commerce-run", payload),
  openCommerceArtifact: (payload) => ipcRenderer.invoke("xiaolanbu:open-commerce-artifact", payload),
  subscribeGatewayChatEvents: (listener) => {
    if (typeof listener !== "function") {
      return () => {};
    }

    const wrapped = (_event, payload) => {
      listener(payload);
    };
    ipcRenderer.on(GATEWAY_CHAT_EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(GATEWAY_CHAT_EVENT_CHANNEL, wrapped);
    };
  },
});
