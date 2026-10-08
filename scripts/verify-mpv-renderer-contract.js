const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
if (!process.argv.includes("--child")) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", __filename, "--child"],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
async function main() {
  let gpuProbes = 0;
  let opens = 0;
  class Element extends EventTarget {
    attributes = new Map();
    style = {};
    clientWidth = 16;
    clientHeight = 16;
    attachShadow() {
      return { contains: () => false, append() {} };
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
    hasAttribute(name) {
      return this.attributes.has(name);
    }
    getBoundingClientRect() {
      return { width: 16, height: 16 };
    }
  }
  const context = vm.createContext({
    HTMLElement: Element,
    Event,
    CustomEvent,
    console,
    document: {
      createElement: () => ({
        style: {},
        getContext: (type) => (type === "2d" ? {} : null),
      }),
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: {
      devicePixelRatio: 1,
      _electronMpvVideo: {
        supportsSharedTexture: true,
        async create() {
          return {
            id: "test",
            onFrame: () => () => {},
            onEvent: () => () => {},
            async setVolume() {},
            async setRenderSize() {},
            async destroy() {},
            async open() {
              opens++;
            },
          };
        },
      },
    },
    navigator: {
      gpu: {
        async requestAdapter() {
          gpuProbes++;
          throw new Error("GPU unavailable");
        },
      },
    },
  });
  const mod = new vm.SourceTextModule(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../.cache/mpv-desktop-test/lib/renderer/mpv-video.js",
      ),
      "utf8",
    ),
    { context },
  );
  await mod.link(() => {
    throw new Error("Unexpected renderer import");
  });
  await mod.evaluate();
  for (const mode of ["webgl", "canvas2d"]) {
    const player = new mod.namespace.MpvVideoElement();
    player.setAttribute("render-mode", mode);
    const errors = [];
    player.addEventListener("mpv-error", (event) => errors.push(event.detail));
    await player.open("http://example.org/video");
    assert.deepEqual(
      errors,
      [],
      "Optional GPU fallback must not signal a fatal media error",
    );
    assert.equal(player.mode, "canvas2d");
    await player.destroy();
  }
  assert.equal(opens, 2);
  assert.equal(
    gpuProbes,
    0,
    "Explicit non-shared rendering must not probe WebGPU",
  );
  console.log("MPV optional GPU fallback contract verified");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
