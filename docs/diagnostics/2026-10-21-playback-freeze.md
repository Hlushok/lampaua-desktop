# Playback Responsiveness Investigation: 2026-10-21

## Observed Failure

The installed 2.0.0 Windows x64 app became unresponsive during real playback.
The main process did not respond while the renderer process was still alive.
Its original main thread consumed approximately one CPU core. Three sampled
native stacks all passed through mpv_render_context_render and the addon.
This establishes expensive native rendering on Electron's main thread; it is
not evidence of a JackTor, authorization or VPS failure. No private media URL,
authorization code or process-memory dump is retained here.

The local render.h threading contract warns against blocking client API calls
on the render thread. client.h also states that synchronous calls can wait
without a bound and that async requests can be reordered unless replies are
used to sequence them. These requirements apply to our already pinned SDK.

## Local Changes

- Software rendering uses a Napi AsyncWorker, one frame in flight per player.
  The native object remains referenced until the worker finishes. Teardown
  waits for that frame; a closing owner never receives its late pixel payload.
- Controls, source options and headers use a bounded 128-request queue with
  one libmpv async request in flight. Reply IDs advance the queue. This retains
  header/format/load ordering without waiting on the Electron event loop.
- Failed asynchronous commands reach the existing renderer error path. Queue
  overflow still fails explicitly instead of growing memory without a bound.
- Windows defaults to auto-copy hardware decoding, with libmpv's software
  fallback and the existing MPV_HWDEC environment override. CPU-visible frames
  are retained for the software render API.
- User-requested window close has a 3-second native-drain fallback. App quit
  has a 6-second fallback. OS/process teardown and visible window closure are
  measured separately: the test requires window closure within 5 seconds and
  complete process exit with code 0 within 20 seconds. Neither stage is skipped.
- Test build versions derive from the current stable base, not the retired
  1.5.24 prototype label. Test identity/profile/updater isolation stays enabled.

Electron 44.4.4, the accepted libmpv DLL/SDK and its source/notice pins are
unchanged. Input protocol/header restrictions, the browser YouTube DASH route,
production URLs, app identity, saved player choices and update channel remain
unchanged. Lampac, server modules and VPS configuration were not modified.

## Verification

The 4K control fixture is synthetic HEVC Main10, 3840x2160, 24 fps, PQ/BT.2020
with AAC audio. Generate it with:

```powershell
node scripts/create-mpv-stream-fixtures.cjs --4k-only
node scripts/build-win-mpv-test.cjs --unpacked
node scripts/verify-mpv-desktop.cjs --controls-only --exe "ABSOLUTE_TEST_EXE"
```

Final evidence under .cache/mpv-desktop-test/evidence/run-1792564878744:

- Actual decoder: d3d11va-copy; source metadata remains 3840x2160.
- All 24 pause/seek/resume plus main-process IPC probes passed.
- Probe latency: 3-191 ms; visible window close: 345 ms.
- Full process exit: 716 ms, code 0; production profile metadata unchanged.
- Screenshot confirms nonblank video. Source dimensions and control responses
  are recorded by the native-event probes. Earlier failed runs are retained.

Contract regressions cover an unresolved frame while controls still respond,
waiting before native disposal, dropping a late frame, async control errors,
optional GPU fallback and window/app shutdown deadlines.

The final three-suite run passed after the user authorized stopping the hung
installed process. That process had continued to consume CPU and change its
Chromium cache, so earlier profile snapshots taken while it was alive were
not stable. The metadata assertion was retained, not relaxed.

- run-1792564795781: full desktop smoke, 51 result records, including clean
  exit and unchanged production profile metadata; process exit in 752 ms.
- run-1792564864371: stalled-network cancellation/recovery, 8 result records;
  process exit in 739 ms.
- run-1792564878744: 4K controls, 24 control batches and hardware decoding;
  process exit in 716 ms.

These runs use the complete isolated Windows app, not a standalone MPV demo.
The installed 2.0.0 app and its settings were not replaced.

Ці тести не гарантують тривалого відтворення кожного 4К HDR-потоку.
Приватні джерела не відтворювалися автоматично в ізольованому профілі.
Користувач окремо підтвердив усунення початкового зависання та дозволив реліз.
Підсумкові перевірки production-пакетів і публікації записані українською
в docs/2.0.1-validation.md.

## Component Updates Checked

Checked against GitHub/npm on 2026-10-21, without merging or publishing:

| Component                    | Finding                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Kolovatoff/lampa-desktop     | main e40b604 is already merged; no incoming commits                                                                        |
| yscoder/electron-mpv-video   | main equals our pinned 4944079; no incoming commits                                                                        |
| ARST113/lampa-desktop        | New v1.6.0-ac3.24: review HTTP cancellation and Chromium network transport fixes separately                                |
| ARST113/electron Windows x64 | Latest Windows AC3/EAC3 asset is still v44.4.4-ac3-eac3, already pinned                                                    |
| Official Electron            | npm 44.9.3 versus dev dependency 43.7.5; do not swap it into the pinned Windows codec runtime                              |
| mpv-player/mpv               | master is 167 commits ahead of our pinned 36bf3d5; requires a deliberate own-DLL rebuild, source audit and new playback QA |
| shinchiro recipes            | One incoming commit 1f8d2e7, affecting ANGLE headers; no runtime replacement performed                                     |

Routine npm candidates: commit-and-tag-version 13.2.1 -> 13.3.0, ESLint
10.11.0 -> 10.13.0, globals 17.12.0 -> 17.13.0, node-addon-api 8.9.0 -> 8.9.2,
Prettier 3.9.9 -> 3.9.10, rolldown 1.1.5 -> 1.2.14, yaml 2.8.1 -> 2.9.1.
Separate major reviews: electron-store 11 -> 12, node-gyp 12 -> 13,
TypeScript 5 -> 7 and Node type declarations 22 -> 26. Match type declarations
to the actual runtime rather than automatically taking the newest major.

The ARST113 transport fixes are commits 814ca46 and 1484847. Our corresponding
control-plane paths still use Node fetch, so this is a relevant follow-up, but
it is independent of the live main-thread rendering stack captured above.
Do not import that donor's manual URL editor, defaults or endpoints wholesale.

The owner confirmed that the local test app fixes the reported freeze and
authorized committing, pushing and publishing this fix as 2.0.1. Component
updates listed above are explicitly deferred to a separate release. The
installed app and its profile are not replaced by the release process.
