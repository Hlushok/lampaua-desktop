import * as electron from 'electron'
import { registerD3d11Receiver } from './d3d11-receiver.cjs'
import type { GpuFrameMetadata } from '../shared/gpu-frame.js'
import type {
  ElectronMpvVideoApi,
  MpvPlayerSession,
  PlayerCreateOptions,
  PlayerEvent,
  PlayerFrame,
  RenderMode,
  RenderPipeline,
  PlayerCapabilities,
} from '../shared/types.js'

const CHANNEL_PREFIX = 'electron-mpv-video:v1'
const channel = (name: string) => `${CHANNEL_PREFIX}:${name}`

type SharedTextureCallback = (frame: VideoFrame) => Promise<void> | void

const sharedTextureCallbacks = new Map<string, Set<SharedTextureCallback>>()
const supportsSharedTexture =
  (process.platform === 'darwin' || process.platform === 'win32') && Boolean(electron.sharedTexture)
let sharedTextureReceiverRegistered = false
let apiExposed = false

function pipelineForRenderMode(mode?: RenderMode): RenderPipeline {
  if (!mode) return supportsSharedTexture ? 'shared-texture' : 'software'
  return mode === 'd3d11' ? 'd3d11' : mode === 'shared-texture' ? 'shared-texture' : 'software'
}

function registerSharedTextureReceiver() {
  if (sharedTextureReceiverRegistered || !electron.sharedTexture) return

  electron.sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, playerId?: string) => {
    const frame = importedSharedTexture.getVideoFrame()
    try {
      if (!playerId) return
      const callbacks = sharedTextureCallbacks.get(playerId)
      if (!callbacks) return
      for (const callback of callbacks) {
        await callback(frame)
      }
    } finally {
      frame.close()
      importedSharedTexture.release()
    }
  })
  sharedTextureReceiverRegistered = true
}

function createPlayerSession(id: string, initialPipeline: RenderPipeline): MpvPlayerSession {
  const disposers = new Set<() => void>()
  let destroyed = false
  let pipeline = initialPipeline
  let destroying: Promise<void> | null = null
  const gpuCallbacks = new Set<(frame: VideoFrame, metadata: GpuFrameMetadata) => void | Promise<void>>()
  const disposeGpuReceiver = typeof electron.sharedTexture?.subtle?.finishTransferSharedTexture === 'function'
    ? registerD3d11Receiver({ ipcRenderer: electron.ipcRenderer, sharedTexture: electron.sharedTexture, playerId: id,
      onFrame: async (frame, metadata) => { for (const callback of gpuCallbacks) await callback(frame, metadata) } })
    : async () => {}
  const pipelineListener = (_event: Electron.IpcRendererEvent, event: PlayerEvent) => {
    if (event.playerId === id && event.type === 'pipeline-change' &&
        ['software', 'shared-texture', 'd3d11'].includes(event.data as string)) pipeline = event.data as RenderPipeline
  }
  electron.ipcRenderer.on(channel('player:event'), pipelineListener)

  const disposeAll = () => {
    for (const dispose of disposers) dispose()
    disposers.clear()
  }

  const session: MpvPlayerSession = {
    id,
    get pipeline() { return pipeline },
    open: (source: string, headers?: Record<string, string>) => electron.ipcRenderer.invoke(channel('player:open'), id, source, headers),
    play: () => electron.ipcRenderer.invoke(channel('player:play'), id),
    pause: () => electron.ipcRenderer.invoke(channel('player:pause'), id),
    stop: () => electron.ipcRenderer.invoke(channel('player:stop'), id),
    seek: (seconds: number) => electron.ipcRenderer.invoke(channel('player:seek'), id, seconds),
    setVolume: (value: number) => electron.ipcRenderer.invoke(channel('player:set-volume'), id, value),
    setSpeed: (value: number) => electron.ipcRenderer.invoke(channel('player:set-speed'), id, value),
    setAudioTrack: (value: number | 'no') => electron.ipcRenderer.invoke(channel('player:set-audio-track'), id, value),
    setSubtitleTrack: (value: number | 'no') => electron.ipcRenderer.invoke(channel('player:set-subtitle-track'), id, value),
    setRenderSize: (width: number, height: number) =>
      electron.ipcRenderer.invoke(channel('player:set-render-size'), id, { width, height }),
    setRenderMode: (mode: RenderMode) =>
      electron.ipcRenderer.invoke(channel('player:set-render-pipeline'), id, pipelineForRenderMode(mode)),
    destroy: () => {
      if (destroying) return destroying
      destroyed = true
      disposeAll()
      gpuCallbacks.clear()
      destroying = electron.ipcRenderer.invoke(channel('player:destroy'), id).finally(async () => {
        electron.ipcRenderer.off(channel('player:event'), pipelineListener)
        await disposeGpuReceiver()
      })
      return destroying
    },
    onGpuFrame: callback => {
      if (destroyed) throw new Error('Player session is destroyed')
      gpuCallbacks.add(callback)
      const dispose = () => { gpuCallbacks.delete(callback) }
      disposers.add(dispose)
      return () => { disposers.delete(dispose); dispose() }
    },
    onFrame: (callback: (frame: PlayerFrame) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, frame: PlayerFrame) => {
        if (frame.playerId === id) callback(frame)
      }
      electron.ipcRenderer.on(channel('player:frame'), listener)
      const dispose = () => electron.ipcRenderer.off(channel('player:frame'), listener)
      disposers.add(dispose)
      return () => {
        disposers.delete(dispose)
        dispose()
      }
    },
    onSharedTextureFrame: (callback: SharedTextureCallback) => {
      if (!electron.sharedTexture) {
        throw new Error('Electron sharedTexture API is not available')
      }
      let callbacks = sharedTextureCallbacks.get(id)
      if (!callbacks) {
        callbacks = new Set()
        sharedTextureCallbacks.set(id, callbacks)
      }
      callbacks.add(callback)
      const dispose = () => {
        callbacks?.delete(callback)
        if (callbacks?.size === 0) sharedTextureCallbacks.delete(id)
      }
      disposers.add(dispose)
      return () => {
        disposers.delete(dispose)
        dispose()
      }
    },
    onEvent: (callback: (event: PlayerEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: PlayerEvent) => {
        if (event.playerId === id) callback(event)
      }
      electron.ipcRenderer.on(channel('player:event'), listener)
      const dispose = () => electron.ipcRenderer.off(channel('player:event'), listener)
      disposers.add(dispose)
      return () => {
        disposers.delete(dispose)
        dispose()
      }
    },
  }

  return session
}

const mpvApi: ElectronMpvVideoApi = {
  platform: process.platform,
  supportsSharedTexture,
  getCapabilities: () => electron.ipcRenderer.invoke(channel('player:capabilities')) as Promise<PlayerCapabilities>,
  create: async (options?: PlayerCreateOptions) => {
    const mode = options?.renderMode ?? (await mpvApi.getCapabilities()).defaultRenderMode
    const result = await electron.ipcRenderer.invoke(channel('player:create'), {
      pipeline: pipelineForRenderMode(mode),
      renderSize: {
        width: options?.width ?? 960,
        height: options?.height ?? 540,
      },
    })
    return createPlayerSession(result.id, result.actualPipeline)
  },
}

export function exposeMpvApi() {
  if (apiExposed) return
  registerSharedTextureReceiver()
  electron.contextBridge.exposeInMainWorld('_electronMpvVideo', mpvApi)
  apiExposed = true
}

export type {
  ElectronMpvVideoApi,
  MpvPlayerSession,
  PlayerCreateOptions,
  PlayerEvent,
  PlayerFrame,
  RenderMode,
}
