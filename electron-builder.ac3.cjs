const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const packageJson = require("./package.json");
const applyWindowsIcon = require("./scripts/afterPack.js");

module.exports = {
  ...packageJson.build,
  electronVersion: "44.4.4",
  electronDist: join(__dirname, ".cache", "electron-ac3-eac3"),
  artifactName: "lampaua-${arch}-${version}-ac3.${ext}",
  directories: {
    ...packageJson.build.directories,
    output: "dist/ac3",
  },
  publish: {
    ...packageJson.build.publish,
    publishAutoUpdate: false,
  },
  afterPack: async (context) => {
    await applyWindowsIcon(context);
    execFileSync(
      process.execPath,
      [
        join(__dirname, "scripts", "verify-electron-runtime.cjs"),
        join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.exe`,
        ),
        join(context.appOutDir, "ffmpeg.dll"),
      ],
      { stdio: "inherit", windowsHide: true },
    );
  },
  win: {
    ...packageJson.build.win,
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
  },
};
