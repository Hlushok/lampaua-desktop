const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
assert.match(pkg.version, /^2\.\d+\.\d+$/);
assert.equal(pkg.license, "GPL-3.0-or-later");
assert.equal(pkg.build.appId, "com.lampaua.desktop");
assert.equal(pkg.productName, "LampaUa");
assert.equal(pkg.build.publish.owner, "Hlushok");
assert.equal(pkg.build.publish.repo, "lampaua-desktop");
assert.equal(pkg.lampauaMpvTest, undefined);
const updater = new EventEmitter();
let checks = 0;
let installed = 0;
let choice = 0;
updater.checkForUpdates = async () => {
  checks++;
};
updater.quitAndInstall = () => {
  installed++;
};
const timers = [];
const exported = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(root, "src/modules/autoUpdater.js"), "utf8"),
  {
    module: exported,
    console,
    setTimeout: (callback) => timers.push(callback),
    require(name) {
      if (name === "electron-updater") return { autoUpdater: updater };
      if (name === "electron")
        return {
          dialog: { showMessageBox: async () => ({ response: choice }) },
          shell: { openExternal() {} },
        };
      if (name === "./storeManager") return { get: () => true };
      if (name === "./mpv/testMode") return { isMpvTest: () => false };
      throw new Error(name);
    },
  },
);
async function main() {
  exported.exports.setupAutoUpdater();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.disableDifferentialDownload, true);
  timers[0]();
  assert.equal(checks, 1);
  updater.emit("update-downloaded", { version: "2.0.0" });
  await Promise.resolve();
  assert.equal(installed, 1);
  choice = 1;
  updater.emit("update-downloaded", { version: "2.0.1" });
  await Promise.resolve();
  assert.equal(installed, 1, "Later must not force an install");
  assert.equal(
    require("../build/electron-runtime-ac3-eac3.json").version,
    "44.4.4",
  );
  assert.equal(
    require("../build/libmpv-runtime.json").dllSha256,
    "bde5eb098b65b0908be4176c2f331bab25a101881a9232b8beef0c0d3ab8ad87",
  );
  console.log(
    "2.0.0 identity, tested runtime pins and production updater contract verified",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
