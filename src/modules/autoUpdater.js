const { autoUpdater } = require("electron-updater");
const { dialog, shell } = require("electron");
const store = require("./storeManager");

function setupAutoUpdater() {
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info);
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log("No updates available:", info);
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
  });

  autoUpdater.on("download-progress", (progressObj) => {
    console.log(`Downloading: ${progressObj.percent}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("Update downloaded:", info);

    const repoUrl =
      "https://github.com/Hlushok/lampaua-desktop/releases/latest";

    dialog
      .showMessageBox({
        type: "info",
        title: "Оновлення готове",
        message: "Нове оновлення завантажено. Перезапустити застосунок?",
        buttons: ["Так", "Пізніше", "Список змін на GitHub"],
      })
      .then((result) => {
        if (result.response === 0) {
          // Да - перезапускаем
          autoUpdater.quitAndInstall();
        } else if (result.response === 2) {
          // Список изменений на GitHub
          shell.openExternal(repoUrl);

          // Показываем диалог снова после открытия GitHub
          dialog
            .showMessageBox({
              type: "info",
              title: "Оновлення готове",
              message: "Нове оновлення завантажено. Перезапустити застосунок?",
              buttons: ["Так", "Пізніше"],
            })
            .then((secondResult) => {
              if (secondResult.response === 0) {
                autoUpdater.quitAndInstall();
              }
            });
        }
      });
  });

  setTimeout(() => {
    if (store.get("autoUpdate")) {
      autoUpdater.checkForUpdates().catch(console.error);
    }
  }, 5000);
}

module.exports = {
  setupAutoUpdater,
};
