const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

function verifyPackageInputBoundary() {
  const manifest = require(path.join(projectRoot, "package.json"));
  assert.deepEqual(manifest.build.files, [
    "assets/**/*",
    "src/**/*",
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses/**/*",
  ]);
}

function withMockedModules(mocks, callback) {
  const originalLoad = Module._load;

  Module._load = function loadMocked(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) {
      return mocks[request];
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return callback();
  } finally {
    Module._load = originalLoad;
  }
}

function freshRequire(filePath) {
  const resolved = require.resolve(filePath);
  delete require.cache[resolved];
  return require(resolved);
}

function createIpcRendererMock() {
  const listeners = new Map();
  const sent = [];

  function addListener(type, channel, callback) {
    const handlers = listeners.get(channel) || [];
    handlers.push({ type, callback });
    listeners.set(channel, handlers);
  }

  return {
    sent,
    send(channel, ...args) {
      sent.push({ channel, args });
    },
    sendSync() {
      return false;
    },
    invoke() {
      return Promise.resolve(undefined);
    },
    once(channel, callback) {
      addListener("once", channel, callback);
    },
    on(channel, callback) {
      addListener("on", channel, callback);
    },
    removeListener(channel, callback) {
      listeners.set(
        channel,
        (listeners.get(channel) || []).filter(
          (entry) => entry.callback !== callback,
        ),
      );
    },
    emitFromMain(channel, ...args) {
      const handlers = listeners.get(channel) || [];
      const remaining = [];

      for (const handler of handlers) {
        handler.callback({ sender: "main" }, ...args);
        if (handler.type !== "once") {
          remaining.push(handler);
        }
      }

      if (remaining.length) {
        listeners.set(channel, remaining);
      } else {
        listeners.delete(channel);
      }
    },
  };
}

function verifyPreloadContract() {
  let exposedRequire;
  let electronAPI;
  const ipcRenderer = createIpcRendererMock();
  const electronMock = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        if (name === "require") {
          exposedRequire = value;
        } else if (name === "electronAPI") {
          electronAPI = value;
        }
      },
    },
    ipcRenderer,
  };

  withMockedModules({ electron: electronMock }, () => {
    freshRequire(path.join(projectRoot, "src", "preload.js"));
  });

  const childProcess = exposedRequire("child_process");
  const firstPlayer = childProcess.spawn("vlc", ["first.mp4"], {});
  const spawnMessage = ipcRenderer.sent.find(
    (message) => message.channel === "child-process-spawn",
  );
  const firstId = spawnMessage.args[0];

  assert.equal(typeof firstPlayer.kill, "function");

  let closeArgs;
  firstPlayer.on("close", (code, signal) => {
    closeArgs = { code, signal };
  });
  ipcRenderer.emitFromMain(`child-process-spawn-close-${firstId}`, 0, null);
  assert.deepEqual(closeArgs, { code: 0, signal: null });

  firstPlayer.kill("SIGTERM");
  assert.deepEqual(ipcRenderer.sent.at(-1), {
    channel: "child-process-kill",
    args: [firstId, "SIGTERM"],
  });

  const secondPlayer = childProcess.spawn("vlc", ["second.mp4"], {});
  assert.equal(typeof secondPlayer.kill, "function");

  const preparedSession = {
    sessionId: "preload-session",
    payload: {
      schema: "lampaua-player-session-v1",
      items: [{ url: "https://stream.example.test/video.m3u8" }],
    },
    positionalUrl: "https://stream.example.test/video.m3u8",
  };
  assert.equal(
    electronAPI.player.prepareUaPlayerSession(preparedSession),
    true,
  );
  childProcess.spawn("vlc", ["unrelated.mp4"], {});
  const unrelatedSpawn = ipcRenderer.sent
    .filter((message) => message.channel === "child-process-spawn")
    .at(-1);
  assert.equal(unrelatedSpawn.args.length, 4);

  childProcess.spawn(
    "C:\\Program Files\\UA Player\\UAPlayer.exe",
    [preparedSession.positionalUrl],
    {},
  );
  const uaSpawn = ipcRenderer.sent
    .filter((message) => message.channel === "child-process-spawn")
    .at(-1);
  assert.deepEqual(uaSpawn.args.at(-1), {
    uaPlayerSession: preparedSession,
  });

  childProcess.spawn(
    "C:\\Program Files\\UA Player\\UAPlayer.exe",
    [preparedSession.positionalUrl],
    {},
  );
  const oneShotSpawn = ipcRenderer.sent
    .filter((message) => message.channel === "child-process-spawn")
    .at(-1);
  assert.equal(oneShotSpawn.args.length, 4);

  let receivedResult;
  const unsubscribe = electronAPI.player.onUaPlayerResult((value) => {
    receivedResult = value;
  });
  ipcRenderer.emitFromMain("ua-player-session-result", {
    sessionId: preparedSession.sessionId,
    result: { schema: "lampaua-player-result-v1" },
  });
  assert.equal(receivedResult.sessionId, preparedSession.sessionId);
  assert.equal(typeof unsubscribe, "function");
  let progressCalls = 0;
  const unsubscribeProgress = electronAPI.player.onUaPlayerProgress(
    () => progressCalls++,
  );
  ipcRenderer.emitFromMain("ua-player-session-progress", {
    sessionId: preparedSession.sessionId,
    sequence: 1,
    playback_results: [],
  });
  unsubscribeProgress();
  ipcRenderer.emitFromMain("ua-player-session-progress", {
    sessionId: preparedSession.sessionId,
    sequence: 2,
    playback_results: [],
  });
  assert.equal(progressCalls, 1);
  assert.match(
    electronAPI.player.createUaPlayerSessionId(),
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
  );
  assert.equal(electronAPI.player.savePath, undefined);

  const pluginSource = require("node:fs").readFileSync(
    path.join(projectRoot, "src", "plugin.js"),
    "utf8",
  );
  assert.equal(
    pluginSource.match(/applyTrustedPlayerSelection\(saveResult\.path\)/g)
      ?.length,
    2,
  );
  for (const hardCodedCallSite of [
    'Lampa.Noty.show("Медиа плееры не найдены!"',
    'title: "Выберите плеер по умолчанию"',
    'Lampa.Noty.show("Ошибка при выборе плеера"',
    "Lampa.Noty.show(`Выбран плеер:",
  ]) {
    assert.equal(pluginSource.includes(hardCodedCallSite), false);
  }
  for (const translationKey of [
    "app_settings_player_not_found",
    "app_settings_player_select_title",
    "app_settings_player_selecting",
    "app_settings_player_selected",
    "app_settings_player_select_error",
  ]) {
    assert.equal(pluginSource.includes(translationKey), true);
  }
}

async function verifyPlayerSelectionHandlers() {
  const ipcMain = createIpcMainMock();
  const selectedPlayer = {
    id: "ua_player",
    name: "UA Player",
    description: "UA Player for Windows",
    path: "C:\\Program Files\\UA Player\\UAPlayer.exe",
  };
  const mainWindow = { webContents: {} };
  let refreshCalls = 0;
  let savedWindow;
  const playerFinderMock = {
    async findAllPlayers() {
      refreshCalls += 1;
      return new Map([[selectedPlayer.id, selectedPlayer]]);
    },
    async getAllPlayers() {
      return [{ ...selectedPlayer, isDefault: true }];
    },
    async getDefaultPlayer() {
      return selectedPlayer;
    },
    async setDefaultPlayer(playerId) {
      return playerId === selectedPlayer.id;
    },
    async saveToLocalStorage(window) {
      savedWindow = window;
      return true;
    },
    getAvailablePlayersList() {
      return [];
    },
  };

  withMockedModules(
    {
      electron: { ipcMain },
      "../playerFinder": playerFinderMock,
      "../windowManager": { getMainWindow: () => mainWindow },
    },
    () => {
      freshRequire(
        path.join(
          projectRoot,
          "src",
          "modules",
          "ipcHandlers",
          "playerHandlers.js",
        ),
      )();
    },
  );

  const listed = await ipcMain.handlers.get("player-get-all-with-details")();
  assert.equal(refreshCalls, 1);
  assert.equal(listed.players[0].path, selectedPlayer.path);

  const selected = await ipcMain.handlers.get("player-set-default-and-save")(
    {},
    selectedPlayer.id,
  );
  assert.deepEqual(selected, {
    success: true,
    saved: true,
    path: selectedPlayer.path,
  });
  assert.equal(savedWindow, mainWindow);
}

function createIpcMainMock() {
  return {
    handlers: new Map(),
    on(channel, handler) {
      this.handlers.set(channel, handler);
    },
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
  };
}

async function verifyMainOnlyPlayerAuthorizationStore() {
  const ipcMain = createIpcMainMock();
  const values = new Map();
  const store = {
    onDidChange() {},
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
    },
    has(key) {
      return values.has(key);
    },
    delete(key) {
      values.delete(key);
    },
  };
  const windowManagerMock = { getMainWindow: () => null };
  withMockedModules(
    { electron: { ipcMain }, "../windowManager": windowManagerMock },
    () => {
      freshRequire(
        path.join(
          projectRoot,
          "src",
          "modules",
          "ipcHandlers",
          "storeHandlers.js",
        ),
      )(store);
    },
  );

  const setValue = ipcMain.handlers.get("store-set");
  const getValue = ipcMain.handlers.get("store-get");
  const hasValue = ipcMain.handlers.get("store-has");
  const deleteValue = ipcMain.handlers.get("store-delete");
  await setValue({}, "theme", "dark");
  assert.equal(await getValue({}, "theme"), "dark");
  for (const key of [
    "selectedPlayerPath",
    "trustedPlayerPath",
    "selectedPlayerPath.nested",
    "trustedPlayerPath.nested",
    "\\selectedPlayerPath",
    "\\trustedPlayerPath",
    "selected\\PlayerPath",
    "trusted\\PlayerPath",
    "[selectedPlayerPath]",
    "[trustedPlayerPath]",
    "theme.nested",
  ]) {
    assert.throws(() => setValue({}, key, "C:\\Windows\\System32\\cmd.exe"));
    assert.throws(() => getValue({}, key));
    assert.throws(() => hasValue({}, key));
    assert.throws(() => deleteValue({}, key));
  }
  for (const key of [
    { trustedPlayerPath: "C:\\Windows\\System32\\cmd.exe" },
    ["trustedPlayerPath"],
    null,
    42,
    "",
    "   ",
  ]) {
    assert.throws(() => setValue({}, key, "bypass"));
    assert.throws(() => getValue({}, key));
    assert.throws(() => hasValue({}, key));
    assert.throws(() => deleteValue({}, key));
  }

  const { publicStoreSnapshot } = freshRequire(
    path.join(projectRoot, "src", "modules", "storeAccessPolicy.js"),
  );
  assert.deepEqual(
    publicStoreSnapshot({
      theme: "dark",
      selectedPlayerPath: "legacy-untrusted",
      trustedPlayerPath: "main-only",
      "\\trustedPlayerPath": "escaped-main-only",
      "theme.nested": "nested-not-public",
    }),
    { theme: "dark" },
  );

  let importSettings;
  withMockedModules({ electron: { ipcMain: {}, dialog: {} } }, () => {
    ({ importSettings } = freshRequire(
      path.join(
        projectRoot,
        "src",
        "modules",
        "ipcHandlers",
        "settingsHandlers.js",
      ),
    ));
  });
  const importedValues = [];
  const importStore = {
    get(key) {
      return key === "lampaUrl" ? "https://portal.example.test" : undefined;
    },
    has() {
      return true;
    },
    set(key, value) {
      importedValues.push({ key, value });
    },
  };
  const importWindow = {
    webContents: {
      getURL: () => "https://unrelated.example.test",
    },
  };
  let pluginInjectionCount = 0;
  await importSettings(
    {
      app: {
        theme: "light",
        trustedPlayerPath: "C:\\Windows\\System32\\cmd.exe",
        "\\trustedPlayerPath": "C:\\Windows\\System32\\cmd.exe",
        "trusted\\PlayerPath": "C:\\Windows\\System32\\cmd.exe",
        "trustedPlayerPath.nested": "C:\\Windows\\System32\\cmd.exe",
        "[trustedPlayerPath]": "C:\\Windows\\System32\\cmd.exe",
      },
    },
    importStore,
    importWindow,
    () => {
      pluginInjectionCount += 1;
    },
  );
  assert.deepEqual(importedValues, [{ key: "theme", value: "light" }]);
  assert.equal(pluginInjectionCount, 1);
}

function createSender(name) {
  const sender = new EventEmitter();
  sender.name = name;
  sender.sent = [];
  sender.destroyed = false;
  sender.send = (channel, ...args) => {
    sender.sent.push({ channel, args });
  };
  sender.isDestroyed = () => sender.destroyed;
  sender.destroy = () => {
    sender.destroyed = true;
    sender.emit("destroyed");
  };
  return sender;
}

function createChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

async function verifyPlayerFinderContract() {
  const previousProgramFiles = process.env.ProgramFiles;
  const previousProgramW6432 = process.env.ProgramW6432;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const programFiles = "C:\\Program Files Contract";
  const localAppData = "C:\\Users\\Contract\\AppData\\Local";
  const installedPath = path.join(programFiles, "UA Player", "UAPlayer.exe");
  const legacyPath = path.join(
    localAppData,
    "Programs",
    "UA Player",
    "UAPlayer.exe",
  );
  const selectedPath = "D:\\Players\\UA Player\\UAPlayer.exe";
  const arbitraryPath = "C:\\Windows\\System32\\cmd.exe";
  const normalize = (filePath) => path.resolve(filePath).toLowerCase();
  const existingFiles = new Set(
    [installedPath, legacyPath, selectedPath, arbitraryPath].map(normalize),
  );
  const values = new Map([
    ["defaultPlayer", "ua_player"],
    ["trustedPlayerPath", selectedPath],
  ]);
  const storeMock = {
    delete(key) {
      values.delete(key);
    },
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    set(key, value) {
      values.set(key, value);
    },
  };
  const fsMock = {
    existsSync(filePath) {
      return existingFiles.has(normalize(filePath));
    },
    statSync(filePath) {
      if (!existingFiles.has(normalize(filePath))) {
        throw new Error("ENOENT");
      }
      return { isFile: () => true };
    },
  };

  process.env.ProgramFiles = programFiles;
  process.env.ProgramW6432 = programFiles;
  process.env.LOCALAPPDATA = localAppData;

  try {
    let playerFinder;
    withMockedModules({ fs: fsMock, "./storeManager": storeMock }, () => {
      playerFinder = freshRequire(
        path.join(projectRoot, "src", "modules", "playerFinder.js"),
      );
    });

    let players = await playerFinder.getAllPlayers();
    assert.equal(players[0].id, "ua_player");
    assert.equal(players[0].path, installedPath);

    existingFiles.delete(normalize(installedPath));
    await playerFinder.findAllPlayers();
    players = await playerFinder.getAllPlayers();
    assert.equal(players[0].path, legacyPath);

    existingFiles.delete(normalize(legacyPath));
    await playerFinder.findAllPlayers();
    players = await playerFinder.getAllPlayers();
    assert.equal(players[0].path, selectedPath);
    assert.equal(playerFinder.isAuthorizedPlayerPath(selectedPath), true);
    assert.equal(
      playerFinder.isAuthorizedPlayerPath(`${selectedPath}.evil`),
      false,
    );
    assert.equal(playerFinder.isUaPlayerPath(selectedPath), true);

    const scripts = [];
    const rendererStorage = new Map();
    const rendererContext = vm.createContext({
      console: { log() {} },
      localStorage: {
        getItem(key) {
          return rendererStorage.get(key) ?? null;
        },
        setItem(key, value) {
          rendererStorage.set(key, String(value));
        },
      },
      window: {
        Lampa: {
          Storage: {
            set(key, value) {
              rendererStorage.set(key, String(value));
            },
          },
        },
      },
    });
    const mainWindow = {
      webContents: {
        executeJavaScript(script) {
          scripts.push(script);
          return Promise.resolve(vm.runInContext(script, rendererContext));
        },
      },
    };
    assert.equal(
      await playerFinder.saveToLocalStorage(mainWindow, selectedPath),
      true,
    );
    assert.equal(values.get("trustedPlayerPath"), selectedPath);
    assert.equal(scripts.length, 1);
    assert.equal(rendererStorage.get("player_nw_path"), selectedPath);

    assert.equal(
      await playerFinder.saveToLocalStorage(mainWindow, arbitraryPath),
      false,
    );
    assert.equal(scripts.length, 1);

    assert.equal(
      await playerFinder.saveManualSelection(mainWindow, arbitraryPath),
      true,
    );
    assert.equal(values.get("trustedPlayerPath"), arbitraryPath);
    assert.equal(scripts.length, 2);
    assert.equal(rendererStorage.get("player_nw_path"), arbitraryPath);

    const missingPath = "D:\\Players\\Missing\\UAPlayer.exe";
    assert.equal(
      await playerFinder.saveToLocalStorage(mainWindow, missingPath),
      false,
    );
    assert.equal(values.get("trustedPlayerPath"), arbitraryPath);
  } finally {
    if (previousProgramFiles === undefined) {
      delete process.env.ProgramFiles;
    } else {
      process.env.ProgramFiles = previousProgramFiles;
    }
    if (previousProgramW6432 === undefined) {
      delete process.env.ProgramW6432;
    } else {
      process.env.ProgramW6432 = previousProgramW6432;
    }
    if (previousLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = previousLocalAppData;
    }
  }
}

async function verifyMainProcessContract() {
  const ipcMain = createIpcMainMock();
  const children = [];
  const electronMock = { ipcMain };
  const childProcessMock = {
    spawn() {
      const child = createChildProcess();
      children.push(child);
      return child;
    },
  };
  const whichMock = async (command) => command;
  const playerFinderMock = {
    isAuthorizedPlayerPath: () => false,
    isUaPlayerPath: () => false,
  };
  const sessionBridgeMock = {
    cleanupAll() {},
    cleanupOwner() {},
  };

  withMockedModules(
    {
      electron: electronMock,
      child_process: childProcessMock,
      which: whichMock,
      "../playerFinder": playerFinderMock,
      "../uaPlayerSessionBridge": sessionBridgeMock,
    },
    () => {
      const registerProcessHandlers = freshRequire(
        path.join(
          projectRoot,
          "src",
          "modules",
          "ipcHandlers",
          "processHandlers.js",
        ),
      );
      registerProcessHandlers();
    },
  );

  const spawnHandler = ipcMain.handlers.get("child-process-spawn");
  const killHandler = ipcMain.handlers.get("child-process-kill");
  assert.equal(typeof spawnHandler, "function");
  assert.equal(typeof killHandler, "function");

  const owner = createSender("owner");
  const intruder = createSender("intruder");

  await spawnHandler(
    { sender: owner },
    "first-player",
    "vlc",
    ["first.mp4"],
    {},
  );

  killHandler({ sender: intruder }, "first-player", "SIGTERM");
  assert.deepEqual(children[0].killCalls, []);

  killHandler({ sender: owner }, "first-player", "SIGTERM");
  assert.deepEqual(children[0].killCalls, ["SIGTERM"]);

  let exitMessage;
  let closeMessage;
  children[0].emit("exit", 0, null);
  children[0].emit("close", 0, null);
  exitMessage = owner.sent.find(
    (message) => message.channel === "child-process-spawn-exit-first-player",
  );
  closeMessage = owner.sent.find(
    (message) => message.channel === "child-process-spawn-close-first-player",
  );
  assert.deepEqual(exitMessage.args, [0, null]);
  assert.deepEqual(closeMessage.args, [0, null]);

  await spawnHandler(
    { sender: owner },
    "second-player",
    "vlc",
    ["second.mp4"],
    {},
  );
  owner.destroy();
  killHandler({ sender: owner }, "second-player", "SIGTERM");
  assert.deepEqual(children[1].killCalls, []);
}

async function verifyUaPlayerMainProcessContract() {
  const ipcMain = createIpcMainMock();
  const app = new EventEmitter();
  const owner = createSender("ua-owner");
  const intruder = createSender("ua-intruder");
  const executable = "C:\\Program Files\\UA Player\\UAPlayer.exe";
  const children = [];
  const spawnCalls = [];
  const launches = [];
  let cleanupAllCalls = 0;
  const childProcessMock = {
    spawn(command, args, options) {
      const child = createChildProcess();
      children.push(child);
      spawnCalls.push({ command, args, options });
      return child;
    },
  };
  const playerFinderMock = {
    isAuthorizedPlayerPath(filePath) {
      return filePath.toLowerCase() === executable.toLowerCase();
    },
    isUaPlayerPath(filePath) {
      return filePath.toLowerCase() === executable.toLowerCase();
    },
  };
  const sessionBridgeMock = {
    cleanupAll() {
      cleanupAllCalls += 1;
    },
    cleanupOwner(ownerToClean) {
      for (const state of launches) {
        if (state.options.owner !== ownerToClean || state.cleaned) continue;
        state.cleaned = true;
        state.cleanupCalls += 1;
      }
    },
    prepareLaunch(options) {
      if (options.sessionId === "fallback-session") {
        throw new Error("invalid prepared session");
      }
      const state = {
        cleanupCalls: 0,
        cleaned: false,
        finishCalls: 0,
        monitorStarts: 0,
        finished: false,
        options,
      };
      launches.push(state);
      const launch = {
        args: [
          "--payload-file",
          `C:\\Users\\Contract\\AppData\\Local\\LampaUA\\PlayerBridge\\v1\\11111111-1111-4111-8111-111111111111\\request.json`,
        ],
        cleanup() {
          if (state.cleaned) return;
          state.cleaned = true;
          state.cleanupCalls += 1;
        },
        startMonitoring({ onProgress, onResult }) {
          state.monitorStarts++;
          state.progress = onProgress;
          return {
            notifyChildClosed() {
              const result = launch.finish();
              if (result) onResult(result);
            },
          };
        },
        finish() {
          if (state.finished || state.cleaned) return null;
          state.finished = true;
          state.finishCalls += 1;
          state.cleaned = true;
          state.cleanupCalls += 1;
          return {
            schema: "lampaua-player-result-v1",
            end_by: "user",
            url: options.positionalUrl,
            position: 10_000,
            duration: 20_000,
            playlist_index: 0,
            playback_results: [],
          };
        },
        sessionId: options.sessionId,
        usesSession: true,
      };
      return launch;
    },
  };
  const whichMock = async (command) => command;

  withMockedModules(
    {
      electron: { app, ipcMain },
      child_process: childProcessMock,
      which: whichMock,
      "../playerFinder": playerFinderMock,
      "../uaPlayerSessionBridge": sessionBridgeMock,
    },
    () => {
      const registerProcessHandlers = freshRequire(
        path.join(
          projectRoot,
          "src",
          "modules",
          "ipcHandlers",
          "processHandlers.js",
        ),
      );
      registerProcessHandlers();
    },
  );

  const spawnHandler = ipcMain.handlers.get("child-process-spawn");
  const killHandler = ipcMain.handlers.get("child-process-kill");
  const session = {
    sessionId: "main-session",
    payload: {
      schema: "lampaua-player-session-v1",
      items: [{ url: "https://stream.example.test/video.m3u8" }],
    },
    positionalUrl: "https://stream.example.test/video.m3u8",
  };

  await spawnHandler(
    { sender: owner },
    "basename-only",
    "UAPlayer.exe",
    [session.positionalUrl],
    {},
    { uaPlayerSession: session },
  );
  assert.equal(children.length, 0);

  await spawnHandler(
    { sender: owner },
    "exact-player",
    executable,
    [session.positionalUrl],
    { windowsHide: false },
    { uaPlayerSession: session },
  );
  assert.equal(children.length, 1);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.owner, owner);
  assert.equal(launches[0].options.executablePath, executable);
  assert.equal(
    launches[0].monitorStarts,
    1,
    "main must monitor before player exit",
  );
  launches[0].progress({
    sequence: 1,
    playback_results: [
      {
        playlist_index: 0,
        sequence: 1,
        position: 10_000,
        duration: 20_000,
        completed: false,
      },
    ],
  });
  const liveProgress = owner.sent.find(
    (message) => message.channel === "ua-player-session-progress",
  );
  assert.equal(liveProgress.args[0].sessionId, session.sessionId);
  assert.equal(liveProgress.args[0].playback_results[0].position, 10_000);
  assert.deepEqual(spawnCalls[0].args, [
    "--payload-file",
    "C:\\Users\\Contract\\AppData\\Local\\LampaUA\\PlayerBridge\\v1\\11111111-1111-4111-8111-111111111111\\request.json",
  ]);

  killHandler({ sender: intruder }, "exact-player", "SIGTERM");
  assert.deepEqual(children[0].killCalls, []);
  killHandler({ sender: owner }, "exact-player", "SIGTERM");
  assert.deepEqual(children[0].killCalls, ["SIGTERM"]);

  children[0].stdout.emit("data", "stdout");
  children[0].stderr.emit("data", "stderr");
  children[0].emit("exit", 0, null);
  assert.equal(launches[0].finishCalls, 0);
  children[0].emit("close", 0, null);
  children[0].emit("close", 0, null);
  assert.equal(launches[0].finishCalls, 1);
  assert.equal(launches[0].cleanupCalls, 1);
  const resultMessages = owner.sent.filter(
    (message) => message.channel === "ua-player-session-result",
  );
  assert.equal(resultMessages.length, 1);
  assert.equal(resultMessages[0].args[0].sessionId, session.sessionId);
  assert.equal(intruder.sent.length, 0);
  for (const suffix of ["stdout", "stderr", "exit", "close"]) {
    assert.equal(
      owner.sent.some(
        (message) =>
          message.channel === `child-process-spawn-${suffix}-exact-player`,
      ),
      true,
    );
  }

  const errorOwner = createSender("error-owner");
  await spawnHandler(
    { sender: errorOwner },
    "error-player",
    executable,
    [session.positionalUrl],
    {},
    {
      uaPlayerSession: { ...session, sessionId: "error-session" },
    },
  );
  children[1].emit("error", new Error("spawn failed"));
  children[1].emit("close", 1, null);
  assert.equal(launches[1].cleanupCalls, 1);
  assert.equal(
    errorOwner.sent.some(
      (message) => message.channel === "child-process-spawn-error-error-player",
    ),
    true,
  );

  const destroyedOwner = createSender("destroyed-owner");
  await spawnHandler(
    { sender: destroyedOwner },
    "destroyed-player",
    executable,
    [session.positionalUrl],
    {},
    {
      uaPlayerSession: { ...session, sessionId: "destroyed-session" },
    },
  );
  children[2].emit("exit", 0, null);
  destroyedOwner.destroy();
  assert.equal(launches[2].cleanupCalls, 1);
  children[2].emit("close", 0, null);
  assert.equal(
    destroyedOwner.sent.some(
      (message) => message.channel === "ua-player-session-result",
    ),
    false,
  );

  const fallbackOwner = createSender("fallback-owner");
  await spawnHandler(
    { sender: fallbackOwner },
    "fallback-player",
    executable,
    [session.positionalUrl],
    {},
    {
      uaPlayerSession: { ...session, sessionId: "fallback-session" },
    },
  );
  assert.deepEqual(spawnCalls[3].args, ["--url", session.positionalUrl]);
  children[3].emit("close", 0, null);
  assert.equal(
    fallbackOwner.sent.some(
      (message) => message.channel === "ua-player-session-result",
    ),
    false,
  );

  const quitOwner = createSender("quit-owner");
  await spawnHandler(
    { sender: quitOwner },
    "quit-player",
    executable,
    [session.positionalUrl],
    {},
    {
      uaPlayerSession: { ...session, sessionId: "quit-session" },
    },
  );
  app.emit("before-quit");
  assert.equal(launches[3].cleanupCalls, 1);
  assert.equal(cleanupAllCalls, 1);
}

async function main() {
  verifyPackageInputBoundary();
  await verifyPlayerFinderContract();
  verifyPreloadContract();
  await verifyPlayerSelectionHandlers();
  await verifyMainOnlyPlayerAuthorizationStore();
  await verifyMainProcessContract();
  await verifyUaPlayerMainProcessContract();
  console.log("External player process proxy contract verified");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
