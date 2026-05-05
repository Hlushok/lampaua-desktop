const { ipcMain } = require("electron");

function registerOtherHandlers() {
  ipcMain.handle("get-app-version", () => {
    const { app } = require("electron");
    return app.getVersion();
  });
}

module.exports = registerOtherHandlers;
