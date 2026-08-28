const { ipcMain } = require("electron");
const { normalizeLampaUrl } = require("../lampaUrls");
const { assertRendererStoreKey } = require("../storeAccessPolicy");

function registerStoreHandlers(store) {
  // Обработчик изменения URL
  const { getMainWindow } = require("../windowManager");

  store.onDidChange("lampaUrl", (newValue) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.loadURL(newValue);
    }
  });

  ipcMain.handle("store-get", (event, key) => {
    assertRendererStoreKey(key);
    return store.get(key);
  });

  ipcMain.handle("store-set", (event, key, value) => {
    assertRendererStoreKey(key);
    store.set(key, key === "lampaUrl" ? normalizeLampaUrl(value) : value);
  });

  ipcMain.handle("store-has", (event, key) => {
    assertRendererStoreKey(key);
    return store.has(key);
  });

  ipcMain.handle("store-delete", (event, key) => {
    assertRendererStoreKey(key);
    if (store.has(key)) {
      store.delete(key);
      return true;
    }
    return false;
  });
}

module.exports = registerStoreHandlers;
