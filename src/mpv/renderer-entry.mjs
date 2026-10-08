import { defineMpvVideoElement } from "../../third_party/electron-mpv-video/src/renderer/index.ts";
import "./lampa-adapter.js";
defineMpvVideoElement();
window.LampaUaMpvAdapter.installLampaMpvAdapter(
  window.Lampa,
  window._electronMpvVideo,
);
