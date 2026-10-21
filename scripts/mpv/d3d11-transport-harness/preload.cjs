const { contextBridge, ipcRenderer, sharedTexture } = require("electron");
const library = process.argv
  .find((value) => value.startsWith("--transport-lib="))
  .slice("--transport-lib=".length);
const { registerD3d11Receiver } = require(
  require("node:path").join(library, "preload/d3d11-receiver.cjs"),
);
let callback;
let dispose;
ipcRenderer.on("gate:bind", (_event, playerId) => {
  if (dispose) void dispose();
  dispose = registerD3d11Receiver({
    ipcRenderer,
    sharedTexture,
    playerId,
    onFrame: (frame, metadata) => callback?.(frame, metadata),
  });
  ipcRenderer.send("gate:bound", playerId);
});
contextBridge.exposeInMainWorld("gpuGate", {
  config: () => ipcRenderer.invoke("gate:config"),
  onFrame: (value) => {
    callback = value;
  },
  ready: (value) => ipcRenderer.invoke("gate:ready", value),
  report: (value) => ipcRenderer.send("gate:report", value),
  heartbeat: () => ipcRenderer.invoke("gate:heartbeat"),
});
