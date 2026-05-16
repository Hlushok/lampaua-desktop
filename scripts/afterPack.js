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
  const rceditPath = findRcedit(context.packager.projectDir);

  if (!rceditPath) {
    throw new Error("Could not find rcedit to apply the Windows app icon.");
  }

  execFileSync(rceditPath, [exePath, "--set-icon", iconPath], {
    stdio: "inherit",
  });
};

function findRcedit(projectDir) {
  const explicitPath = process.env.RCEDIT_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const localRceditPaths = [
    path.join(projectDir, "node_modules", "rcedit", "bin", "rcedit-x64.exe"),
    path.join(projectDir, "node_modules", "rcedit", "bin", "rcedit.exe"),
  ];

  for (const localPath of localRceditPaths) {
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  const defaultCacheRoot =
    process.env.ELECTRON_BUILDER_CACHE ||
    path.join(os.homedir(), "AppData", "Local", "electron-builder", "Cache");
  const cacheRoots = [
    path.join(defaultCacheRoot, "winCodeSign"),
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "electron-builder",
      "Cache",
      "winCodeSign",
    ),
  ];

  for (const cacheRoot of cacheRoots) {
    const found = findFile(cacheRoot, "rcedit-x64.exe");
    if (found) {
      return found;
    }
  }

  return null;
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
