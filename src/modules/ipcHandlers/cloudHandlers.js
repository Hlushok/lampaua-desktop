const { ipcMain } = require("electron");
const {
  generatePin,
  encryptJson,
  decryptJson,
} = require("../utils/encryption");

const { importSettings } = require("./settingsHandlers");

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
              title: "Код експорту",
              html: $(
                '<div style="line-height: 1.45;"><p>Налаштування збережено тимчасово.</p><p><b>ID експорту:</b> ${data.id}<br><b>PIN-код:</b> ${pin}</p><p>Щоб перенести налаштування на інший пристрій, відкрийте там <b>Налаштування застосунку → Резервна копія / перенесення → Ввести ID і PIN</b>.</p><p>Код зберігається на сервері 1 годину.</p></div>',
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

  const response = await fetch("https://lampa.kolovatoff.ru/ei/upload", {
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
    `https://lampa.kolovatoff.ru/ei/download?id=${fileId}`,
  );
  const result = await response.json();

  if (!result.success) {
    throw new Error(result.message || "Download failed");
  }

  return decryptJson(result.data, pinStr);
}

module.exports = registerCloudHandlers;
