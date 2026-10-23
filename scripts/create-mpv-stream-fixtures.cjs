const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const folder = path.resolve(__dirname, "../.cache/mpv-prototype/fixtures");
const output = path.join(folder, "streams");
fs.mkdirSync(output, { recursive: true });
if (process.argv.includes("--d3d11-orientation")) {
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
      "color=red:size=640x360:rate=24,drawbox=x=320:y=0:w=320:h=180:color=lime:t=fill,drawbox=x=0:y=180:w=320:h=180:color=blue:t=fill,drawbox=x=320:y=180:w=320:h=180:color=yellow:t=fill,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='TOP LEFT 1234':fontsize=24:fontcolor=white:x=16:y=16",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=sample_rate=48000:channel_layout=stereo",
      "-t",
      "14",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      path.join(folder, "d3d11-orientation.mp4"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  console.log("Asymmetric D3D11 orientation fixture created");
  process.exit(0);
}
if (process.argv.includes("--d3d11-continuous")) {
  const crypto = require("node:crypto");
  const { spawnSync } = require("node:child_process");
  const duration = 192;
  const fps = 24;
  const probe = (file) =>
    JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        { encoding: "utf8", windowsHide: true },
      ),
    );
  const version = execFileSync("ffmpeg", ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  }).split(/\r?\n/)[0];
  const definitions = [
    {
      name: "d3d11-continuous-h264-sdr.mp4",
      codec: "h264",
      pixelFormat: "yuv420p",
      hdr: false,
    },
    {
      name: "d3d11-continuous-hevc-sdr.mp4",
      codec: "hevc",
      pixelFormat: "yuv420p",
      hdr: false,
    },
    {
      name: "d3d11-continuous-hevc-hdr.mp4",
      codec: "hevc",
      pixelFormat: "yuv420p10le",
      hdr: true,
    },
  ];
  for (const definition of definitions) {
    const file = path.join(folder, definition.name);
    const receipt = `${file}.json`;
    const digest = () =>
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const recipe = {
      ...definition,
      duration,
      fps,
      version,
      pattern: "testsrc2/frame-number/1Hz-flash-click-v1",
    };
    const validate = () => {
      const metadata = probe(file);
      const video = metadata.streams.find(
        (stream) => stream.codec_type === "video",
      );
      const audio = metadata.streams.find(
        (stream) => stream.codec_type === "audio",
      );
      if (
        video?.codec_name !== definition.codec ||
        video.width !== 3840 ||
        video.height !== 2160 ||
        video.avg_frame_rate !== "24/1" ||
        video.pix_fmt !== definition.pixelFormat ||
        Number(metadata.format.duration) < duration ||
        audio?.codec_name !== "aac" ||
        video.color_transfer !== (definition.hdr ? "smpte2084" : "bt709") ||
        video.color_primaries !== (definition.hdr ? "bt2020" : "bt709") ||
        video.color_space !== (definition.hdr ? "bt2020nc" : "bt709")
      )
        throw new Error(`Invalid continuous fixture: ${definition.name}`);
      return metadata;
    };
    if (fs.existsSync(file) && fs.existsSync(receipt)) {
      const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
      if (
        JSON.stringify(saved.recipe) === JSON.stringify(recipe) &&
        saved.sha256 === digest()
      ) {
        validate();
        console.log("Verified continuous fixture", definition.name);
        continue;
      }
    }
    const qsv = `${definition.codec}_qsv`;
    const pixelFormat = definition.hdr ? "p010le" : "nv12";
    const hardware =
      spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=640x360:rate=24",
          "-frames:v",
          "2",
          "-vf",
          `format=${pixelFormat}`,
          "-c:v",
          qsv,
          "-f",
          "null",
          "-",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 30000 },
      ).status === 0;
    const encoder = hardware
      ? qsv
      : `libx${definition.codec === "h264" ? "264" : "265"}`;
    const validateExisting = process.argv.includes("--validate-existing");
    if (validateExisting && !fs.existsSync(file))
      throw new Error(`Missing generated fixture: ${definition.name}`);
    console.log(
      validateExisting
        ? "Validating generated fixture"
        : "Creating continuous fixture",
      definition.name,
      encoder,
      `${duration}s`,
    );
    const videoFilter = `drawbox=x=32:y=32:w=256:h=256:color=white:t=fill:enable='lt(mod(t,1),0.02)',drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{n}':fontsize=96:fontcolor=white:box=1:boxcolor=black:x=32:y=h-140,format=${hardware ? pixelFormat : definition.pixelFormat}`;
    if (!validateExisting)
      execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "warning",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=3840x2160:rate=${fps}`,
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=if(lt(mod(t\\,1)\\,0.02)\\,0.5*sin(2*PI*1000*t)\\,0):s=48000",
          "-t",
          String(duration),
          "-vf",
          videoFilter,
          "-c:v",
          encoder,
          ...(hardware
            ? [
                "-preset",
                "veryfast",
                "-b:v",
                "20M",
                "-maxrate",
                "25M",
                "-bufsize",
                "40M",
              ]
            : [
                "-preset",
                "ultrafast",
                "-crf",
                "28",
                ...(definition.codec === "hevc"
                  ? ["-x265-params", "pools=4:frame-threads=2:log-level=error"]
                  : ["-threads", "4"]),
              ]),
          "-g",
          "48",
          "-bsf:v",
          `${definition.codec}_metadata=colour_primaries=${definition.hdr ? 9 : 1}:transfer_characteristics=${definition.hdr ? 16 : 1}:matrix_coefficients=${definition.hdr ? 9 : 1}`,
          "-color_primaries",
          definition.hdr ? "bt2020" : "bt709",
          "-color_trc",
          definition.hdr ? "smpte2084" : "bt709",
          "-colorspace",
          definition.hdr ? "bt2020nc" : "bt709",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
          file,
        ],
        { stdio: "inherit", windowsHide: true },
      );
    const metadata = validate();
    const pictures = [2, 73].map((seconds) =>
      execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          String(seconds),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=128:72",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "-",
        ],
        { windowsHide: true },
      ),
    );
    if (pictures[0].equals(pictures[1]))
      throw new Error("Continuous fixture has no changing pixels");
    fs.writeFileSync(
      receipt,
      JSON.stringify(
        { recipe, encoder, sha256: digest(), metadata, changingPixels: true },
        null,
        2,
      ),
    );
    console.log("Validated continuous fixture", definition.name);
  }
  process.exit(0);
}
if (process.argv.includes("--d3d11-color")) {
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
      "color=red:size=128x72:rate=24",
      "-t",
      "5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      path.join(folder, "d3d11-red.mp4"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  console.log("D3D11 SDR color reference fixture created", folder);
  process.exit(0);
}
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
