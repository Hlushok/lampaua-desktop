const { ipcMain } = require("electron");
const store = require("../storeManager");

function registerWindowHandlers(getMainWindow) {
  ipcMain.on("toggle-fullscreen", () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  // Получить текущий режим полного экрана
  ipcMain.handle("get-fullscreen-mode", () => {
    return store.get("fullscreenMode", "last");
  });

  // Установить режим полного экрана
  ipcMain.handle("set-fullscreen-mode", async (event, mode) => {
    if (!["always", "never", "last"].includes(mode)) {
      return { success: false, message: "Invalid mode" };
    }

    store.set("fullscreenMode", mode);
    return { success: true, mode };
  });

  ipcMain.on("reload-page", (event, url) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    mainWindow.loadURL(url).catch((err) => {
      console.error("Ошибка загрузки URL:", err);
    });
  });

  ipcMain.on("close-app", () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.close();
    }
  });
}

module.exports = registerWindowHandlers;
