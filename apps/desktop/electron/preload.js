const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("xiaolanbu", {
  platform: process.platform,
});
