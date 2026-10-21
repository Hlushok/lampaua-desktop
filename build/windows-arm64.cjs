const { build } = require("../package.json");

module.exports = {
  ...build,
  directories: { ...build.directories, output: "dist/arm64" },
  win: {
    ...build.win,
    target: [{ target: "nsis", arch: ["arm64"] }],
  },
  nsis: { ...build.nsis, buildUniversalInstaller: false },
};
