const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const folder = path.resolve(__dirname, "../.cache/mpv-prototype/fixtures");
const output = path.join(folder, "streams");
fs.mkdirSync(output, { recursive: true });
if (process.argv.includes("--4k-only")) {
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=3840x2160:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "12",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p10le",
      "-crf",
      "30",
      "-x265-params",
      "pools=4:frame-threads=2:log-level=error:hdr10=1:repeat-headers=1",
      "-color_primaries",
      "bt2020",
      "-color_trc",
      "smpte2084",
      "-colorspace",
      "bt2020nc",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      path.join(folder, "hevc-4k-hdr.mp4"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  console.log("Synthetic 4K HDR control fixture created", folder);
  process.exit(0);
}
const input = path.join(folder, "h264-aac.mp4");
const run = (args) =>
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", input, ...args],
    {
      cwd: output,
      stdio: "inherit",
      windowsHide: true,
    },
  );
for (const [quality, size] of [
  ["720", "1280:720"],
  ["1080", "1920:1080"],
])
  run([
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-vf",
    `scale=${size}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-g",
    "48",
    "-sc_threshold",
    "0",
    "-c:a",
    "copy",
    "-f",
    "dash",
    "-seg_duration",
    "2",
    "-adaptation_sets",
    "id=0,streams=v id=1,streams=a",
    "-init_seg_name",
    `dash-${quality}-init-$RepresentationID$.m4s`,
    "-media_seg_name",
    `dash-${quality}-chunk-$RepresentationID$-$Number%05d$.m4s`,
    `dash-${quality}.mpd`,
  ]);
run([
  "-c",
  "copy",
  "-f",
  "hls",
  "-hls_time",
  "2",
  "-hls_playlist_type",
  "vod",
  "-hls_segment_filename",
  "channel-%03d.ts",
  "channel.m3u8",
]);
run(["-c", "copy", "-f", "mpegts", "channel.ts"]);
console.log(
  "Separate-track DASH, HLS and HTTP MPEG-TS fixtures created",
  output,
);
