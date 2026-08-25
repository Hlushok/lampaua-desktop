const { ipcMain } = require("electron");
const { existsSync } = require("fs");
const { spawn } = require("child_process");
const which = require("which");
const path = require("path");

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

  return isInAllowedDirectory(resolvedPath);
}

function safeSend(sender, channel, ...args) {
  if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) {
    return;
  }

  sender.send(channel, ...args);
}

function cleanupProcess(id) {
  childProcesses.delete(id);
}

function cleanupSenderProcesses(sender) {
  for (const [id, entry] of childProcesses) {
    if (entry.sender === sender) {
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
  });
}

function registerProcessHandlers() {
  ipcMain.on("fs-existsSync", async (event, filePath) => {
    try {
      const resolvedPath = await which(filePath, { path: process.env.PATH });
      event.returnValue = existsSync(resolvedPath);
    } catch {
      event.returnValue = false;
    }
  });

  ipcMain.on("child-process-spawn", async (event, id, cmd, args, opts) => {
    try {
      const resolvedCmd = await which(cmd, {
        path: opts?.env?.PATH || process.env.PATH,
      });

      if (!isCommandAllowed(cmd, resolvedCmd)) {
        throw new Error(
          `Command "${cmd}" (resolved to "${resolvedCmd}") is not allowed by whitelist`,
        );
      }

      const spawnOptions = opts || {};
      spawnOptions.env = { ...process.env, ...(opts?.env || {}) };
      const child = spawn(resolvedCmd, args, spawnOptions);
      childProcesses.set(id, { child, sender: event.sender });
      ensureSenderCleanup(event.sender);

      child.on("error", (err) => {
        safeSend(event.sender, `child-process-spawn-error-${id}`, err);
        cleanupProcess(id);
      });

      child.on("exit", (code, signal) => {
        safeSend(event.sender, `child-process-spawn-exit-${id}`, code, signal);
        cleanupProcess(id);
      });

      child.on("close", (code, signal) => {
        safeSend(event.sender, `child-process-spawn-close-${id}`, code, signal);
        cleanupProcess(id);
      });

      child.stdout?.on("data", (data) => {
        safeSend(event.sender, `child-process-spawn-stdout-${id}`, data);
      });

      child.stderr?.on("data", (data) => {
        safeSend(event.sender, `child-process-spawn-stderr-${id}`, data);
      });
    } catch (err) {
      safeSend(
        event.sender,
        `child-process-spawn-error-${id}`,
        new Error(`Command ${cmd} not allowed: ${err.message}`),
      );
    }
  });

  ipcMain.on("child-process-kill", (event, id, signal) => {
    const entry = childProcesses.get(id);

    if (!entry || entry.sender !== event.sender) {
      return;
    }

    try {
      entry.child.kill(signal);
    } catch (err) {
      safeSend(event.sender, `child-process-spawn-error-${id}`, err);
      cleanupProcess(id);
    }
  });
}

module.exports = registerProcessHandlers;
