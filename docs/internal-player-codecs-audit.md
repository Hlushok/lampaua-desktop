# Internal Player Codecs Audit

Date: 2026-10-07

## 1. Current LampaUa Desktop Architecture

LampaUa Desktop `1.5.23` uses the public npm Electron runtime:

- Electron: `43.7.5`
- electron-builder: `26.15.3`
- Windows targets: `x64`, `ia32`, `arm64`
- Windows update metadata: `latest.yml`
- TorrServer: downloaded and managed by `src/modules/torrServerManager.js`
- External fallback: UA Player, VLC, MPC, mpv and manually selected exact executables

Playback layers are separated:

- Torrent transport: TorrServer
- HTTP streaming: TorrServer exposes HTTP streams
- Internal player: Lampa in the renderer uses Chromium HTML media playback
- Decoding: Electron/Chromium media stack and its bundled FFmpeg/media libraries
- External fallback: Lampa external-player flow through the preload `child_process.spawn` proxy

Current LampaUa Desktop does not ship a custom Electron runtime or replacement `ffmpeg.dll`.

## 2. ARST113 Architecture

Reference repository: `ARST113/lampa-desktop`, observed at the shallow clone used for this audit.

ARST113 uses:

- App version: `1.6.0-ac3.7`
- Electron package version: `44.4.4`
- Custom Electron runtime repository: `ARST113/electron`
- Custom Electron runtime tag: `v44.4.4-ac3-eac3`
- Runtime asset: `electron-v44.4.4-win32-x64-ac3-eac3.zip`
- Runtime SHA-256: `b94fe1763b25157110127b4c702b585ee2ce7daacf98ae8b224fb5f8f4923029`
- Runtime `ffmpeg.dll` SHA-256: `5bc90fdd2831b324f2d902bf21c728d0f9e5a93c4340ba2e7271760ad14d0c93`
- Source workflow run: `https://github.com/ARST113/electron/actions/runs/35969772662`

The key integration point is `package.json`:

```json
"build": {
  "electronVersion": "44.4.4",
  "electronDist": ".cache/electron-ac3-eac3"
}
```

The custom runtime is prepared by `scripts/prepare-electron.ps1`, which downloads the pinned ZIP, verifies its SHA-256, extracts it to `.cache/electron-ac3-eac3`, checks the `version` file and validates the packaged `ffmpeg.dll` hash through `scripts/verify-electron.cjs`.

ARST113 also ships separate `ffmpeg.exe` and `ffprobe.exe` from `eugeneware/ffmpeg-static` under `extraResources` as subtitle tools. These are not the Chromium decoder. They are used by subtitle probing/extraction code.

## 3. Key Differences

| Area                        | LampaUa Desktop                                            | ARST113                                                      |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Electron package            | `43.7.5` from npm                                          | `44.4.4` from npm plus custom `electronDist`                 |
| Runtime used by builder     | Official Electron download/cache                           | `.cache/electron-ac3-eac3`                                   |
| Windows archs               | x64, ia32, arm64                                           | x64 only in app workflow                                     |
| Update channel              | default GitHub provider/latest metadata                    | `ac3` channel in app workflow                                |
| App identity                | `com.lampaua.desktop`, LampaUa assets, LampaUa update repo | `com.lampa.desktop`, ARST113 release repo                    |
| UA Player integration       | Present and contract-tested                                | Not present in the same form                                 |
| Subtitle bridge             | Not present                                                | Additional MKV text subtitle bridge and ffmpeg/ffprobe tools |
| Audio track switching       | Added in this audit via `AudioVideoTracks`                 | Present                                                      |
| Custom runtime verification | Not present                                                | Pinned runtime ZIP and `ffmpeg.dll` hash verification        |

## 4. Electron Difference

ARST113 is not using official Electron as downloaded by electron-builder. It uses a custom Electron build as the packaging runtime.

The custom Electron release metadata is public and pins a Windows x64 ZIP. The release is marked prerelease. The source workflow run completed successfully and ran on a self-hosted runner named `EXPAT20001-VPS0`.

Important limitation: only the Windows x64 custom runtime is directly represented by `build/electron-runtime.json`. LampaUa currently publishes Windows x64, ia32 and arm64 installers. Using this runtime without a wider runtime matrix would either break non-x64 Windows builds or require splitting release channels/artifacts.

## 5. FFmpeg Difference

There are two different FFmpeg roles in ARST113:

1. Chromium/Electron `ffmpeg.dll` in the custom Electron runtime.
   This is the media stack used by Chromium for HTML `<video>` playback.

2. Bundled `ffmpeg.exe` and `ffprobe.exe` under `subtitle-tools`.
   These are app resources for probing/extracting subtitles. They are not used as the main playback decoder and do not mean video playback is transcoded.

The source workflow environment for the custom Electron build contains these GN args:

```text
enable_platform_ac3_eac3_audio=true
proprietary_codecs=true
ffmpeg_branding="Chrome"
override_electron_version="44.4.4"
dcheck_always_on=false
symbol_level=0
blink_symbol_level=0
v8_symbol_level=0
```

This confirms the requested AC3/EAC3/proprietary codec flags were used for that custom Electron run.

## 6. Codec Capability Matrix

This matrix separates expected architecture from proven playback. No codec should be treated as confirmed for LampaUa until real playback tests are run with the packaged app.

| Codec        | Current LampaUa official Electron                                                         | ARST113 custom Electron approach                         | Status for LampaUa after this audit |
| ------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| H.264 / AVC  | Expected supported in ordinary Chromium/Electron paths, but not re-tested here            | Expected supported                                       | Requires playback test              |
| H.265 / HEVC | Platform-dependent / uncertain                                                            | Platform-dependent / uncertain                           | Unknown until playback test         |
| VP9          | Expected supported                                                                        | Expected supported                                       | Requires playback test              |
| AV1          | Expected supported depending on Electron/OS/GPU path                                      | Expected supported depending on Electron/OS/GPU path     | Requires playback test              |
| AAC          | Expected supported                                                                        | Expected supported                                       | Requires playback test              |
| MP3          | Expected supported                                                                        | Expected supported                                       | Requires playback test              |
| AC3          | Commonly unsupported in ordinary Electron internal playback; key target of custom runtime | Requires custom Electron; ARST113 CI claims decode tests | Not confirmed in LampaUa            |
| EAC3         | Commonly unsupported in ordinary Electron internal playback; key target of custom runtime | Requires custom Electron; ARST113 CI claims decode tests | Not confirmed in LampaUa            |
| DTS          | Not expected from these flags                                                             | Not proven by ARST113 evidence reviewed here             | Unsupported/unknown                 |
| DTS-HD       | Not expected from these flags                                                             | Not proven                                               | Unsupported/unknown                 |
| TrueHD       | Not expected from these flags                                                             | Not proven                                               | Unsupported/unknown                 |
| Opus         | Expected supported in WebM; container-dependent in MKV/MP4                                | Expected supported, container-dependent                  | Requires playback test              |
| Vorbis       | Expected supported in WebM/Ogg; container-dependent                                       | Expected supported, container-dependent                  | Requires playback test              |
| FLAC         | Browser support is container-dependent                                                    | Browser support is container-dependent                   | Requires playback test              |

## 7. TorrServer Playback Architecture

The desired direct-play chain is:

```text
Torrent -> TorrServer -> HTTP stream -> internal Lampa player -> Chromium media stack -> audio/video output
```

TorrServer remains the torrent/network layer. It can expose an HTTP stream and can have optional GStreamer support, but the ARST113 codec approach does not replace TorrServer and does not use TorrServer as the browser decoder.

For internal player direct play, Chromium must be able to:

- fetch and seek the HTTP stream,
- parse the container,
- expose media tracks where needed,
- decode the selected audio and video codec.

If Chromium cannot parse/decode the stream, the correct fallback remains UA Player or another external player.

## 8. Licensing Implications

The technical approach is possible, but redistribution risk is not resolved by this audit.

Observed facts:

- ARST113 publishes a custom Electron runtime with `proprietary_codecs=true` and `ffmpeg_branding="Chrome"`.
- That runtime is built outside the LampaUa repository on a self-hosted runner.
- The release includes checksums and a source run link, but the app-level license and codec patent/licensing position are not equivalent to official Electron redistribution.
- LampaUa Desktop is GPL-2.0; the reference app declares MIT. This affects blind copying of code and bundled notices.

Before publishing a LampaUa release with this runtime, decide whether the project is willing to redistribute a custom Chromium/Electron build with proprietary codec flags through GitHub Releases. The answer is a legal/project decision, not a code fact.

## 9. Security Implications

Main risks:

- Custom executable ZIP from another GitHub repository becomes part of the app supply chain.
- The source workflow ran on a self-hosted runner, not GitHub-hosted infrastructure.
- The runtime is pinned by SHA-256 and `ffmpeg.dll` hash, which is good, but it still does not establish full build reproducibility.
- Runtime auto-download in CI must fail closed on checksum mismatch.
- Packaging must verify the runtime inside `dist/*-unpacked`, not only the downloaded ZIP.

Minimum acceptable controls if implemented:

- Pin runtime repository, tag, asset name, ZIP SHA-256 and `ffmpeg.dll` SHA-256.
- Verify `process.versions.electron`.
- Verify packaged `ffmpeg.dll`.
- Keep official Electron path available for non-x64 platforms until custom runtimes exist.
- Do not download or execute unpinned binaries.

## 10. Recommended Implementation

Recommended bounded path:

1. Keep TorrServer unchanged.
2. Keep UA Player fallback unchanged.
3. Keep LampaUa official release channel unchanged until playback tests and legal approval are complete.
4. Add the safe renderer capability flag `enableBlinkFeatures: "AudioVideoTracks"` so Lampa can switch embedded audio tracks in the internal player.
5. Create an experimental Windows x64-only custom Electron build path:
   - add a pinned runtime manifest,
   - add prepare and verify scripts,
   - add a separate build script such as `build-win-ac3`,
   - output separate artifacts/channel, not replacement `latest.yml`, until validated.
6. Only after real playback tests, decide whether to promote this path to normal Windows x64 releases.

Do not replace all Windows builds with ARST113's runtime because LampaUa currently publishes x64, ia32 and arm64 Windows installers, while the audited custom runtime is Windows x64 only.

## 11. Files That Need Modification

Safe change already applied:

- `src/modules/windowManager.js`
  - added `enableBlinkFeatures: "AudioVideoTracks"`.

Experimental custom-runtime path added locally:

- `build/electron-runtime-ac3-eac3.json`
- `scripts/prepare-electron-ac3-eac3.ps1`
- `scripts/verify-electron-runtime.cjs`
- `scripts/build-win-ac3.ps1`
- `electron-builder.ac3.cjs`
- `package.json`
  - adds `build-win-ac3` for a local Windows x64-only experimental build.

Possible future CI files:

- `.github/workflows/build.yml`
  - add a separate Windows x64 AC3 job or a separate workflow after legal/project approval.
- tests for packaged runtime verification.

Do not copy these reference areas blindly:

- ARST113 app identity, URLs, update owner/repo/channel
- generic error-page URL input
- player process handling that would remove LampaUa UA Player contracts
- release scripts that push to ARST113 channels

## 12. Risks

- Legal uncertainty for proprietary codecs redistribution.
- Windows x64-only custom runtime conflicts with current multi-arch Windows release matrix.
- A custom runtime can silently regress app startup, updater behavior, sandbox assumptions or media behavior.
- AC3/EAC3 flags do not imply DTS, DTS-HD or TrueHD.
- Chromium support for MKV/HEVC/container combinations remains empirical; flags alone are not proof.
- No real LampaUa playback tests were run in this phase, so codec support is not confirmed.

## 13. Test Plan

Test every sample through three paths:

- local file URL or local HTTP static server,
- direct HTTP URL,
- TorrServer HTTP stream.

Classify each result as:

- DIRECT PLAY,
- REMUX,
- TRANSCODE,
- UNSUPPORTED.

Minimum samples:

- MP4: H264 + AAC
- MKV: H264 + AAC
- MKV: H264 + AC3
- MKV: H264 + EAC3
- MKV: HEVC + AAC
- MKV: HEVC + AC3
- MKV: HEVC + EAC3

Additional samples:

- HEVC + DTS
- HEVC + TrueHD
- AV1 + AAC

For each test record:

- container,
- video codec,
- audio codec,
- resolution,
- audio channels,
- source path type,
- player backend,
- fallback reason if any,
- whether playback used direct play, remux or transcode.

Definition of Done is not met until H264 + AAC, H264 + AC3 and H264 + EAC3 pass in the packaged LampaUa app through TorrServer, with diagnostics and fallback behavior verified for unsupported streams.

## 14. Local Build Results

Local checks performed after the experimental path was added:

- `scripts/prepare-electron-ac3-eac3.ps1` downloaded and verified the pinned runtime.
- `scripts/verify-electron-runtime.cjs` reported Electron `44.4.4` and `ffmpeg.dll` SHA-256 `5bc90fdd2831b324f2d902bf21c728d0f9e5a93c4340ba2e7271760ad14d0c93`.
- `yarn build-win-ac3` produced `dist/lampaua-x64-1.5.23-ac3.exe`.
- The packaged AC3 runtime in `dist/win-unpacked` was verified before running the ordinary build.
- `yarn build-win` still produced the ordinary official-Electron Windows x64/ia32/arm64 artifacts.

Size comparison:

| Artifact                                              |              Size |
| ----------------------------------------------------- | ----------------: |
| Ordinary public Windows x64 `lampaua-x64-1.5.23.exe`  | 105,274,510 bytes |
| Experimental Windows x64 `lampaua-x64-1.5.23-ac3.exe` | 113,262,757 bytes |
| Delta                                                 |  +7,988,247 bytes |

No real playback samples were available in this phase, so AC3/EAC3 playback is not claimed as confirmed for LampaUa. The experimental artifact only confirms that the custom runtime can be packaged locally and that its pinned runtime identity is preserved.

## 15. AVI Follow-up Playback Probe

The user reported that an AVI torrent failed after installing the new build. The exact torrent, stream URL and installed runtime identity were unavailable, so the following results are a separate controlled reproduction rather than a diagnosis of that particular torrent.

Synthetic two-second files were created using the locally installed FFmpeg and validated with ffprobe. Playback was tested in a hidden Electron BrowserWindow using the pinned custom runtime, Electron `44.4.4` / Chromium `152.0.7977.130`, with `AudioVideoTracks` enabled. The probe used local file URLs and a separate profile; it did not exercise Lampa or TorrServer. Playback was muted, so audible audio output was not verified.

| Sample                                            | Result                    | Evidence                                                                             |
| ------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| MP4 H264 + AAC                                    | DIRECT PLAY PASS          | 320x180 video, 21 rendered frames, playback time advanced                            |
| AVI H264 + AAC, copied from the MP4               | UNSUPPORTED in this probe | MediaError 4, `DEMUXER_ERROR_COULD_NOT_OPEN`, zero frames                            |
| AVI MPEG4 ASP (`XVID`) + MP3                      | UNSUPPORTED in this probe | MediaError 4, `DEMUXER_ERROR_COULD_NOT_OPEN`, zero frames                            |
| AVI H264 + AAC remuxed to MP4 with `-c copy`      | REMUX PASS                | 320x180 video, 18 rendered frames, playback time advanced                            |
| AVI MPEG4 ASP + MP3 remuxed to MP4 with `-c copy` | Video FAIL                | Playback time reached 2.04 seconds, but dimensions and rendered frames remained zero |

The AVI failure happens while opening the container, including when its codecs match the successful MP4 control. AC3/EAC3 support therefore does not establish AVI support. Remux can address the tested H264/AAC container limitation; it did not restore video for the tested Xvid sample. No transcoding was used in these tests, and no remux service has been integrated into the application.

For AVI, the existing external player selection is the available playback path. Broad internal playback requires work beyond the current AC3/EAC3 runtime, such as a native playback backend or separately validated container and decoder changes. Automatic fallback and clear media diagnostics still require implementation and acceptance testing; these probes do not complete the original Definition of Done.

Reproduction assets and JSON logs are local ignored files under `.cache`: `avi-playback-probe.cjs`, `avi-probe.html`, `probe-*.avi`, `probe-*.mp4`, `avi-probe-output.log` and `avi-remux-probe-output.log`.

## 16. Publication Preparation for 1.5.24

The user authorized commit, push and publication of the implemented changes on 2026-10-08 and explicitly excluded further AVI implementation.

The standard release continues using the existing multi-platform workflow and official Electron. The experimental Windows x64 installer is attached separately as `lampaua-x64-1.5.24-ac3.exe` with its blockmap. It is not promoted into standard auto-update metadata.

Release review found and corrected two packaging issues:

- the experimental build now writes to `dist/ac3`, preserving standard artifacts and `dist/latest.yml`;
- `publishAutoUpdate: false` prevents writing experimental update metadata;
- the AC3-only `afterPack` hook preserves the existing Windows icon hook and verifies the packaged executable version and `ffmpeg.dll` hash before installer creation.

Experimental installation still uses the same app identity, data paths and standard updater configuration. A future standard update can replace its custom runtime. An independent experimental update channel or promotion into standard Windows x64 releases remains future work.

The original playback acceptance criteria remain open: real Lampa/TorrServer AC3/EAC3 playback with audible sound, unsupported-stream diagnostics and automatic fallback have not been validated or completed by this publication.

Local release checks completed for `1.5.24`:

- `yarn lint`, JavaScript/PowerShell syntax and all existing external-player/UA Player contract checks passed;
- `yarn build-win` produced official-Electron x64/ia32/arm64 and multi-architecture installers;
- all four standard installers matched the sizes and SHA-512 values in `dist/latest.yml`;
- `yarn build-win-ac3` completed successfully, including the packaged runtime check in `afterPack`;
- `dist/ac3/lampaua-x64-1.5.24-ac3.exe` is 113,262,680 bytes; the standard local x64 installer is 105,274,746 bytes, a delta of 7,987,934 bytes;
- `dist/latest.yml` retained SHA-256 `09387add6ab3c563e33ae5406e70f694b2f99ccd9852894be0e05c5d898b61a5` after the experimental build, and no experimental update manifest was generated;
- the follow-up release review reported that both packaging findings were resolved.
