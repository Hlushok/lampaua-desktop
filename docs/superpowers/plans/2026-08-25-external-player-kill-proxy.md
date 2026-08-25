# External Player Kill Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Restore LampaUa Desktop compatibility with current Lampa external Windows player relaunches by giving the child process proxy the `kill()` and `close` contract Lampa expects.

**Architecture:** Keep the renderer-facing `require("child_process").spawn()` shim in `src/preload.js`, and add a bounded IPC command that can only kill a process spawned by the same renderer. Track spawned child processes in `src/modules/ipcHandlers/processHandlers.js` by process id and sender, clean records on process termination and renderer destruction, and preserve existing whitelist validation.

**Tech Stack:** Electron preload IPC, Electron `ipcMain`, Node `child_process.spawn`, Yarn 4, Node contract test.

**Spec:** User request in Codex thread on 2026-08-25.

## Global Constraints

- Modify only LampaUa Desktop files under `D:\opt\lampaua-desktop`.
- Do not change Lampac, JackTor, VPS, or `wwwroot/lampa-main`.
- Do not push, tag, or release without separate user approval.
- Preserve existing spawn whitelist.
- Preserve existing renderer contracts for `error`, `exit`, `stdout`, and `stderr`.

---

### Task 1: Preload Child Process Proxy Contract

**Files:**

- Modify: `src/preload.js`
- Test: `scripts/verify-external-player-contract.js`

**Interfaces:**

- Consumes: IPC channels `child-process-spawn`, `child-process-kill`, `child-process-spawn-error-${id}`, `child-process-spawn-exit-${id}`, `child-process-spawn-close-${id}`, `child-process-spawn-stdout-${id}`, `child-process-spawn-stderr-${id}`
- Produces: spawn proxy object with `on(event, callback)`, `kill(signal)`, `stdout.on("data", callback)`, and `stderr.on("data", callback)`

- [x] **Step 1: Add failing contract test for preload**

Create a Node script that mocks Electron preload APIs, calls `window.require("child_process").spawn()`, asserts `typeof process.kill === "function"`, registers `on("close")`, emits the IPC close event, and asserts `process.kill("SIGTERM")` sends `child-process-kill`.

- [x] **Step 2: Implement preload kill and close support**

Update the spawn proxy to send `ipcRenderer.send("child-process-kill", id, signal)` from `kill(signal)`, and dispatch `close` callbacks from `child-process-spawn-close-${id}`.

- [x] **Step 3: Run contract test**

Run: `node scripts/verify-external-player-contract.js`
Expected: PASS, with no `TypeError`.

### Task 2: Main Process Ownership And Cleanup

**Files:**

- Modify: `src/modules/ipcHandlers/processHandlers.js`
- Test: `scripts/verify-external-player-contract.js`

**Interfaces:**

- Consumes: renderer IPC events for `child-process-spawn` and `child-process-kill`
- Produces: owner-bound process registry; close/exit/error/stdout/stderr IPC forwarding

- [x] **Step 1: Extend contract test for main process**

Mock `electron.ipcMain`, `child_process.spawn`, and `which`. Register handlers, spawn a process with sender A, call kill from sender A, and assert the underlying child `kill("SIGTERM")` was called. Call kill from sender B for the same id and assert it does not kill sender A's process.

- [x] **Step 2: Track spawned processes**

Store each spawned child in a `Map` keyed by id with `{ child, sender }`.

- [x] **Step 3: Add bounded kill IPC**

Register `ipcMain.on("child-process-kill", ...)`; if the id is unknown or the sender is not the owner, return without action. If owned, call `child.kill(signal)`.

- [x] **Step 4: Add cleanup**

Remove registry entries on child `error`, `exit`, and `close`; register one sender `destroyed` listener to remove all processes owned by that sender.

- [x] **Step 5: Preserve existing process event forwarding**

Keep forwarding `error`, `exit`, `stdout.data`, and `stderr.data`; add forwarding for `close`.

### Task 3: Verification

**Files:**

- Modify: `package.json`

**Interfaces:**

- Produces: `yarn test:external-player-contract`

- [x] **Step 1: Add package script**

Add `"test:external-player-contract": "node scripts/verify-external-player-contract.js"`.

- [x] **Step 2: Run targeted checks**

Run: `node -c src/preload.js`, `node -c src/modules/ipcHandlers/processHandlers.js`, `node -c scripts/verify-external-player-contract.js`, and `corepack yarn test:external-player-contract`.

- [x] **Step 3: Run full checks**

Run: `corepack yarn install --immutable`, `corepack yarn lint`, and `corepack yarn build-win`.

- [x] **Step 4: Stop before publication**

Do not push, tag, or release. Report local verification and propose release `1.5.13`.
