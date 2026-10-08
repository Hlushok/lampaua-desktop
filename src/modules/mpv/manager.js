const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");
const { pathToFileURL } = require("node:url");
const { isMpvEnabled } = require("./testMode");
const policy = require("./policy");
let pending;
function diagnostic(type, data) {
  const knownErrors = [
    "loading failed",
    "unrecognized file format",
    "audio/video initialization failed",
  ];
  const entry = {
    at: new Date().toISOString(),
    type,
    playerId: data.playerId,
    format: data.format,
  };
  if (data.error)
    entry.error =
      /^HTTP [45]\d{2}$/.test(data.error) || knownErrors.includes(data.error)
        ? data.error
        : "media failure";
  try {
    const directory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "mpv-test.jsonl");
    if (fs.existsSync(file) && fs.statSync(file).size > 1048576) {
      const previous = `${file}.previous`;
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(file, previous);
    }
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // Diagnostics must not interrupt playback or shutdown.
  }
}
function getService() {
  if (!isMpvEnabled()) throw new Error("MPV is not enabled in this package");
  if (!pending) {
    const runtime = path.resolve(__dirname, "../../mpv-runtime");
    pending = import(
      pathToFileURL(path.join(runtime, "lib/main/index.js")).href
    ).then(({ createMpvMain }) =>
      createMpvMain({
        addonPath: path.join(runtime, "native/mpv_addon.node"),
        authorize: policy.authorize,
        normalizeSource: policy.normalizeSource,
        diagnostic,
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
