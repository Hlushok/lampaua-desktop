const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const exePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const iconPath = path.join(context.packager.projectDir, "assets", "win.ico");
  const rceditPath = findRcedit();

  if (!rceditPath) {
    throw new Error("Could not find rcedit to apply the Windows app icon.");
  }

  execFileSync(rceditPath, [exePath, "--set-icon", iconPath], {
    stdio: "inherit",
  });
};

function findRcedit() {
  const explicitPath = process.env.RCEDIT_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const cacheRoot =
    process.env.ELECTRON_BUILDER_CACHE ||
    path.join(os.homedir(), "AppData", "Local", "electron-builder", "Cache");
  const winCodeSignRoot = path.join(cacheRoot, "winCodeSign");

  return findFile(winCodeSignRoot, "rcedit-x64.exe");
}

function findFile(root, filename) {
  if (!fs.existsSync(root)) {
    return null;
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isFile() && entry.name === filename) {
      return entryPath;
    }

    if (entry.isDirectory()) {
      const found = findFile(entryPath, filename);
      if (found) {
        return found;
      }
    }
  }

  return null;
}
