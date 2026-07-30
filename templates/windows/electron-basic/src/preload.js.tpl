const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("app", {
  name: "__PROJECT_NAME__",
});
