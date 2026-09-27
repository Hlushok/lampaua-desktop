const { app, ipcMain } = require("electron");
const { existsSync } = require("fs");
const { spawn } = require("child_process");
const which = require("which");
const path = require("path");
const playerFinder = require("../playerFinder");
const uaPlayerSessionBridge = require("../uaPlayerSessionBridge");

const WHITELIST = {
  // Имена команд без расширения (кросс-платформенные)
  commands: new Set([
    "vlc",
    "kmplayer",
    "kmplayer64",
    "potplayer",
    "potplayermini",
    "potplayermini64",
    "mpv",
    "smplayer",
    "kodi",
    "gom",
    "gom64",
    "mpc-hc",
    "mpc-hc64",
    "mpc-be",
    "mpc-be64",
    "quicktime player",
    "wmplayer",
    "iina",
    "elmedia player",
    "movist",
    "infuse",
    "senplayer",
    "celluloid",
    "haruna",
    "dragon",
    "parole",
    "5kplayer",
    "zplayer",
  ]),

  // Конкретные пути к файлам (можно указывать с расширением или без)
  paths: new Set([]),

  // Директории, из которых разрешен запуск любых файлов
  allowedDirectories: new Set([]),
};

const childProcesses = new Map();
const sendersWithCleanup = new WeakSet();

function normalizePath(filePath) {
  if (!filePath) return filePath;
  return path.normalize(filePath).toLowerCase();
}

function getFileNameWithoutExtension(filePath) {
  if (!filePath) return null;
  const basename = path.basename(filePath);
  return path.parse(basename).name.toLowerCase();
}

function isInAllowedDirectory(filePath) {
  if (!filePath) return false;

  const normalizedFilePath = normalizePath(filePath);

  for (const dir of WHITELIST.allowedDirectories) {
    const normalizedDir = normalizePath(dir);
    if (normalizedFilePath.startsWith(normalizedDir)) {
      return true;
    }
  }
  return false;
}

function isCommandAllowed(cmd, resolvedPath) {
  if (!resolvedPath) return false;

  const cmdWithoutExt = getFileNameWithoutExtension(cmd);
  if (cmdWithoutExt && WHITELIST.commands.has(cmdWithoutExt)) {
    return true;
  }

  const normalizedResolvedPath = normalizePath(resolvedPath);
  for (const allowedPath of WHITELIST.paths) {
    if (normalizedResolvedPath === normalizePath(allowedPath)) {
      return true;
    }
  }

  if (playerFinder.isAuthorizedPlayerPath(resolvedPath)) {
    return true;
  }

  return isInAllowedDirectory(resolvedPath);
}

function safeSend(sender, channel, ...args) {
  if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) {
    return;
  }

  sender.send(channel, ...args);
}

function cleanupProcess(id, cleanupSession = false) {
  const entry = childProcesses.get(id);
  childProcesses.delete(id);
  if (cleanupSession) entry?.cleanup?.();
}

function cleanupSenderProcesses(sender) {
  for (const [id, entry] of childProcesses) {
    if (entry.sender === sender) {
      entry.cleanup?.();
      childProcesses.delete(id);
    }
  }
}

function ensureSenderCleanup(sender) {
  if (sendersWithCleanup.has(sender) || typeof sender.once !== "function") {
    return;
  }

  sendersWithCleanup.add(sender);
  sender.once("destroyed", () => {
    cleanupSenderProcesses(sender);
    uaPlayerSessionBridge.cleanupOwner(sender);
  });
}

function registerProcessHandlers() {
  if (typeof app?.once === "function") {
    app.once("before-quit", () => {
      for (const entry of childProcesses.values()) entry.cleanup?.();
      childProcesses.clear();
      uaPlayerSessionBridge.cleanupAll();
    });
  }

  ipcMain.on("fs-existsSync", async (event, filePath) => {
    try {
      const resolvedPath = await which(filePath, { path: process.env.PATH });
      event.returnValue = existsSync(resolvedPath);
    } catch {
      event.returnValue = false;
    }
  });

  ipcMain.on(
    "child-process-spawn",
    async (event, id, cmd, args, opts, metadata) => {
      let sessionLaunch = null;
      try {
        const resolvedCmd = await which(cmd, {
          path: opts?.env?.PATH || process.env.PATH,
        });

        if (!isCommandAllowed(cmd, resolvedCmd)) {
          throw new Error(
            `Command "${cmd}" (resolved to "${resolvedCmd}") is not allowed by whitelist`,
          );
        }

        let spawnArgs = args;
        const preparedSession =
          metadata &&
          typeof metadata === "object" &&
          Object.hasOwn(metadata, "uaPlayerSession")
            ? metadata.uaPlayerSession
            : null;
        if (
          preparedSession &&
          typeof preparedSession === "object" &&
          !Array.isArray(preparedSession) &&
          playerFinder.isUaPlayerPath(resolvedCmd)
        ) {
          try {
            sessionLaunch = uaPlayerSessionBridge.prepareLaunch({
              executablePath: resolvedCmd,
              sessionId: preparedSession.sessionId,
              payload: preparedSession.payload,
              positionalUrl:
                preparedSession.positionalUrl ||
                (Array.isArray(args) && args.length === 1
                  ? args[0]
                  : undefined),
              owner: event.sender,
            });
            spawnArgs = sessionLaunch.args;
          } catch {
            sessionLaunch = null;
            spawnArgs =
              Array.isArray(args) && args.length === 1
                ? ["--url", args[0]]
                : args;
            console.warn(
              "⚠️ Не вдалося підготувати сеанс UA Player; використовується звичайний запуск URL",
            );
          }
        } else if (
          playerFinder.isUaPlayerPath(resolvedCmd) &&
          Array.isArray(args) &&
          args.length === 1 &&
          typeof args[0] === "string" &&
          !args[0].startsWith("--")
        ) {
          spawnArgs = ["--url", args[0]];
        }

        const spawnOptions = { ...(opts || {}) };
        spawnOptions.env = { ...process.env, ...(opts?.env || {}) };
        const child = spawn(resolvedCmd, spawnArgs, spawnOptions);
        const entry = {
          child,
          cleanup: sessionLaunch?.cleanup,
          sender: event.sender,
          sessionId: sessionLaunch?.sessionId,
        };
        childProcesses.set(id, entry);
        ensureSenderCleanup(event.sender);
        let closeHandled = false;
        let sessionAborted = false;

        child.on("error", (err) => {
          sessionAborted = true;
          sessionLaunch?.cleanup();
          safeSend(event.sender, `child-process-spawn-error-${id}`, err);
          cleanupProcess(id, true);
        });

        child.on("exit", (code, signal) => {
          safeSend(
            event.sender,
            `child-process-spawn-exit-${id}`,
            code,
            signal,
          );
          cleanupProcess(id);
        });

        child.on("close", (code, signal) => {
          if (closeHandled) return;
          closeHandled = true;
          if (!sessionAborted && sessionLaunch?.usesSession) {
            const result = sessionLaunch.finish();
            if (result) {
              safeSend(event.sender, "ua-player-session-result", {
                sessionId: sessionLaunch.sessionId,
                result,
              });
            }
          } else {
            sessionLaunch?.cleanup();
          }
          safeSend(
            event.sender,
            `child-process-spawn-close-${id}`,
            code,
            signal,
          );
          cleanupProcess(id);
        });

        child.stdout?.on("data", (data) => {
          safeSend(event.sender, `child-process-spawn-stdout-${id}`, data);
        });

        child.stderr?.on("data", (data) => {
          safeSend(event.sender, `child-process-spawn-stderr-${id}`, data);
        });
      } catch (err) {
        sessionLaunch?.cleanup();
        safeSend(
          event.sender,
          `child-process-spawn-error-${id}`,
          new Error(`Command ${cmd} not allowed: ${err.message}`),
        );
      }
    },
  );

  ipcMain.on("child-process-kill", (event, id, signal) => {
    const entry = childProcesses.get(id);

    if (!entry || entry.sender !== event.sender) {
      return;
    }

    try {
      entry.child.kill(signal);
    } catch (err) {
      safeSend(event.sender, `child-process-spawn-error-${id}`, err);
      cleanupProcess(id, true);
    }
  });
}

module.exports = registerProcessHandlers;
