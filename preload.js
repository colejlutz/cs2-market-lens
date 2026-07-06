const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cs2", {
  pullInventory: async (steamId64, providerIds) => {
    return await ipcRenderer.invoke("cs2:pullInventory", steamId64, providerIds);
  },
  getSettings: async () => ipcRenderer.invoke("settings:get"),
  saveSettings: async (updates) => ipcRenderer.invoke("settings:save", updates),
  testCsfloatConnection: async () => ipcRenderer.invoke("cs2:testCsfloatConnection"),
  testDmarketConnection: async () => ipcRenderer.invoke("cs2:testDmarketConnection"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  getTrackingState: async () => ipcRenderer.invoke("tracking:getState"),
  getTrackingSummary: async () => ipcRenderer.invoke("tracking:getSummary"),
  setTrackedProviders: async (providerIds, refreshIds = []) =>
    ipcRenderer.invoke("tracking:setProviders", providerIds, refreshIds),
  toggleTrackingPaused: async () => ipcRenderer.invoke("tracking:togglePaused"),
  onTrackingUpdated(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("tracking:updated", listener);
    return () => ipcRenderer.removeListener("tracking:updated", listener);
  },
  onTrackingSummary(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("tracking:summary", listener);
    return () => ipcRenderer.removeListener("tracking:summary", listener);
  }
});

contextBridge.exposeInMainWorld("appWindow", {
  enterMiniMode: async () => ipcRenderer.invoke("appWindow:enterMiniMode"),
  exitMiniMode: async () => ipcRenderer.invoke("appWindow:exitMiniMode"),
  hideMini: async () => ipcRenderer.invoke("appWindow:hideMini"),
  quitApp: async () => ipcRenderer.invoke("appWindow:quitApp"),
  onUiModeChanged(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("appWindow:uiModeChanged", listener);
    return () => ipcRenderer.removeListener("appWindow:uiModeChanged", listener);
  }
});
