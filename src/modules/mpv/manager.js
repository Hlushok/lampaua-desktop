const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { isMpvTest } = require("./testMode");
const policy = require("./policy");
let pending;
function getService() {
  if (!isMpvTest()) throw new Error("MPV is enabled only in the test package");
  if (!pending) {
    const runtime = path.resolve(__dirname, "../../mpv-runtime");
    pending = import(
      pathToFileURL(path.join(runtime, "lib/main/index.js")).href
    ).then(({ createMpvMain }) =>
      createMpvMain({
        addonPath: path.join(runtime, "native/mpv_addon.node"),
        authorize: policy.authorize,
        normalizeSource: policy.normalizeSource,
      }),
    );
  }
  return pending;
}
async function attachMpvWindow(window) {
  (await getService()).attachWindow(window);
}
async function detachMpvWindow(window) {
  if (pending) await (await pending).detachWindow(window);
}
async function disposeMpv() {
  if (pending) await (await pending).dispose();
}
module.exports = { attachMpvWindow, detachMpvWindow, disposeMpv };
