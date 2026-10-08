const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const cache = path.join(root, ".cache/mpv-desktop-test");
const prototype = path.join(root, ".cache/mpv-prototype");
const vendor = path.join(root, "third_party/electron-mpv-video");
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: root, stdio: "inherit", ...options });
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (file) =>
      !["node_modules", "build", ".git"].includes(path.basename(file)) &&
      !/\.d\.(ts|cts)$/.test(file),
  });
}
function packageDirectory(name, from) {
  const directories =
    createRequire(path.join(from, "package.json")).resolve.paths(name) || [];
  for (const directory of directories) {
    const folder = path.join(directory, name);
    const file = path.join(folder, "package.json");
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).name === name)
      return folder;
  }
  throw new Error(`Cannot resolve package ${name}`);
}
function stageDependencies(stage, dependencies) {
  const done = new Set();
  function add(name, from, parent) {
    const source = packageDirectory(name, from);
    const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json")));
    let target = path.join(stage, "node_modules", name);
    if (
      fs.existsSync(path.join(target, "package.json")) &&
      JSON.parse(fs.readFileSync(path.join(target, "package.json"))).version !==
        pkg.version
    )
      target = path.join(parent, "node_modules", name);
    if (done.has(target)) return;
    done.add(target);
    copy(source, target);
    for (const dependency of Object.keys(pkg.dependencies || {}))
      add(dependency, source, target);
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) {
      try {
        packageDirectory(dependency, source);
      } catch {
        continue;
      }
      add(dependency, source, target);
    }
  }
  for (const name of Object.keys(dependencies)) add(name, root, stage);
}
async function main() {
  fs.mkdirSync(cache, { recursive: true });
  const electronInputs = {
    "electron.exe":
      "9c9f11c8601c0165ffba7c3a3394b5106502ccc297e0be8b828b3f5e7421ba07",
    "ffmpeg.dll":
      "af461f247e8bd008eee24e9954be9a6aed6402c50d716e16fab2b8a774ed98fa",
    "vulkan-1.dll":
      "f7d669b9239cd7a460d609cb60c202dccac5253ffaf68131cc09c969fe59334a",
  };
  for (const [file, digest] of Object.entries(electronInputs))
    if (hash(path.join(prototype, "electron", file)) !== digest)
      throw new Error(`Official Electron input hash mismatch: ${file}`);
  const expectedSdk =
    "1e94b722d9d1b701406250c73ee37d73cd0045cdf47bdd7a54f2bea1b513465f";
  if (hash(path.join(prototype, "libmpv-sdk.7z")) !== expectedSdk)
    throw new Error("SDK archive hash mismatch");
  const dll = path.join(prototype, "sdk/libmpv-2.dll");
  if (
    hash(dll) !==
    "bde5eb098b65b0908be4176c2f331bab25a101881a9232b8beef0c0d3ab8ad87"
  )
    throw new Error("libmpv DLL hash mismatch");
  const dependencies = path.join(
    prototype,
    "vendor/electron-mpv-video/node_modules",
  );
  const env = {
    ...process.env,
    NODE_PATH: dependencies,
    MPV_INCLUDE_DIR: path.join(prototype, "sdk/include"),
    MPV_LIB: path.join(prototype, "sdk/lib/mpv.lib"),
    NODE_GYP_FORCE_PYTHON:
      process.env.NODE_GYP_FORCE_PYTHON ||
      "C:/Users/stpuh/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe",
  };
  run(
    process.execPath,
    [
      path.join(root, "node_modules/node-gyp/bin/node-gyp.js"),
      "rebuild",
      "--directory",
      path.join(vendor, "native/mpv-addon"),
      "--target=43.7.5",
      "--dist-url=https://electronjs.org/headers",
      `--devdir=${path.join(prototype, "headers")}`,
    ],
    { env },
  );
  run(process.execPath, [
    path.join(dependencies, "typescript/bin/tsc"),
    "-p",
    path.join(vendor, "tsconfig.lib.json"),
    "--outDir",
    path.join(cache, "lib"),
  ]);
  const stage = path.join(cache, `package-${Date.now()}`);
  for (const file of ["src", "assets", "LICENSE"])
    copy(path.join(root, file), path.join(stage, file));
  const runtime = path.join(stage, "src/mpv-runtime");
  copy(path.join(cache, "lib"), path.join(runtime, "lib"));
  fs.writeFileSync(
    path.join(runtime, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  const { rolldown } = await import(
    pathToFileURL(path.join(dependencies, "rolldown/dist/index.mjs")).href
  );
  const bundle = await rolldown({
    input: path.join(root, "src/mpv/renderer-entry.mjs"),
    platform: "browser",
  });
  await bundle.write({
    file: path.join(runtime, "renderer.js"),
    format: "iife",
  });
  await bundle.close();
  for (const [from, to] of [
    [
      path.join(vendor, "native/mpv-addon/build/Release/mpv_addon.node"),
      "native/mpv_addon.node",
    ],
    [dll, "native/libmpv-2.dll"],
    [path.join(vendor, "LICENSE"), "LICENSE-electron-mpv-video.txt"],
    [path.join(vendor, "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md"],
    [path.join(vendor, "PROVENANCE.md"), "PROVENANCE.md"],
    [
      path.join(vendor, "native/mpv-addon/src/mpv_addon.cc"),
      "mpv-addon-source.txt",
    ],
  ])
    copy(from, path.join(runtime, to));
  const original = require("../package.json");
  const pkg = {
    ...original,
    name: "lampaua-desktop-mpv-test",
    productName: "LampaUa Desktop MPV Test",
    version: "1.5.24-mpv.3",
    main: "src/mpv-test-main.js",
    lampauaMpvTest: true,
    private: true,
  };
  for (const key of [
    "build",
    "files",
    "scripts",
    "devDependencies",
    "commit-and-tag-version",
  ])
    delete pkg[key];
  fs.writeFileSync(
    path.join(stage, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  stageDependencies(stage, pkg.dependencies);
  const hashes = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else
        hashes[path.relative(stage, file).replaceAll("\\", "/")] = hash(file);
    }
  }
  for (const directory of ["src", "assets"]) walk(path.join(stage, directory));
  hashes["package.json"] = hash(path.join(stage, "package.json"));
  fs.writeFileSync(
    path.join(stage, "build-manifest.json"),
    JSON.stringify(
      {
        electron: "43.7.5",
        electronArchiveSha256:
          "7acfa0646793f912ff983c8db8c3a145dc18ee40fe3d11a01840fd59cb76e5a2",
        electronInputs,
        vendorCommit: "4944079b4133715848ea3c3bdaf99742b8c68406",
        sdkSha256: expectedSdk,
        hashes,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(cache, "stage-latest.json"),
    JSON.stringify({ stage }, null, 2),
  );
  run(process.execPath, [path.join(root, "scripts/verify-mpv-staging.js")]);
  if (process.argv.includes("--stage-only")) return;
  const { build, Platform, Arch } = require("electron-builder");
  const output = path.join(root, "dist/mpv-desktop-test");
  const targets = Platform.WINDOWS.createTarget(
    process.argv.includes("--unpacked") ? "dir" : "portable",
    Arch.x64,
  );
  const artifacts = await build({
    projectDir: stage,
    targets,
    publish: "never",
    config: {
      appId: "com.lampaua.desktop.mpvtest",
      productName: "LampaUa Desktop MPV Test",
      electronVersion: "43.7.5",
      electronDist: path.join(prototype, "electron"),
      directories: { app: stage, output },
      files: ["**/*"],
      asar: false,
      npmRebuild: false,
      publish: null,
      artifactName: "lampaua-desktop-${arch}-${version}-portable.${ext}",
      win: {
        target: [{ target: "portable", arch: ["x64"] }],
        icon: path.join(root, "assets/win.ico"),
        signExecutable: false,
      },
      portable: { requestExecutionLevel: "user" },
      afterPack(context) {
        for (const [file, expected] of Object.entries(hashes))
          if (
            hash(path.join(context.appOutDir, "resources/app", file)) !==
            expected
          )
            throw new Error(`Packaged hash mismatch: ${file}`);
        if (!fs.existsSync(path.join(context.appOutDir, "vulkan-1.dll")))
          throw new Error("Vulkan runtime missing");
      },
    },
  });
  fs.writeFileSync(
    path.join(output, "build-result.json"),
    JSON.stringify(
      {
        stage,
        artifacts,
        hashes: Object.fromEntries(
          artifacts
            .filter((file) => fs.existsSync(file))
            .map((file) => [path.basename(file), hash(file)]),
        ),
      },
      null,
      2,
    ),
  );
  console.log("Full LampaUa Desktop test build finished", artifacts);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
