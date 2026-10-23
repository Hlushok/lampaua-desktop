const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

async function main() {
  if (!process.argv.includes("--child")) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-vm-modules", __filename, "--child"],
      { stdio: "inherit", windowsHide: true },
    );
    assert.equal(result.status, 0);
    return;
  }
  let lost = false;
  const gl = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "isContextLost") return () => lost;
        if (key === "getShaderParameter" || key === "getProgramParameter")
          return () => true;
        if (key === "getAttribLocation") return () => 0;
        if (String(key).startsWith("create") || key === "getUniformLocation")
          return () => ({});
        if (String(key).toUpperCase() === key) return 1;
        return () => {};
      },
    },
  );
  const canvas = () =>
    Object.assign(new EventTarget(), { getContext: () => gl });
  const context = vm.createContext({ HTMLElement: EventTarget, console });
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      "../.cache/mpv-desktop-test/lib/renderer/mpv-video.js",
    ),
    "utf8",
  );
  // Expose the actual compiled class only inside this test VM.
  const mod = new vm.SourceTextModule(
    source + "\nexport { WebGLUploadRenderer };",
    { context },
  );
  await mod.link(() => {
    throw new Error("Unexpected renderer import");
  });
  await mod.evaluate();
  const target = canvas();
  const renderer = new mod.namespace.WebGLUploadRenderer(target);
  assert.equal(renderer.available, true);
  lost = true;
  assert.equal(
    renderer.available,
    false,
    "A lost GPU context was reported healthy",
  );
  lost = false;
  assert.equal(renderer.available, true);
  target.dispatchEvent(new Event("webglcontextlost"));
  assert.equal(
    renderer.available,
    false,
    "The actual context-loss event was ignored",
  );
  target.dispatchEvent(new Event("webglcontextrestored"));
  assert.equal(
    renderer.available,
    false,
    "Restoration reused invalid textures/programs",
  );
  assert.equal(
    new mod.namespace.WebGLUploadRenderer(canvas()).available,
    true,
    "A new healthy renderer was disabled",
  );
  console.log(
    "WebGL recovery contract passed: actual context status, loss event and sticky invalid resources",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
