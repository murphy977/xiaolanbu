const { contextBridge, ipcRenderer } = require("electron");

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
  bootstrapLocalOpenClaw: (payload) =>
    ipcRenderer.invoke("xiaolanbu:bootstrap-local-openclaw", payload),
});
