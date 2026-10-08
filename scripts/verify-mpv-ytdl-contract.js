const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const adapter = fs.readFileSync(
  path.join(__dirname, "../src/mpv/lampa-adapter.js"),
  "utf8",
);
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.nodeName = tag.toUpperCase();
    this.style = {};
    this.calls = [];
  }
  append(child) {
    this.child = child;
  }
  setAttribute() {}
  removeAttribute() {}
  load() {}
  pause() {}
  play() {}
  async open(src) {
    this.calls.push(["open", src]);
  }
  async destroy() {}
}
async function verify(order) {
  const window = {};
  vm.runInNewContext(adapter, {
    window,
    document: { createElement: (tag) => new Element(tag) },
    URL,
    Event,
    CustomEvent,
    console,
    setTimeout,
    clearTimeout,
    atob,
    btoa,
  });
  const tubes = [
    {
      verify: (src) => src.indexOf("youtube.com") >= 0,
      create: () => {
        throw new Error("Ytdl media must not use the iframe YouTube route");
      },
    },
  ];
  const coreCalls = [];
  const dashCalls = [];
  const warnings = [];
  let video;
  let current = {};
  let create;
  const Lampa = {
    Player: {
      playdata: () => current,
      listener: {
        follow(name, callback) {
          if (name === "create") create = callback;
        },
      },
    },
    Storage: { field: () => "inner" },
    PlayerVideo: {
      registerTube: (tube) => tubes.push(tube),
      video: () => video,
      url(src, extra) {
        coreCalls.push([src, extra]);
        const tube = tubes.find((item) => item.verify(src));
        if (tube) tube.create((value) => (video = value));
        else video = new Element("video");
        video.src = src;
        video.load();
        return "core-result";
      },
    },
  };
  // Matches the existing Ytdl wrapper's URL test, fallback and dash.js binding.
  function installLegacyYtdl() {
    const original = Lampa.PlayerVideo.url;
    Lampa.PlayerVideo.url = function (src, ...args) {
      if (!(typeof src === "string" && src.includes("/ytdl/manifest?")))
        return original.call(this, src, ...args);
      if (src.includes("quality=throw")) throw new Error("Ytdl test failure");
      const fallback = "https://kinohub.uk/ytdl/media?fallback=360";
      original.call(this, fallback);
      try {
        const element = Lampa.PlayerVideo.video();
        element.pause();
        element.removeAttribute("src");
        element.load();
        if (!/^(VIDEO|AUDIO)$/.test(element.nodeName))
          throw new Error("element is not video or audio DOM type!");
        dashCalls.push(src);
      } catch {
        warnings.push("DASH fallback 360p");
        original.call(this, fallback);
      }
    };
  }
  if (order === "before") installLegacyYtdl();
  window.LampaUaMpvAdapter.installLampaMpvAdapter(Lampa, {});
  if (order === "after") installLegacyYtdl();
  current = { launch_player: "inner" };
  create({ data: current });
  for (const quality of ["720", "1080", "2160"]) {
    const src = `https://kinohub.uk/ytdl/manifest?url=a%2Fb%3D&token=keep%2Bthis&quality=${quality}&origin=youtube.com%2Fwatch`;
    const result = Lampa.PlayerVideo.url(src, "preserved-argument");
    assert.equal(result, undefined, `${order}: plugin return value`);
    assert.equal(warnings.length, 0, `${order}: no 360p fallback`);
    assert.equal(
      dashCalls.at(-1),
      src,
      `${order}: DASH source and auth preserved`,
    );
    assert.equal(
      video.nodeName,
      "VIDEO",
      `${order}: real DOM video for dash.js`,
    );
    assert.equal(
      video.child,
      undefined,
      `${order}: no native session for Ytdl DASH`,
    );
  }
  current = { launch_player: "other" };
  create({ data: current });
  const browserDash = "https://kinohub.uk/ytdl/manifest?quality=720";
  Lampa.PlayerVideo.url(browserDash);
  assert.deepEqual(
    dashCalls,
    [
      ...["720", "1080", "2160"].map(
        (quality) =>
          `https://kinohub.uk/ytdl/manifest?url=a%2Fb%3D&token=keep%2Bthis&quality=${quality}&origin=youtube.com%2Fwatch`,
      ),
      browserDash,
    ],
    "Non-MPV DASH must stay unchanged",
  );
  assert.equal(video.nodeName, "VIDEO");
  assert.equal(warnings.length, 0);
  current = { launch_player: "inner" };
  create({ data: current });
  assert.throws(
    () =>
      Lampa.PlayerVideo.url("https://kinohub.uk/ytdl/manifest?quality=throw"),
    /Ytdl test failure/,
  );
  const generic = "https://example.org/generic.mpd";
  assert.equal(Lampa.PlayerVideo.url(generic, "preserved"), "core-result");
  assert.deepEqual(
    coreCalls.at(-1),
    [generic, "preserved"],
    "Other delegates preserved after a plugin error",
  );
  await video.flush();
  assert.deepEqual(
    video.child.calls,
    [["open", generic]],
    "Generic DASH stays native",
  );
  await video.destroy();
  const mpv = tubes.at(-1);
  for (const invalid of [
    "lampaua-mpv-ytdl:%ZZ",
    `lampaua-mpv-ytdl:${encodeURIComponent("file:///ytdl/manifest?x=1")}`,
    `lampaua-mpv-ytdl:${encodeURIComponent("https://example.org/not-a-manifest")}`,
  ])
    assert.equal(mpv.verify(invalid), false, "Invalid bridge sources rejected");
}
(async () => {
  await verify("before");
  await verify("after");
  console.log(
    "Ytdl browser DASH, native fallback isolation and plugin load order verified",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
