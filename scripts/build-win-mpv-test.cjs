const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const release = process.argv.includes("--release");
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
  if (release) {
    for (const script of [
      "prepare-electron-ac3-eac3.ps1",
      "prepare-libmpv.ps1",
    ])
      run("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", script),
      ]);
  }
  fs.mkdirSync(cache, { recursive: true });
  const electronRuntime = require("../build/electron-runtime-ac3-eac3.json");
  const electronDirectory = path.join(root, ".cache/electron-ac3-eac3");
  if (
    hash(path.join(root, ".cache/electron-runtime-ac3-eac3.zip")) !==
    electronRuntime.sha256
  )
    throw new Error("Production Electron archive hash mismatch");
  const electronInputs = {
    "electron.exe":
      "93f9eacd8ca3ff42c6683700f8a680f6d68f31554f3c764752a2329dfd71a85f",
    "ffmpeg.dll": electronRuntime.ffmpegSha256,
    "vulkan-1.dll":
      "3e427037630adaea22465209ce82137df58b2bd067cae31fa27d2db14a677103",
  };
  for (const [file, digest] of Object.entries(electronInputs))
    if (hash(path.join(electronDirectory, file)) !== digest)
      throw new Error(`Production Electron input hash mismatch: ${file}`);
  run(process.execPath, [
    path.join(root, "scripts/verify-electron-runtime.cjs"),
    path.join(electronDirectory, "electron.exe"),
    path.join(electronDirectory, "ffmpeg.dll"),
  ]);
  const mpvRuntime = require("../build/libmpv-runtime.json");
  const expectedSdk = mpvRuntime.sha256;
  if (hash(path.join(prototype, "libmpv-sdk.7z")) !== expectedSdk)
    throw new Error("SDK archive hash mismatch");
  const dll = path.join(prototype, "sdk/libmpv-2.dll");
  if (hash(dll) !== mpvRuntime.dllSha256)
    throw new Error("libmpv DLL hash mismatch");
  const dependencies = path.join(root, "node_modules");
  const env = {
    ...process.env,
    NODE_PATH: dependencies,
    MPV_INCLUDE_DIR: path.join(prototype, "sdk/include"),
    MPV_LIB: path.join(prototype, "sdk/lib/mpv.lib"),
  };
  const localPython =
    "C:/Users/stpuh/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
  if (!env.NODE_GYP_FORCE_PYTHON && fs.existsSync(localPython))
    env.NODE_GYP_FORCE_PYTHON = localPython;
  run(
    process.execPath,
    [
      path.join(root, "node_modules/node-gyp/bin/node-gyp.js"),
      "rebuild",
      "--directory",
      path.join(vendor, "native/mpv-addon"),
      `--target=${electronRuntime.version}`,
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
  for (const file of [
    "src",
    "assets",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses",
  ])
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
    name: release ? original.name : "lampaua-desktop-mpv-test",
    productName: release ? original.productName : "LampaUa Desktop MPV Test",
    version: release ? original.version : "1.5.24-mpv.6",
    main: release ? original.main : "src/mpv-test-main.js",
    lampauaMpvTest: !release,
    lampauaMpv: true,
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
        electron: electronRuntime.version,
        electronArchiveSha256: electronRuntime.sha256,
        electronSource: electronRuntime,
        electronInputs,
        vendorCommit: "4944079b4133715848ea3c3bdaf99742b8c68406",
        sdkSha256: expectedSdk,
        mpvSource: mpvRuntime,
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
  run(process.execPath, [
    path.join(root, "scripts/verify-mpv-staging.js"),
    ...(release ? ["--release"] : []),
  ]);
  if (process.argv.includes("--stage-only")) return;
  const { build, Platform, Arch } = require("electron-builder");
  const output = path.join(
    root,
    release ? "dist/release-x64" : "dist/mpv-desktop-test",
  );
  const targets = Platform.WINDOWS.createTarget(
    process.argv.includes("--unpacked")
      ? "dir"
      : release
        ? ["nsis", "portable"]
        : "portable",
    Arch.x64,
  );
  const artifacts = await build({
    projectDir: stage,
    targets,
    publish: "never",
    config: {
      ...(release ? original.build : {}),
      appId: release ? original.build.appId : "com.lampaua.desktop.mpvtest",
      productName: pkg.productName,
      electronVersion: electronRuntime.version,
      electronDist: electronDirectory,
      directories: { app: stage, output },
      files: ["**/*"],
      asar: false,
      npmRebuild: false,
      publish: release ? original.build.publish : null,
      artifactName: release
        ? original.build.artifactName
        : "lampaua-desktop-${arch}-${version}-portable.${ext}",
      win: {
        ...(release ? original.build.win : {}),
        target: [{ target: "nsis", arch: ["x64"] }],
        icon: path.join(root, "assets/win.ico"),
        signExecutable: false,
      },
      portable: {
        requestExecutionLevel: "user",
        artifactName: release
          ? "lampaua-${arch}-${version}-portable.${ext}"
          : "lampaua-desktop-${arch}-${version}-portable.${ext}",
      },
      afterPack(context) {
        if (release) {
          process.env.RCEDIT_PATH = path.join(
            root,
            "node_modules/rcedit/bin/rcedit-x64.exe",
          );
          run(process.env.RCEDIT_PATH, [
            path.join(context.appOutDir, "LampaUa.exe"),
            "--set-icon",
            path.join(root, "assets/win.ico"),
          ]);
        }
        for (const [file, expected] of Object.entries(hashes))
          if (
            hash(path.join(context.appOutDir, "resources/app", file)) !==
            expected
          )
            throw new Error(`Packaged hash mismatch: ${file}`);
        if (!fs.existsSync(path.join(context.appOutDir, "vulkan-1.dll")))
          throw new Error("Vulkan runtime missing");
        if (
          hash(path.join(context.appOutDir, "ffmpeg.dll")) !==
          electronRuntime.ffmpegSha256
        )
          throw new Error("Production FFmpeg runtime was replaced");
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
