const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  setContentUrl: (url) => ipcRenderer.send("set-content-url", url),
  startResumeDrag: (buffer, fileName, appId) =>
    ipcRenderer.sendSync("resume-drag", { buffer, fileName, appId }),
  saveResumeToTemp: (buffer, fileName, profileName) =>
    ipcRenderer.invoke("save-resume-temp", { buffer, fileName, profileName }),
  getDefaultSavePath: () => ipcRenderer.invoke("get-default-save-path"),
  setDefaultSavePath: (dirPath) => ipcRenderer.invoke("set-default-save-path", dirPath),
  showSavePathDialog: () => ipcRenderer.invoke("show-save-path-dialog"),
  showResumeSyncFolderDialog: () => ipcRenderer.invoke("show-resume-sync-folder-dialog"),
  scanResumeSyncFolder: (rootPath) => ipcRenderer.invoke("scan-resume-sync-folder", rootPath),
  readResumeSyncFile: (payload) => ipcRenderer.invoke("read-resume-sync-file", payload),
  getDeepSeekCookies: () => ipcRenderer.invoke("get-deepseek-cookies"),
  setDeepSeekCookies: (cookies) => ipcRenderer.invoke("set-deepseek-cookies", cookies),
  writeClipboardText: (text) => ipcRenderer.invoke("write-clipboard-text", text),
  setProfileFlyoutHover: (hovering) => ipcRenderer.invoke("set-profile-flyout-hover", hovering),
  getProfileFlyoutSummary: () => ipcRenderer.invoke("get-profile-flyout-summary"),
  setProfileFlyoutSummary: (summary) => ipcRenderer.send("set-profile-flyout-summary", summary),
  setAuthForFlyout: (payload) => ipcRenderer.send("set-auth-for-flyout", payload),
  getAuthForFlyout: () => ipcRenderer.invoke("get-auth-for-flyout"),
  onProfileFlyoutSummary: (cb) => {
    const handler = (_event, summary) => cb(summary);
    ipcRenderer.on("profile-flyout-summary", handler);
    return () => ipcRenderer.removeListener("profile-flyout-summary", handler);
  },
  onProfileFlyoutClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("profile-flyout-closed", handler);
    return () => ipcRenderer.removeListener("profile-flyout-closed", handler);
  },
  onProfileFlyoutCancelClose: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("profile-flyout-cancel-close", handler);
    return () => ipcRenderer.removeListener("profile-flyout-cancel-close", handler);
  },
  onAuthForFlyoutUpdated: (cb) => {
    const handler = (_event, auth) => cb(auth);
    ipcRenderer.on("auth-for-flyout-updated", handler);
    return () => ipcRenderer.removeListener("auth-for-flyout-updated", handler);
  },
});
