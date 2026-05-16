const { ipcMain } = require("electron");
const {
  generatePin,
  encryptJson,
  decryptJson,
} = require("../utils/encryption");

const { importSettings } = require("./settingsHandlers");

const BACKUP_API_BASE_URL = "http://lampaua.mooo.com/database/desktop-backup";

function registerCloudHandlers(store, getMainWindow, injectPlugin) {
  ipcMain.handle("export-settings-to-cloud", async () => {
    try {
      const mainWindow = getMainWindow();
      const { app } = require("electron");

      const storageData = await mainWindow.webContents.executeJavaScript(`
        Object.assign({}, localStorage)
      `);

      const keysToDelete = ["platform", "app.js", "testsize"];
      keysToDelete.forEach((key) => {
        if (storageData[key]) {
          delete storageData[key];
        }
      });

      const settings = {
        appVersion: app.getVersion(),
        dateCreated: new Date().toISOString(),
        app: store.get(),
        lampa: storageData,
      };

      const pin = generatePin();

      return uploadJson(settings, pin)
        .then((data) => {
          mainWindow.webContents.executeJavaScript(`
            Lampa.Modal.open({
              title: "Експорт",
              html: $(
                '<div style="line-height: 1.45;"><p><b>Збережіть ID експорту:</b> ${data.id}<br><b>І PIN-код для розшифрування:</b> ${pin}</p><p>Увага! Зберігається на сервері 1 годину.</p></div>',
              ),
              size: "small",
              onBack: function () {
                Lampa.Modal.close();
                Lampa.Controller.toggle("settings_component");
              },
            });
          `);
          return { success: true, message: "Код експорту створено" };
        })
        .catch((error) => {
          console.error("Помилка експорту:", error);
          mainWindow.webContents.executeJavaScript(`
            Lampa.Noty.show("Помилка експорту");
          `);
          return {
            success: false,
            message: "Не вдалося створити код експорту",
          };
        });
    } catch (err) {
      console.log(`Не вдалося експортувати налаштування: ${err.message}`);
      return {
        success: false,
        message: `Не вдалося експортувати налаштування: ${err.message}`,
      };
    }
  });

  ipcMain.handle("import-settings-from-cloud", async (event, id, pin) => {
    try {
      const mainWindow = getMainWindow();
      const settings = await downloadJson(id, pin);

      if (typeof settings !== "object" || settings === null) {
        return {
          success: false,
          message: "Неправильний формат даних",
        };
      }

      await importSettings(settings, store, mainWindow, injectPlugin);

      console.log("Settings imported successfully");
      return {
        success: true,
        message: "Налаштування імпортовано, перезапускаємо застосунок...",
      };
    } catch (err) {
      console.log(`Error importing settings: ${err.message}`);
      return {
        success: false,
        message: `Не вдалося імпортувати налаштування: ${err.message}`,
      };
    }
  });
}

async function uploadJson(jsonData, pin) {
  const pinStr = String(pin).padStart(4, "0");
  const encrypted = encryptJson(jsonData, pinStr);

  const response = await fetch(`${BACKUP_API_BASE_URL}/upload.php`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: encrypted }),
  });

  const result = await response.json();
  console.log("Upload result:", result);
  return result;
}

async function downloadJson(fileId, pin) {
  const pinStr = String(pin).padStart(4, "0");

  const response = await fetch(
    `${BACKUP_API_BASE_URL}/download.php?id=${encodeURIComponent(fileId)}`,
  );
  const result = await response.json();

  if (!result.success) {
    throw new Error(result.message || "Download failed");
  }

  return decryptJson(result.data, pinStr);
}

module.exports = registerCloudHandlers;
