const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

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
    removeListener() {},
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
  const ipcRenderer = createIpcRendererMock();
  const electronMock = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        if (name === "require") {
          exposedRequire = value;
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
}

function createIpcMainMock() {
  return {
    handlers: new Map(),
    on(channel, handler) {
      this.handlers.set(channel, handler);
    },
  };
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

  withMockedModules(
    {
      electron: electronMock,
      child_process: childProcessMock,
      which: whichMock,
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

async function main() {
  verifyPreloadContract();
  await verifyMainProcessContract();
  console.log("External player process proxy contract verified");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
