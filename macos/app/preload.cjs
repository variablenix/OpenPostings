const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("openpostings", {
  platform: "macos"
});

