import { defineMpvVideoElement } from "../../third_party/electron-mpv-video/src/renderer/index.ts";
import "./lampa-adapter.js";
import { installTimelineControls } from "./timeline-controls.js";
defineMpvVideoElement();
window.LampaUaMpvAdapter.installLampaMpvAdapter(
  window.Lampa,
  window._electronMpvVideo,
);
installTimelineControls(window.Lampa);
