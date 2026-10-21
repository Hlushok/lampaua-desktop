const assert = require("node:assert/strict");
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  sharedTexture,
} = require("electron");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = path.resolve(option("--output"));
const library = path.resolve(option("--lib"));
const addon = path.resolve(option("--addon"));
const cycles = Number(option("--cycles"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const zero = { textureCount: 0, handleCount: 0, threadCount: 0 };
const evidence = [];
const errors = [];
let window;
let config;
let reports;
let ready;

app.setPath("userData", path.join(output, "profile"));
app.commandLine.appendSwitch("no-first-run");
app.on("window-all-closed", () => {});

function authorized(event) {
  try {
    return (
      window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    );
  } catch {
    return false;
  }
}
async function until(check, message, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(message);
    await sleep(5);
  }
}
async function open(callbackFailure) {
  reports = [];
  config = {
    width: 320,
    height: 180,
    fps: 60,
    lifecycle: true,
    callbackFailure,
  };
  let readyTimer;
  const becameReady = new Promise((resolve, reject) => {
    ready = resolve;
    readyTimer = setTimeout(
      () => reject(new Error("Lifecycle renderer not ready")),
      15000,
    );
  });
  window = new BrowserWindow({
    width: 320,
    height: 180,
    useContentSize: true,
    show: true,
    title: "LampaUa D3D11 Lifecycle Test",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      additionalArguments: [`--transport-lib=${library}`],
    },
  });
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  const [width, height] = window.getContentSize();
  config.width = Math.round(width * scale);
  config.height = Math.round(height * scale);
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    window.show();
    window.focus();
    await becameReady;
  } finally {
    clearTimeout(readyTimer);
  }
}
async function bind(id) {
  const listener = (event, value) => {
    if (authorized(event) && value === id) bound = true;
  };
  let bound = false;
  ipcMain.on("gate:bound", listener);
  try {
    window.webContents.send("gate:bind", id);
    await until(() => bound, "Lifecycle receiver not bound");
  } finally {
    ipcMain.removeListener("gate:bound", listener);
  }
}
async function close() {
  const old = window;
  old.close();
  await until(() => old.isDestroyed(), "Lifecycle window did not close");
  window = undefined;
}

async function run() {
  const { D3d11Transport } = await import(
    pathToFileURL(path.join(library, "main/d3d11-transport.js"))
  );
  const native = require(addon);
  assert.deepEqual(native.getD3d11TestResources(), zero);
  async function cycle(index, callbackFailure = false) {
    await open(callbackFailure);
    const id = `gate-lifecycle-${index}`;
    await bind(id);
    const producer = await native.createD3d11TestProducer(config);
    assert.equal(producer.stats().hardware, true);
    const released = [];
    const failures = [];
    const transport = new D3d11Transport({
      playerId: id,
      owner: window.webContents,
      ipcMain,
      sharedTexture,
      authorize: authorized,
      releaseNative: async (key) => {
        const accepted = await producer.releaseFrame(key);
        released.push({ ...key, accepted });
        return accepted;
      },
      onError: (error) =>
        failures.push({ code: error.code, message: error.message }),
    });
    async function send(count, generation) {
      for (let n = 0; n < count; n++) {
        const frame = await producer.nextFrame();
        assert.ok(frame, "A bounded native slot must be available");
        assert.equal(frame.key.generation, generation);
        await transport.send(frame);
      }
    }
    // Keep old-generation imports in flight while changing the real window size.
    await send(callbackFailure ? 1 : 3, 1);
    let peakTextures = producer.stats().textureCount;
    if (!callbackFailure) {
      window.setContentSize(352 + (index % 2) * 16, 198 + (index % 2) * 9);
      await producer.resize({ width: 352, height: 198, generation: 2 });
      transport.invalidate(2);
      peakTextures = Math.max(peakTextures, producer.stats().textureCount);
      await send(3, 2);
    }
    await until(
      () => transport.stats().leases === 0,
      "Lifecycle GPU leases did not drain",
    );
    await until(
      () =>
        reports.some((item) =>
          callbackFailure ? item.type === "heartbeat" : item.type === "pixel",
        ),
      "Lifecycle renderer stopped responding",
    );
    assert.ok(peakTextures <= 6);
    assert.equal(released.length, callbackFailure ? 1 : 6);
    assert.ok(released.every((item) => item.accepted));
    assert.equal(
      new Set(
        released.map(
          (item) => `${item.generation}:${item.slot}:${item.sequence}`,
        ),
      ).size,
      released.length,
    );
    if (callbackFailure)
      assert.deepEqual(
        failures.map((item) => item.code),
        ["GPU_FRAME_CALLBACK"],
      );
    else assert.deepEqual(failures, []);
    assert.ok(
      reports
        .filter((item) => item.type === "pixel")
        .every((item) => item.decodedSequence === item.sequence % 0x1000000),
    );
    assert.deepEqual(
      reports.filter((item) => item.type === "error"),
      [],
    );
    const heartbeatStart = performance.now();
    for (let n = 0; n < 10; n++)
      assert.equal(
        await window.webContents.executeJavaScript("gpuGate.heartbeat()"),
        true,
      );
    assert.ok(
      performance.now() - heartbeatStart < 1000,
      "IPC is blocked after GPU release",
    );
    const finalStats = producer.stats();
    assert.equal(finalStats.activeLeases, 0);
    assert.equal(finalStats.releases, callbackFailure ? 1 : 6);
    await transport.dispose();
    const closing = producer.destroy();
    assert.strictEqual(producer.destroy(), closing);
    await closing;
    assert.deepEqual(native.getD3d11TestResources(), zero);
    await close();
    assert.deepEqual(native.getD3d11TestResources(), zero);
    evidence.push({
      index,
      callbackFailure,
      peakTextures,
      finalStats,
      released,
      pixels: reports.filter((item) => item.type === "pixel").length,
      resourcesAfterClose: native.getD3d11TestResources(),
    });
  }
  for (let index = 1; index <= cycles; index++) {
    await cycle(index);
    if (index % 10 === 0) console.log(`GPU lifecycle: ${index}/${cycles}`);
  }
  await cycle(cycles + 1, true);
  const result = {
    completedCycles: cycles,
    callbackFailureReleased: true,
    resourcesAfterClose: native.getD3d11TestResources(),
    errors,
    passed: cycles >= 50,
  };
  fs.writeFileSync(
    path.join(output, "evidence.json"),
    JSON.stringify({ result, cycles: evidence }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}

app
  .whenReady()
  .then(async () => {
    fs.mkdirSync(output, { recursive: true });
    ipcMain.handle("gate:config", (event) => {
      if (!authorized(event)) throw new Error("Unauthorized lifecycle config");
      return config;
    });
    ipcMain.handle("gate:heartbeat", (event) => {
      if (!authorized(event))
        throw new Error("Unauthorized lifecycle heartbeat");
      return true;
    });
    ipcMain.handle("gate:ready", (event) => {
      if (authorized(event)) {
        ready();
        return true;
      }
      return false;
    });
    ipcMain.on("gate:report", (event, value) => {
      if (authorized(event)) reports.push(value);
    });
    await run();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "failure.json"),
      JSON.stringify({ message: error.message, evidence, reports }, null, 2),
    );
    app.exit(1);
  });
