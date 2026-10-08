const { readFileSync } = require("fs");
const path = require("node:path");
const lampaInitializer = require("./lampaInitializer");
const { isMpvTest } = require("./mpv/testMode");

function setupPluginHandler(mainWindow) {
  let generation = 0;
  if (isMpvTest()) {
    mainWindow.webContents.on(
      "did-start-navigation",
      (_event, _url, inPlace, main) => {
        if (main && !inPlace) generation++;
      },
    );
  }
  mainWindow.webContents.on("did-finish-load", async () => {
    const current = generation;
    const cancelled = () =>
      isMpvTest() &&
      (generation !== current ||
        mainWindow.isDestroyed() ||
        mainWindow.mpvClosing);
    try {
      await waitForLampaReady(mainWindow, cancelled);
      const initializationWindow = isMpvTest()
        ? {
            webContents: {
              executeJavaScript(...args) {
                if (cancelled())
                  return Promise.reject(new Error("Lampa document changed"));
                return mainWindow.webContents.executeJavaScript(...args);
              },
            },
          }
        : mainWindow;
      await lampaInitializer.initialize(initializationWindow);
      if (cancelled()) return;
      if (isMpvTest()) {
        const code = readFileSync(
          path.join(__dirname, "../mpv-runtime/renderer.js"),
          "utf8",
        );
        if (!cancelled()) await mainWindow.webContents.executeJavaScript(code);
      }
      if (!cancelled()) injectPlugin(mainWindow);
    } catch (err) {
      console.error("Ошибка при перезагрузке:", err);
    }
  });
}

async function waitForLampaReady(mainWindow, cancelled = () => false) {
  const deadline = Date.now() + 30_000;
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (
        isMpvTest() &&
        (cancelled() ||
          mainWindow.isDestroyed() ||
          mainWindow.mpvClosing ||
          Date.now() > deadline)
      ) {
        reject(new Error("Lampa initialization cancelled or timed out"));
        return;
      }
      const isReady = await mainWindow.webContents
        .executeJavaScript("window.Lampa !== undefined", true)
        .catch(() => false);

      if (isReady) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

function injectPlugin(mainWindow) {
  const pluginCode = readFileSync(
    path.join(__dirname, "..", "plugin.js"),
    "utf-8",
  );
  mainWindow.webContents
    .executeJavaScript(pluginCode)
    .then(() => {
      console.log("Плагин успешно внедрён");
    })
    .catch((err) => {
      console.error("Ошибка внедрения плагина:", err);
    });
}

module.exports = {
  setupPluginHandler,
  injectPlugin,
};
