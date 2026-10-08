const { build } = require("../package.json");

module.exports = {
  ...build,
  directories: { ...build.directories, output: "dist/legacy" },
  win: {
    ...build.win,
    target: [{ target: "nsis", arch: ["ia32", "arm64"] }],
  },
  nsis: { ...build.nsis, buildUniversalInstaller: false },
};
