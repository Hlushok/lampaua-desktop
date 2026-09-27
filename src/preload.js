const { contextBridge, ipcRenderer } = require("electron");
const crypto = require("node:crypto");
const path = require("node:path");

const UA_PLAYER_SESSION_TTL_MS = 30_000;
let pendingUaPlayerSession = null;
let pendingUaPlayerSessionTimer = null;
let uaPlayerSessionProvider = null;

function clearPendingUaPlayerSession() {
  pendingUaPlayerSession = null;
  if (pendingUaPlayerSessionTimer) {
    clearTimeout(pendingUaPlayerSessionTimer);
    pendingUaPlayerSessionTimer = null;
  }
}

function prepareUaPlayerSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return false;
  }
  clearPendingUaPlayerSession();
  pendingUaPlayerSession = {
    expiresAt: Date.now() + UA_PLAYER_SESSION_TTL_MS,
    value: session,
  };
  pendingUaPlayerSessionTimer = setTimeout(
    clearPendingUaPlayerSession,
    UA_PLAYER_SESSION_TTL_MS,
  );
  pendingUaPlayerSessionTimer.unref?.();
  return true;
}

function takeUaPlayerSession(command) {
  if (!pendingUaPlayerSession) return null;
  if (pendingUaPlayerSession.expiresAt < Date.now()) {
    clearPendingUaPlayerSession();
    return null;
  }
  if (
    typeof command !== "string" ||
    path.win32.basename(command).toLowerCase() !== "uaplayer.exe"
  ) {
    return null;
  }
  const session = pendingUaPlayerSession.value;
  clearPendingUaPlayerSession();
  return session;
}

// Модуль для Node.js модулей
contextBridge.exposeInMainWorld("require", (module) => {
  if (module === "fs") {
    return {
      existsSync: (path) => {
        return ipcRenderer.sendSync("fs-existsSync", path);
      },
    };
  }
  if (module === "child_process") {
    return {
      spawn: (command, args, options) => {
        const id = Math.random().toString(36).substr(2, 9);
        let cancelled = false;
        let cancelSignal = "SIGTERM";
        let dispatched = false;
        const lifecycleHandlers = [];
        const dispatch = () => {
          if (cancelled) {
            for (const eventName of ["exit", "close"]) {
              for (const handler of lifecycleHandlers.filter(
                (entry) => entry.eventName === eventName,
              )) {
                ipcRenderer.removeListener(
                  handler.channel,
                  handler.subscription,
                );
                handler.callback(null, cancelSignal);
              }
            }
            lifecycleHandlers.length = 0;
            return;
          }
          let uaPlayerSession = takeUaPlayerSession(command);
          if (
            uaPlayerSessionProvider &&
            typeof command === "string" &&
            path.win32.basename(command).toLowerCase() === "uaplayer.exe"
          ) {
            try {
              uaPlayerSession =
                uaPlayerSessionProvider(args) || uaPlayerSession;
            } catch {
              // Keep the original URL launch available if the renderer adapter fails.
            }
          }
          const spawnArguments = [id, command, args, options];
          if (uaPlayerSession) spawnArguments.push({ uaPlayerSession });
          dispatched = true;
          ipcRenderer.send("child-process-spawn", ...spawnArguments);
        };
        // Lampa emits `external` after spawn and may attach a playlist/subtitles
        // after play() returns. Defer only UA Player, not other native players.
        if (
          uaPlayerSessionProvider &&
          typeof command === "string" &&
          path.win32.basename(command).toLowerCase() === "uaplayer.exe"
        ) {
          setTimeout(dispatch, 0);
        } else {
          dispatch();
        }
        return {
          kill: (signal) => {
            if (!dispatched) {
              cancelled = true;
              cancelSignal = signal || "SIGTERM";
              return;
            }
            ipcRenderer.send("child-process-kill", id, signal);
          },
          on: (event, callback) => {
            if (event === "error") {
              ipcRenderer.once(
                `child-process-spawn-error-${id}`,
                (event, error) => callback(error),
              );
            } else if (event === "exit" || event === "close") {
              const channel = `child-process-spawn-${event}-${id}`;
              const subscription = (ipcEvent, code, signal) =>
                callback(code, signal);
              lifecycleHandlers.push({
                eventName: event,
                channel,
                subscription,
                callback,
              });
              ipcRenderer.once(channel, subscription);
            }
          },
          stdout: {
            on: (event, callback) => {
              if (event === "data") {
                ipcRenderer.on(
                  `child-process-spawn-stdout-${id}`,
                  (event, data) => callback(data),
                );
              }
            },
          },
          stderr: {
            on: (event, callback) => {
              if (event === "data") {
                ipcRenderer.on(
                  `child-process-spawn-stderr-${id}`,
                  (event, data) => callback(data),
                );
              }
            },
          },
        };
      },
    };
  }
  return undefined;
});

// Основное Electron API
contextBridge.exposeInMainWorld("electronAPI", {
  // Управление приложением
  closeApp: () => ipcRenderer.send("close-app"),
  toggleFullscreen: () => ipcRenderer.send("toggle-fullscreen"),
  getFullscreenMode: () => ipcRenderer.invoke("get-fullscreen-mode"),
  setFullscreenMode: (mode) => ipcRenderer.invoke("set-fullscreen-mode", mode),
  loadUrl: (url) => ipcRenderer.send("load-url", url),
  getAppVersion: async () => {
    return await ipcRenderer.invoke("get-app-version");
  },

  // Работа с хранилищем
  store: {
    get: async (key) => {
      return await ipcRenderer.invoke("store-get", key);
    },
    set: async (key, value) => {
      return await ipcRenderer.invoke("store-set", key, value);
    },
    has: async (key) => {
      return await ipcRenderer.invoke("store-has", key);
    },
    delete: async (key) => {
      return await ipcRenderer.invoke("store-delete", key);
    },
  },

  // Экспорт/импорт настроек
  exportSettingsToCloud: async () => {
    return await ipcRenderer.invoke("export-settings-to-cloud");
  },
  importSettingsFromCloud: async (id, pin) => {
    return await ipcRenderer.invoke("import-settings-from-cloud", id, pin);
  },
  exportSettingsToFile: async () => {
    return await ipcRenderer.invoke("export-settings-to-file");
  },
  importSettingsFromFile: async () => {
    return await ipcRenderer.invoke("import-settings-from-file");
  },

  // Торрент сервер
  torrServer: {
    // Управление процессом
    start: (args) => ipcRenderer.invoke("torrserver-start", args),
    stop: () => ipcRenderer.invoke("torrserver-stop"),
    restart: (args) => ipcRenderer.invoke("torrserver-restart", args),
    reinstall: (args) => ipcRenderer.invoke("torrserver-reinstall", args),
    getStatus: () => ipcRenderer.invoke("torrserver-status"),
    getServerInfo: (port) => ipcRenderer.invoke("torrserver-server-info", port),
    checkGstSupport: (port) => ipcRenderer.invoke("torrserver-check-gst", port),

    // Установка и обновление
    download: (version) => ipcRenderer.invoke("torrserver-download", version),
    checkUpdate: () => ipcRenderer.invoke("torrserver-check-update"),
    update: () => ipcRenderer.invoke("torrserver-update"),

    // Подписка на вывод процесса (для отображения логов в интерфейсе)
    onOutput: (callback) => {
      const subscription = (event, data) => callback(data);
      ipcRenderer.on("torrserver-output", subscription);

      // Подписываемся на вывод (инициируем отправку логов из main процесса)
      ipcRenderer.send("torrserver-subscribe-output");

      // Возвращаем функцию для отписки
      return () => {
        ipcRenderer.removeListener("torrserver-output", subscription);
      };
    },

    // Короткая форма для проверки статуса (удобно для кнопок)
    isRunning: async () => {
      const status = await ipcRenderer.invoke("torrserver-status");
      return status.running;
    },
    uninstall: (keepData = false) =>
      ipcRenderer.invoke("torrserver-uninstall", { keepData }),
    isInstalled: () => ipcRenderer.invoke("torrserver-is-installed"),
  },

  // Разные
  // Работа с папками
  folder: {
    open: (path) => ipcRenderer.invoke("folder-open", path),
  },

  player: {
    getAll: () => ipcRenderer.invoke("player-get-all"),
    getDefault: () => ipcRenderer.invoke("player-get-default"),
    setDefault: (playerId) =>
      ipcRenderer.invoke("player-set-default", playerId),
    find: (playerId) => ipcRenderer.invoke("player-find", playerId),
    findAll: () => ipcRenderer.invoke("player-find-all"),
    selectManual: () => ipcRenderer.invoke("player-select-manual"),
    getAvailable: () => ipcRenderer.invoke("player-get-available"),
    getAllWithDetails: () => ipcRenderer.invoke("player-get-all-with-details"),
    setDefaultAndSave: (playerId) =>
      ipcRenderer.invoke("player-set-default-and-save", playerId),
    prepareUaPlayerSession,
    setUaPlayerSessionProvider: (provider) => {
      if (typeof provider !== "function") return false;
      uaPlayerSessionProvider = provider;
      return true;
    },
    createUaPlayerSessionId: () => crypto.randomUUID(),
    onUaPlayerProgress: (callback) => {
      const subscription = (event, value) => callback(value);
      ipcRenderer.on("ua-player-session-progress", subscription);
      return () =>
        ipcRenderer.removeListener("ua-player-session-progress", subscription);
    },
    onUaPlayerResult: (callback) => {
      const subscription = (event, value) => callback(value);
      ipcRenderer.on("ua-player-session-result", subscription);
      return () => {
        ipcRenderer.removeListener("ua-player-session-result", subscription);
      };
    },
  },
});

console.log("Preload script loaded successfully");
