const path = require("node:path");
const pkg = require("../../../package.json");

function isMpvTest() {
  return pkg.lampauaMpvTest === true;
}

function isMpvEnabled() {
  return (
    isMpvTest() ||
    (pkg.lampauaMpv === true &&
      process.platform === "win32" &&
      process.arch === "x64")
  );
}
function isMpvD3d11Test() {
  return (
    isMpvTest() &&
    pkg.lampauaMpvD3d11Test === true &&
    process.platform === "win32" &&
    process.arch === "x64"
  );
}
function isMpvD3d11Enabled() {
  return (
    isMpvD3d11Test() ||
    (!isMpvTest() &&
      pkg.lampauaMpv === true &&
      pkg.lampauaMpvD3d11 === true &&
      process.platform === "win32" &&
      process.arch === "x64")
  );
}

function bootstrapMpvTest(app) {
  if (!isMpvTest() || process.platform !== "win32") {
    throw new Error("MPV test bootstrap requires the Windows test package");
  }
  const run = process.argv.find((arg) => arg.startsWith("--mpv-test-run="));
  const id = run?.slice("--mpv-test-run=".length);
  if (run && !/^[a-z0-9-]{1,64}$/.test(id)) {
    throw new Error("Invalid MPV test run id");
  }
  const profile = `LampaUaDesktopMpv${isMpvD3d11Test() ? "D3d11" : ""}Test${id ? `-${id}` : ""}`;
  app.setName("LampaUa Desktop MPV Test");
  app.setAppUserModelId("com.lampaua.desktop.mpvtest");
  app.setPath("userData", path.join(app.getPath("appData"), profile));
  app.setPath("sessionData", path.join(app.getPath("appData"), profile));
}

module.exports = {
  isMpvTest,
  isMpvEnabled,
  isMpvD3d11Test,
  isMpvD3d11Enabled,
  bootstrapMpvTest,
};
