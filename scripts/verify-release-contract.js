const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const runtime = require("../build/libmpv-runtime.json");
const inventory = require("../licenses/libmpv/inventory.json");
assert.equal(inventory.dllSha256, runtime.dllSha256);
assert.equal(inventory.repositoryCommit, runtime.sourceBuildCommit);
assert.equal(
  inventory.pinnedInputs,
  Object.keys(require("../build/libmpv-source-lock.json").components).length,
);
assert.equal(runtime.sourceParts.length, 2);
runtime.sourceParts.forEach((part, index) => {
  assert.equal(
    part.asset,
    `${runtime.sourceAsset}.${String(index + 1).padStart(3, "0")}`,
  );
  assert.match(part.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(part.size) && part.size > 0 && part.size < 2 ** 31,
  );
});
assert.match(runtime.sourceSha256, /^[a-f0-9]{64}$/);
const noticeRoot = path.join(root, "licenses/libmpv");
const reviews = new Map(
  inventory.manualReview.map((review) => [review.component, review]),
);
for (const component of inventory.components) {
  assert.ok(component.notices.length || reviews.has(component.name));
  const notices = [
    ...component.notices,
    ...(reviews.get(component.name)?.files || []),
  ];
  for (const notice of notices) {
    const file = path.resolve(noticeRoot, notice.file);
    assert.ok(file.startsWith(noticeRoot + path.sep));
    const data = fs.readFileSync(file);
    assert.equal(data.length, notice.size);
    assert.equal(
      crypto.createHash("sha256").update(data).digest("hex"),
      notice.sha256,
    );
  }
}
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
    runtime.dllSha256,
    "5abe5c6a7714025a9af8fba34313b4fab762333f45b8d34ad13c9f220421671d",
  );
  console.log(
    "2.0.0 identity, tested runtime pins and production updater contract verified",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
