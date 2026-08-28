# LampaUa Desktop UA Player Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make UA Player for Windows a first-class, exact-path-authorized external player that receives a bounded LAMPA session file and returns validated atomic playback results without weakening Electron child-process ownership.

**Architecture:** Extend `playerFinder` with UA Player discovery and persisted exact-path identity. A focused main-process `uaPlayerSessionBridge` converts a renderer-prepared plain session into restricted temporary JSON files only when the resolved executable is an authorized UA Player path, then validates and forwards the result on child close. The preload proxy carries one short-lived prepared session to the next UA Player spawn, while `plugin.js` keeps the non-serializable LAMPA timeline callback in the renderer and applies the returned result.

**Tech Stack:** Electron 43, Node.js 24, CommonJS main/preload modules, Lampa plugin JavaScript, Yarn 4, ESLint 10, Prettier, electron-builder.

**Spec:** `D:\opt\lampaua-player-windows\docs\superpowers\specs\2026-08-28-apple-interface-resilience-lampaua-integration-design.md`

## Global Constraints

- Keep package version `1.5.14`; do not run release scripts, create tags, push, or publish artifacts.
- Preserve the existing `{ child, sender }` owner-bound process registry and `kill(signal)`, error, exit, stdout, stderr, and close forwarding.
- Authorize UA Player by exact normalized resolved path, never by basename alone and never by an allowed-directory wildcard.
- Discovery order is `C:\Program Files\UA Player\UAPlayer.exe`, legacy `%LOCALAPPDATA%\Programs\UA Player\UAPlayer.exe`, then the exact user-selected executable.
- Plain positional URL launch remains supported when no prepared session is present.
- Session input may contain playback headers; results, logs, errors, and renderer events must not echo those headers.
- Temporary files are bounded, random, current-user scoped, atomically written/read, and removed on success, spawn failure, renderer teardown, and app exit.
- Changes stay on branch `codex/ua-player-windows-integration` as Desktop-only commits.

---

### Task 1: Discover and Persist UA Player by Exact Path

**Files:**
- Modify: `src/modules/playerFinder.js`
- Modify: `src/modules/ipcHandlers/playerHandlers.js`
- Modify: `src/modules/lampaInitializer.js`
- Modify: `scripts/verify-external-player-contract.js`

**Interfaces:**
- Adds player id `ua_player` with name `UA Player` and description `UA Player for Windows`.
- Produces synchronous helpers `normalizePlayerPath(filePath)`, `isAuthorizedPlayerPath(filePath)`, and `isUaPlayerPath(filePath)` for the main process.
- Persists the exact chosen path in Electron store key `selectedPlayerPath` whenever `saveToLocalStorage` succeeds.

- [ ] **Step 1: Extend the contract test with mocked Program Files, LOCALAPPDATA, `existsSync`, and store state; assert Program Files wins, legacy is second, and a persisted manual path is accepted only by exact normalized equality.**

```js
assert.equal(players[0].id, "ua_player");
assert.equal(playerFinder.isAuthorizedPlayerPath(discoveredPath), true);
assert.equal(playerFinder.isAuthorizedPlayerPath(`${discoveredPath}.evil`), false);
```

- [ ] **Step 2: Run `corepack yarn test:external-player-contract` and confirm the missing `ua_player` assertions fail.**

- [ ] **Step 3: Add UA Player first in `PLAYERS`, normalize with `path.resolve` plus case-insensitive Windows comparison, and make repeat discovery clear stale `foundPlayers` entries.**

- [ ] **Step 4: Persist only a path that exists as a file; expose the known discovered paths plus exact selected path to process authorization. Do not add `uaplayer` to the command-name whitelist.**

- [ ] **Step 5: Update the not-found message to mention UA Player without removing VLC/MPC/mpv support.**

- [ ] **Step 6: Run the focused contract and lint for the touched files; commit discovery separately.**

Commit: `Add exact UA Player discovery to Desktop`

### Task 2: Build and Validate Bounded UA Player Session Files

**Files:**
- Create: `src/modules/uaPlayerSessionBridge.js`
- Create: `scripts/verify-ua-player-session-contract.js`
- Modify: `package.json`

**Interfaces:**
- Produces `prepareLaunch({ sessionId, payload, positionalUrl, owner })` returning `{ args, cleanup, finish }`.
- Session schema is `lampaua-player-session-v1` with at most 256 playlist items and 4 MiB serialized input.
- Result schema is `lampaua-player-result-v1` with at most 1 MiB and only `end_by`, `url`, `position`, `duration`, `playlist_index`, and bounded `playback_results`.

```js
const launch = bridge.prepareLaunch({
  sessionId,
  payload,
  positionalUrl,
  owner: sender,
});
// launch.args === ["--session-json", sessionPath, "--result-file", resultPath]
```

- [ ] **Step 1: Write failing tests for atomic session creation, known-field normalization, 256-item/4 MiB bounds, invalid URL rejection, header retention only in the session, random names, and positional fallback.**

- [ ] **Step 2: Add failing result tests for valid atomic JSON, missing/oversized/malformed/wrong-schema data, negative/out-of-range values, secret-field stripping, stable playlist indexes, and cleanup after every outcome.**

- [ ] **Step 3: Implement plain-object cloning of URL, display title, poster, headers, position, playlist/index, episode metadata, qualities, subtitles, segments, and identifiers already supplied by LAMPA. Drop functions, prototypes, cookies, and unknown fields.**

- [ ] **Step 4: Create a random per-session directory below `app.getPath("temp")`, write session JSON to a sibling temporary file opened with `wx`/mode `0o600`, fsync/close, then rename atomically.**

- [ ] **Step 5: Validate results after the child closes, send only the normalized object, and make cleanup idempotent for success, error, close, renderer teardown, and app exit.**

- [ ] **Step 6: Add `test:ua-player-session-contract` and run it. Commit the isolated bridge.**

Commit: `Add bounded UA Player session exchange`

### Task 3: Preserve Child Ownership While Launching Full Sessions

**Files:**
- Modify: `src/modules/ipcHandlers/processHandlers.js`
- Modify: `src/preload.js`
- Modify: `scripts/verify-external-player-contract.js`
- Modify: `scripts/verify-ua-player-session-contract.js`

**Interfaces:**
- Extends `child-process-spawn` with an optional final `{ uaPlayerSession }` value supplied only by the preload proxy.
- Adds preload methods `electronAPI.player.prepareUaPlayerSession(session)` and `electronAPI.player.onUaPlayerResult(callback)`.
- Main sends `ua-player-session-result` only to the owner renderer that spawned the matching child.

- [ ] **Step 1: Add failing tests showing an intruder cannot kill a UA Player child or receive its result, a basename-only `UAPlayer.exe` is rejected, and an exact discovered/selected path is accepted.**

- [ ] **Step 2: Add failing tests for spawn error, exit-before-close, close, duplicate terminal events, renderer destroyed, and app exit; every path must preserve existing notifications and clean temp state once.**

- [ ] **Step 3: Keep the current generic whitelist unchanged. In `isCommandAllowed`, add only `playerFinder.isAuthorizedPlayerPath(resolvedPath)` as the exact-path branch.**

- [ ] **Step 4: In preload, hold one prepared session for at most 30 seconds and attach it only when the next spawned command has basename `UAPlayer.exe`; clear it after attachment. Other child processes never receive the payload.**

- [ ] **Step 5: In main, call the session bridge only when `playerFinder.isUaPlayerPath(resolvedCmd)` is true; otherwise preserve original command/arguments byte-for-byte.**

- [ ] **Step 6: Store `{ child, sender, cleanup, sessionId }` in the existing registry, call `finish()` once on close, forward the normalized result, and retain error/exit/stdout/stderr/close plus creator-only kill behavior.**

- [ ] **Step 7: Run both contract scripts and commit process/preload wiring.**

Commit: `Launch UA Player sessions without weakening process ownership`

### Task 4: Feed LAMPA Metadata and Apply Playback Results

**Files:**
- Modify: `src/plugin.js`
- Modify: `scripts/verify-ua-player-session-contract.js`

**Interfaces:**
- Follows `Lampa.Player.listener` `create` events, detects the selected exact UA Player path, creates a renderer-local `sessionId`, sends a serializable `lampaua-player-session-v1` payload to preload, and retains timeline callbacks in a `Map`.
- On result, calls the original timeline handler as `handler(percent, seconds, durationSeconds)` and emits `ua_player_result` on the player listener with the complete normalized result.

- [ ] **Step 1: Add a VM-based failing plugin contract test with mocked `Lampa.Player.listener`, Storage, and `electronAPI.player`; confirm prepared data contains no functions but retains media/playlist metadata.**

- [ ] **Step 2: Normalize the selected URL with the same TorServer play URL already used by LAMPA and build items from current data plus `data.playlist`; include qualities, subtitles, headers, segments, title/poster, identifiers, season/episode, and current timeline position.**

- [ ] **Step 3: Generate `sessionId` with `crypto.randomUUID()` exposed through a safe preload helper or a collision-resistant renderer fallback; keep the timeline handler only inside the renderer map.**

- [ ] **Step 4: Register one result subscription. Validate the returned `sessionId`, compute bounded percentage from milliseconds, invoke the owning timeline handler, emit `ua_player_result`, and delete the callback entry.**

- [ ] **Step 5: If preparation fails or no result arrives, leave LAMPA's existing positional URL spawn untouched. Never silently choose a different player or media item.**

- [ ] **Step 6: Run plugin/session/process contracts and lint; commit renderer integration separately.**

Commit: `Connect LAMPA playback metadata to UA Player`

### Task 5: Desktop Verification Without Publication

**Files:**
- Modify only when a verification failure identifies a scoped defect.
- Produce locally through existing build: `dist/` Windows artifacts at package version `1.5.14` only.

**Interfaces:**
- Produces a locally verified LampaUa Desktop build that discovers and launches the local UA Player 0.0.1 artifacts.

- [ ] **Step 1: Run immutable dependency verification.**

Run: `corepack yarn install --immutable`

- [ ] **Step 2: Run all focused contracts.**

Run: `corepack yarn test:external-player-contract`

Run: `corepack yarn test:ua-player-session-contract`

- [ ] **Step 3: Run full lint and formatting checks.**

Run: `corepack yarn lint`

- [ ] **Step 4: Run a local Windows build without publication.**

Run: `corepack yarn build-win`

- [ ] **Step 5: Exercise Program Files discovery, legacy discovery, exact manual selection, positional fallback, full session arguments, result application, invalid result rejection, child kill ownership, renderer teardown, and application-exit cleanup against the built UA Player.**

- [ ] **Step 6: Run `git diff --check`, verify `package.json` remains `1.5.14`, verify no tag/release/push occurred, and inspect both repositories' final status.**

- [ ] **Step 7: Request independent code review against this plan and the approved Windows spec; fix every Critical/Important issue and repeat all verification commands.**
