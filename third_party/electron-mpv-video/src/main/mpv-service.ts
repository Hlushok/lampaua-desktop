import * as electron from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent, IpcMainEvent, WebContents } from 'electron'
import { D3d11Transport, canCreateD3d11Transport } from './d3d11-transport.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { RenderPipeline } from '../shared/types.js'
import type { GpuFrameKey, NativeGpuFrame } from '../shared/gpu-frame.js'

const CHANNEL_PREFIX = 'electron-mpv-video:v1'
const channel = (name: string) => `${CHANNEL_PREFIX}:${name}`
const IPC_CHANNELS = [
  'player:capabilities',
  'player:create',
  'player:open',
  'player:play',
  'player:pause',
  'player:stop',
  'player:seek',
  'player:set-volume',
  'player:set-speed',
  'player:set-audio-track',
  'player:set-subtitle-track',
  'player:set-render-size',
  'player:set-render-pipeline',
  'player:destroy',
] as const

type NativeFrame = {
  width: number
  height: number
  rgba: Buffer
}

type NativeEvent = {
  id: number
  type: string
  name?: string
  data?: unknown
  error?: string
  reason?: number
}

type NativePlayer = {
  open(source: string, headers: string[], format: 'auto' | 'dash' | 'hls'): void
  play(): void
  pause(): void
  stop(): void
  seek(seconds: number): void
  setVolume(value: number): void
  setSpeed(value: number): void
  setAudioTrack(id: number | 'no'): void
  setSubtitleTrack(id: number | 'no'): void
  setUpdateCallback(callback?: () => void): void
  setEventCallback(callback?: () => void): void
  renderFrame(width: number, height: number): Promise<NativeFrame>
  renderSharedTexture(width: number, height: number): Electron.SharedTextureImportTextureInfo
  pollEvents(): NativeEvent[]
  destroy(): Promise<void>
}

type NativeD3d11Player = Omit<NativePlayer, 'renderFrame' | 'renderSharedTexture'> & {
  renderD3d11Frame(width: number, height: number, generation: number): Promise<NativeGpuFrame | null>
  releaseD3d11Frame(key: GpuFrameKey): Promise<boolean>
  retireD3d11Playback(): Promise<void>
}

type NativeModule = {
  MpvPlayer: new (options?: { mode?: RenderPipeline }) => NativePlayer
  createD3d11Player?: (options: { width: number; height: number }) => Promise<NativeD3d11Player>
}
type SessionNativePlayer = NativePlayer | NativeD3d11Player

type RenderSize = {
  width: number
  height: number
}

type AttachedWindow = {
  window: BrowserWindow
  onClosed: () => void
  onNavigation: (...args: any[]) => void
  onLoaded: () => void
  onGone: () => void
  ready: boolean
}

export type MpvMainOptions = {
  preferredPipeline?: 'software' | 'd3d11'
  addonPath?: string
  authorize?: (event: IpcMainInvokeEvent) => boolean
  normalizeSource?: (source: unknown) => string
  diagnostic?: (type: string, data: { playerId?: string; error?: string; format?: string; code?: string }) => void
}

export type MpvMain = {
  attachWindow(window: BrowserWindow): void
  detachWindow(window: BrowserWindow): Promise<void>
  dispose(): Promise<void>
}

const require = createRequire(import.meta.url)
let activeService: MpvMainService | null = null

function supportsSharedTexturePipeline() {
  return (process.platform === 'darwin' || process.platform === 'win32') && Boolean(electron.sharedTexture)
}

function defaultAddonPath() {
  const packageRoot = path.dirname(require.resolve('electron-mpv-video/package.json'))
  return path.join(packageRoot, 'native/mpv-addon/build/Release/mpv_addon.node')
}

function finiteNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`)
  }
  return value
}

function normalizeRenderSize(value: unknown): RenderSize {
  if (!value || typeof value !== 'object') {
    throw new TypeError('renderSize must be an object')
  }
  const size = value as Partial<RenderSize>
  return {
    width: Math.max(2, Math.min(3840, Math.floor(finiteNumber(size.width, 'renderSize.width')))),
    height: Math.max(2, Math.min(2160, Math.floor(finiteNumber(size.height, 'renderSize.height')))),
  }
}

function bounded(value: unknown, name: string, min: number, max: number) {
  const number = finiteNumber(value, name)
  if (number < min || number > max) throw new RangeError(`${name} outside allowed range`)
  return number
}

function normalizePipeline(value: unknown): RenderPipeline {
  if (value !== 'software' && value !== 'shared-texture' && value !== 'd3d11') {
    throw new TypeError(`Unsupported render pipeline: ${String(value)}`)
  }
  return value
}

function normalizePlayerId(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('playerId must be a non-empty string')
  }
  return value
}

function normalizeSource(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('source must be a non-empty string')
  }
  return value
}

function normalizeHeaders(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid HTTP headers')
  const entries = Object.entries(value)
  if (entries.length > 32) throw new TypeError('Too many HTTP headers')
  const blocked = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'range', 'accept-encoding', 'proxy-authorization', 'proxy-connection', 'upgrade', 'te', 'trailer', 'keep-alive'])
  const names = new Set<string>()
  let size = 0
  return entries.map(([name, content]) => {
    const key = name.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || blocked.has(key) || names.has(key) ||
      typeof content !== 'string' || content.length > 8192 || /[\x00-\x1f\x7f]/.test(content)) {
      throw new TypeError('Invalid HTTP header')
    }
    names.add(key)
    size += name.length + content.length
    if (size > 16384) throw new TypeError('HTTP headers are too large')
    return `${name}: ${content}`
  })
}

function manifestFormat(source: string): 'auto' | 'dash' | 'hls' {
  const url = new URL(source)
  let pathname = url.pathname.toLowerCase()
  // The portal signs an extensionless proxy URL. Inspect its encoded target
  // only to select the demuxer; keep the signed playback URL unchanged.
  if (pathname === '/lite/iptvportal/api/stream') {
    const target = url.searchParams.get('target')
    if (target && /^[A-Za-z0-9_+\/-]+={0,2}$/.test(target)) {
      try {
        const upstream = new URL(Buffer.from(target, 'base64url').toString('utf8'))
        if (upstream.protocol === 'http:' || upstream.protocol === 'https:') {
          pathname = upstream.pathname.toLowerCase()
        }
      } catch {
        // Unknown targets retain ordinary automatic format detection.
      }
    }
  }
  if (pathname === '/ytdl/manifest' || pathname.endsWith('.mpd')) return 'dash'
  if (pathname.endsWith('.m3u8')) return 'hls'
  return 'auto'
}

class PlayerSession {
  readonly id = randomUUID()
  private player: SessionNativePlayer
  private renderSize: RenderSize
  private pipeline: RenderPipeline
  private sharedTextureFrameInFlight = false
  private framePumpRunning = false
  private framePumpPending = false
  private framePumpPromise: Promise<void> | null = null
  private eventPumpRunning = false
  private eventPumpPending = false
  private destroyed = false
  private operations: Promise<unknown> = Promise.resolve()
  private destroyPromise: Promise<void> | null = null
  private source: string | null = null
  private headers: string[] = []
  private currentTime = 0
  private confirmedTime = 0
  private duration = 0
  private seekable = false
  private fileFormat: string | null = null
  private volume = 100
  private speed = 1
  private audioTrack: number | 'no' | null = null
  private subtitleTrack: number | 'no' | null = null
  private paused = true
  private stopped = true
  private tracks: Array<{ id: number; type: string }> = []
  private gpuTransport: D3d11Transport | null = null
  private gpuGeneration = 1
  private gpuFallbackUsed = false
  private authorizeGpu: (event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>) => boolean = () => false

  private constructor(
    private readonly window: BrowserWindow,
    private readonly ownerWebContentsId: number,
    private readonly nativeModule: NativeModule,
    private readonly onDestroyed: (id: string) => void,
    options: { pipeline: RenderPipeline; renderSize: RenderSize },
    private readonly diagnostic: NonNullable<MpvMainOptions['diagnostic']> = () => {},
    player: SessionNativePlayer,
  ) {
    this.pipeline = options.pipeline
    if (this.pipeline === 'shared-texture' && !supportsSharedTexturePipeline()) {
      this.pipeline = 'software'
    }
    this.renderSize = options.renderSize
    this.player = player
  }

  static async create(window: BrowserWindow, ownerId: number, nativeModule: NativeModule,
    onDestroyed: (id: string) => void, options: { pipeline: RenderPipeline; renderSize: RenderSize },
    diagnostic: NonNullable<MpvMainOptions['diagnostic']> = () => {}) {
    let pipeline = options.pipeline
    if (pipeline === 'd3d11' && !canCreateD3d11Transport(window.webContents)) {
      diagnostic('d3d11-retired-fallback', { code: 'GPU_TRANSPORT_RETIRED' })
      pipeline = 'software'
    }
    if (pipeline === 'shared-texture' && !supportsSharedTexturePipeline()) pipeline = 'software'
    let player: SessionNativePlayer
    if (pipeline === 'd3d11') {
      try {
        if (!nativeModule.createD3d11Player) throw new Error('D3D11 factory is unavailable')
        player = await nativeModule.createD3d11Player(options.renderSize)
      } catch {
        diagnostic('d3d11-init-fallback', {})
        pipeline = 'software'
        player = new nativeModule.MpvPlayer({ mode: 'software' })
      }
    } else player = new nativeModule.MpvPlayer({ mode: pipeline })
    return new PlayerSession(window, ownerId, nativeModule, onDestroyed,
      { ...options, pipeline }, diagnostic, player)
  }

  get actualPipeline() { return this.pipeline }
  async start(authorize: typeof this.authorizeGpu) {
    this.authorizeGpu = authorize
    if (this.pipeline === 'd3d11') {
      try { this.gpuTransport = this.makeGpuTransport(this.player as NativeD3d11Player) }
      catch {
        const previous = this.player
        this.player = new this.nativeModule.MpvPlayer({ mode: 'software' })
        this.pipeline = 'software'
        this.gpuFallbackUsed = true
        await previous.destroy()
      }
    }
    this.assertAlive()
    this.startCallbacks()
  }

  private makeGpuTransport(player: NativeD3d11Player) {
    return new D3d11Transport({ playerId: this.id, owner: this.window.webContents,
      authorize: this.authorizeGpu, releaseNative: key => player.releaseD3d11Frame(key),
      onAvailable: () => { if (this.player === player) this.queueFrame() },
      onError: error => this.failGpu(error) })
  }

  private failGpu(error: unknown) {
    if (this.destroyed || this.gpuFallbackUsed || this.pipeline !== 'd3d11') return
    this.gpuFallbackUsed = true
    const code = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^GPU_[A-Z_]+$/.test(error.code) ? error.code : 'GPU_NATIVE_RENDER'
    this.diagnostic('d3d11-fallback', { playerId: this.id, code })
    void this.run(() => this.setRenderPipeline('software')).catch(failure => this.sendError('render-error', failure ?? error))
  }

  private invalidateGpu() {
    if (this.pipeline !== 'd3d11' || !this.gpuTransport) return
    this.gpuGeneration++
    this.gpuTransport.invalidate(this.gpuGeneration)
  }

  private async retirePlayer(player: SessionNativePlayer, transport: D3d11Transport | null) {
    if (!transport) { await player.destroy(); return }
    // Stop audio/network independently of the disabled event pump. GPU leases
    // stay quarantined until Chromium confirms their completion.
    const stopped = (player as NativeD3d11Player).retireD3d11Playback()
    await transport.dispose()
    const cleanup = Promise.allSettled([stopped, transport.whenDrained()]).then(() => player.destroy())
    void cleanup.catch(() => this.diagnostic('d3d11-retirement-error', { playerId: this.id }))
    await stopped
    if (transport.stats().leases === 0) await cleanup
  }

  belongsTo(sender: WebContents | number) {
    return this.ownerWebContentsId === (typeof sender === 'number' ? sender : sender.id)
  }

  open(source: string, headers: string[]) {
    this.assertAlive()
    this.invalidateGpu()
    this.tracks = []
    const format = manifestFormat(source)
    this.diagnostic('open', {playerId: this.id, format})
    this.player.open(source, headers, format)
    this.source = source
    this.headers = headers
    this.currentTime = 0
    this.confirmedTime = 0
    this.duration = 0
    this.seekable = false
    this.fileFormat = null
    this.audioTrack = null
    this.subtitleTrack = null
    this.stopped = false
    this.queueFrame()
    this.queueEvents()
  }

  play() {
    this.assertAlive()
    this.player.play()
    this.paused = false
  }

  pause() {
    this.assertAlive()
    this.player.pause()
    this.paused = true
  }

  stop() {
    this.assertAlive()
    this.invalidateGpu()
    this.player.stop()
    this.currentTime = 0
    this.paused = true
    this.stopped = true
  }

  seek(seconds: number) {
    this.assertAlive()
    const nextTime = bounded(seconds, 'seconds', 0, Number.MAX_SAFE_INTEGER)
    this.invalidateGpu()
    this.player.seek(nextTime)
    this.currentTime = nextTime
  }

  setVolume(value: number) {
    this.assertAlive()
    const nextVolume = bounded(value, 'volume', 0, 100)
    this.player.setVolume(nextVolume)
    this.volume = nextVolume
  }

  setSpeed(value: number) {
    this.assertAlive()
    this.speed = bounded(value, 'speed', 0.25, 4)
    this.player.setSpeed(this.speed)
  }

  setTrack(type: 'audio' | 'sub', id: unknown) {
    this.assertAlive()
    if (id !== 'no' && (!Number.isInteger(id) || !this.tracks.some(track => track.id === id && track.type === type))) {
      throw new TypeError('Unknown track for this media')
    }
    if (type === 'audio') {
      this.player.setAudioTrack(id as number | 'no')
      this.audioTrack = id as number | 'no'
    } else {
      this.player.setSubtitleTrack(id as number | 'no')
      this.subtitleTrack = id as number | 'no'
    }
  }

  setRenderSize(size: RenderSize) {
    this.assertAlive()
    if (size.width !== this.renderSize.width || size.height !== this.renderSize.height) this.invalidateGpu()
    this.renderSize = size
    this.queueFrame()
  }

  async setRenderPipeline(nextPipeline: RenderPipeline) {
    this.assertAlive()
    if (nextPipeline === 'shared-texture' && !supportsSharedTexturePipeline()) {
      throw new Error(`Shared texture pipeline is unavailable on ${process.platform}`)
    }
    if (this.pipeline === nextPipeline) return

    const previousPlayer = this.player
    const previousTransport = this.gpuTransport
    const previousPipeline = this.pipeline
    this.stopCallbacks()
    await this.waitForFramePump()
    this.assertAlive()

    let replacement: SessionNativePlayer | null = null
    let replacementTransport: D3d11Transport | null = null
    let restoredEvents: NativeEvent[] = []
    try {
      if (nextPipeline === 'd3d11') {
        if (this.gpuFallbackUsed || !canCreateD3d11Transport(this.window.webContents) || !this.nativeModule.createD3d11Player)
          throw new Error('D3D11 backend is unavailable or retired')
        replacement = await this.nativeModule.createD3d11Player(this.renderSize)
        replacementTransport = this.makeGpuTransport(replacement)
      } else replacement = new this.nativeModule.MpvPlayer({ mode: nextPipeline })
      replacement.setVolume(this.volume)
      replacement.setSpeed(this.speed)
      if (this.source && !this.stopped) {
        replacement.open(this.source, this.headers, manifestFormat(this.source))
        restoredEvents = await this.waitForFileLoaded(replacement)
        this.assertAlive()
        const position = previousPipeline === 'd3d11' ? this.confirmedTime : this.currentTime
        // HLS EVENT streams can have a duration and be seekable. Restore only
        // finite-file formats; unknown/adaptive streams are not automatically seeked.
        const finiteFormats = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'ogg', 'flac', 'mp3', 'wav'])
        const finiteFile = this.fileFormat !== null && this.fileFormat.split(',').every(format => finiteFormats.has(format))
        if (position > 0 && this.duration > 0 && this.seekable && finiteFile && manifestFormat(this.source) === 'auto') replacement.seek(position)
        const restoredTracks = restoredEvents.filter(event => event.name === 'track-list' && Array.isArray(event.data)).at(-1)?.data as Array<{id: number; type: string}> | undefined
        for (const [type, id] of [['audio', this.audioTrack], ['sub', this.subtitleTrack]] as const) {
          if (id === 'no' || (id !== null && restoredTracks?.some(track => track.type === type && track.id === id))) {
            if (type === 'audio') replacement.setAudioTrack(id)
            else replacement.setSubtitleTrack(id)
          }
        }
        if (this.paused) replacement.pause()
        else replacement.play()
      }

      this.player = replacement
      this.pipeline = nextPipeline
      this.gpuTransport = replacementTransport
      this.gpuGeneration++
      replacementTransport?.invalidate(this.gpuGeneration)
      this.sendEvent({ id: 0, type: 'pipeline-change', data: nextPipeline })
      for (const event of restoredEvents) {
        const transientProperty = event.type === 'property-change' &&
          (event.name === 'time-pos' || event.name === 'pause' || event.name === 'eof-reached')
        if (!transientProperty) this.sendEvent(event)
      }
      this.startCallbacks()
    } catch (error) {
      if (replacement) await this.retirePlayer(replacement, replacementTransport)
      this.player = previousPlayer
      this.pipeline = previousPipeline
      this.gpuTransport = previousTransport
      if (!this.destroyed) this.startCallbacks()
      throw error
    }
    await this.retirePlayer(previousPlayer, previousTransport)
  }

  run(operation: () => unknown) {
    const result = this.operations.then(() => {
      this.assertAlive()
      return operation()
    })
    this.operations = result.catch(() => {})
    return result
  }

  destroy() {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.diagnostic('destroy-start', {playerId: this.id})
    this.stopCallbacks()
    this.destroyPromise = this.operations.then(async () => {
      await this.waitForFramePump()
      await this.retirePlayer(this.player, this.gpuTransport)
      this.diagnostic('destroy-complete', {playerId: this.id})
    }).finally(() => this.onDestroyed(this.id))
    return this.destroyPromise
  }


  private async waitForFileLoaded(player: SessionNativePlayer) {
    const events: NativeEvent[] = []
    const deadline = Date.now() + 30_000

    while (Date.now() < deadline) {
      this.assertAlive()
      const batch = player.pollEvents()
      events.push(...batch)
      const failure = batch.find((event) => event.error)
      if (failure) {
        throw new Error(`Failed to restore source: ${failure.error}`)
      }
      if (batch.some((event) => event.type === 'file-loaded')) return events
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }

    throw new Error('Timed out while restoring the media source')
  }

  private assertAlive() {
    if (this.destroyed || this.window.isDestroyed()) {
      throw new Error(`Player session is destroyed: ${this.id}`)
    }
  }

  private trackEvent(event: NativeEvent) {
    if (event.type !== 'property-change') return
    if (event.name === 'track-list' && Array.isArray(event.data)) this.tracks = event.data
    if (event.name === 'time-pos' && typeof event.data === 'number') {
      this.currentTime = event.data
      if (Number.isFinite(event.data) && event.data >= 0) this.confirmedTime = event.data
    } else if (event.name === 'duration') {
      this.duration = typeof event.data === 'number' && Number.isFinite(event.data) && event.data > 0 ? event.data : 0
    } else if (event.name === 'seekable') {
      this.seekable = event.data === true
    } else if (event.name === 'file-format') {
      this.fileFormat = typeof event.data === 'string' && event.data.length > 0 ? event.data : null
    } else if (event.name === 'pause' && typeof event.data === 'boolean') {
      this.paused = event.data
    } else if (event.name === 'eof-reached' && event.data === true) {
      this.paused = true
    }
  }

  private sendEvent(event: NativeEvent) {
    if (this.destroyed) return
    this.trackEvent(event)
    if (['file-loaded', 'end-file', 'command-error'].includes(event.type)) {
      this.diagnostic(event.type, {playerId: this.id, error: event.error})
    }
    if (this.window.isDestroyed()) return
    this.window.webContents.send(channel('player:event'), {
      playerId: this.id,
      type: event.type,
      name: event.name,
      data: event.data,
      error: event.error,
      reason: event.reason,
    })
  }

  private sendError(type: 'render-error' | 'event-error', error: unknown) {
    this.diagnostic(type, {playerId: this.id})
    if (this.window.isDestroyed()) return
    this.window.webContents.send(channel('player:event'), {
      playerId: this.id,
      type,
      data: error instanceof Error ? error.message : String(error),
    })
  }

  private async renderOneFrame() {
    if (this.destroyed || this.window.isDestroyed()) return
    if (this.pipeline === 'd3d11') {
      const player = this.player as NativeD3d11Player
      const transport = this.gpuTransport
      if (!transport || transport.stats().leases >= 3 || transport.stats().failed) return
      const generation = this.gpuGeneration
      const frame = await player.renderD3d11Frame(this.renderSize.width, this.renderSize.height, generation)
      if (!frame) return
      if (this.destroyed || this.window.isDestroyed() || generation !== this.gpuGeneration) {
        await player.releaseD3d11Frame(frame.key)
        return
      }
      try { await transport.send(frame) }
      catch (error) { await player.releaseD3d11Frame(frame.key); throw error }
      return
    }
    if (this.pipeline === 'shared-texture') {
      if (!electron.sharedTexture) {
        throw new Error('Electron sharedTexture API is not available in this runtime')
      }
      if (this.sharedTextureFrameInFlight) return

      this.sharedTextureFrameInFlight = true
      let imported: Electron.SharedTextureImported | undefined
      try {
        const textureInfo = (this.player as NativePlayer).renderSharedTexture(
          this.renderSize.width,
          this.renderSize.height,
        )
        const referencesReleased = new Promise<void>((resolve) => {
          imported = electron.sharedTexture!.importSharedTexture({
            textureInfo,
            allReferencesReleased: () => {
              this.sharedTextureFrameInFlight = false
              resolve()
            },
          })
        })
        await electron.sharedTexture.sendSharedTexture({
          frame: this.window.webContents.mainFrame,
          importedSharedTexture: imported!,
        }, this.id)
        imported!.release()
        await referencesReleased
      } catch (error) {
        this.sharedTextureFrameInFlight = false
        imported?.release()
        throw error
      }
    } else {
      const frame = await (this.player as NativePlayer).renderFrame(this.renderSize.width, this.renderSize.height)
      if (this.destroyed || this.window.isDestroyed()) return
      const rgba = frame.rgba.buffer.slice(
        frame.rgba.byteOffset,
        frame.rgba.byteOffset + frame.rgba.byteLength,
      )
      this.window.webContents.send(channel('player:frame'), {
        playerId: this.id,
        width: frame.width,
        height: frame.height,
        rgba,
      }, [rgba])
    }
  }

  private queueFrame() {
    this.framePumpPending = true
    if (this.framePumpRunning || this.destroyed) return
    this.framePumpRunning = true

    const pump = (async () => {
      try {
        while (this.framePumpPending && !this.destroyed && !this.window.isDestroyed()) {
          this.framePumpPending = false
          try {
            await this.renderOneFrame()
          } catch (error) {
            this.sharedTextureFrameInFlight = false
            if (this.pipeline === 'd3d11') this.failGpu(error)
            else this.sendError('render-error', error)
          }
        }
      } finally {
        this.framePumpRunning = false
        this.framePumpPromise = null
        if (this.framePumpPending && !this.destroyed && !this.window.isDestroyed()) {
          this.queueFrame()
        }
      }
    })()

    this.framePumpPromise = pump
    void pump
  }

  private queueEvents() {
    this.eventPumpPending = true
    if (this.eventPumpRunning || this.destroyed) return
    this.eventPumpRunning = true
    queueMicrotask(() => {
      try {
        while (this.eventPumpPending && !this.destroyed && !this.window.isDestroyed()) {
          this.eventPumpPending = false
          try {
            for (const event of this.player.pollEvents()) this.sendEvent(event)
          } catch (error) {
            this.sendError('event-error', error)
          }
        }
      } finally {
        this.eventPumpRunning = false
        if (this.eventPumpPending && !this.destroyed && !this.window.isDestroyed()) {
          this.queueEvents()
        }
      }
    })
  }

  private startCallbacks() {
    this.player.setUpdateCallback(() => this.queueFrame())
    this.player.setEventCallback(() => this.queueEvents())
    this.queueFrame()
    this.queueEvents()
  }

  private stopCallbacks() {
    this.framePumpPending = false
    this.eventPumpPending = false
    this.player.setUpdateCallback()
    this.player.setEventCallback()
  }

  private async waitForFramePump() {
    while (this.framePumpPromise) await this.framePumpPromise
  }
}

class MpvMainService implements MpvMain {
  private readonly sessions = new Map<string, PlayerSession>()
  private readonly windows = new Map<number, AttachedWindow>()
  private readonly pendingOwners = new Map<number, { cancelled: boolean }>()
  private nativeModule: NativeModule | null = null
  private disposed = false

  constructor(private readonly options: MpvMainOptions) {
    this.registerIpc()
  }

  attachWindow(window: BrowserWindow) {
    this.assertActive()
    const id = window.webContents.id
    if (this.windows.has(id)) return
    const onClosed = () => {
      this.windows.delete(id)
      void this.destroyOwnerSessions(id)
    }
    const onNavigation = (_event: unknown, _url: unknown, inPlace: unknown, main: unknown) => {
      if (main === true && inPlace !== true) {
        const attached = this.windows.get(id)
        if (attached) attached.ready = false
        void this.destroyOwnerSessions(id)
      }
    }
    const onLoaded = () => {
      const attached = this.windows.get(id)
      if (attached) attached.ready = true
    }
    const onGone = () => {
      const attached = this.windows.get(id)
      if (attached) attached.ready = false
      void this.destroyOwnerSessions(id)
    }
    this.windows.set(id, { window, onClosed, onNavigation, onLoaded, onGone, ready: false })
    window.once('closed', onClosed)
    window.webContents.on('did-start-navigation', onNavigation)
    window.webContents.on('did-finish-load', onLoaded)
    window.webContents.on('render-process-gone', onGone)
  }

  async detachWindow(window: BrowserWindow) {
    const attached = this.windows.get(window.webContents.id)
    if (attached) {
      attached.window.off('closed', attached.onClosed)
      window.webContents.off('did-start-navigation', attached.onNavigation)
      window.webContents.off('did-finish-load', attached.onLoaded)
      window.webContents.off('render-process-gone', attached.onGone)
      this.windows.delete(window.webContents.id)
    }
    await this.destroyWindowSessions(window)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const token of this.pendingOwners.values()) token.cancelled = true

    for (const attached of this.windows.values()) {
      attached.window.off('closed', attached.onClosed)
      if (!attached.window.webContents.isDestroyed()) {
        attached.window.webContents.off('did-start-navigation', attached.onNavigation)
        attached.window.webContents.off('did-finish-load', attached.onLoaded)
        attached.window.webContents.off('render-process-gone', attached.onGone)
      }
    }
    this.windows.clear()
    for (const name of IPC_CHANNELS) electron.ipcMain.removeHandler(channel(name))
    await Promise.all(Array.from(this.sessions.values(), (session) => session.destroy()))
    if (activeService === this) activeService = null
  }

  private assertActive() {
    if (this.disposed) throw new Error('MpvMain service has been disposed')
  }

  private getNativeModule() {
    if (!this.nativeModule) {
      this.nativeModule = require(this.options.addonPath ?? defaultAddonPath()) as NativeModule
    }
    return this.nativeModule
  }

  private resolveOwner(event: IpcMainInvokeEvent) {
    this.assertActive()
    if (!this.options.authorize?.(event)) throw new Error('Unauthorized MPV frame')
    const attached = this.windows.get(event.sender.id)
    if (!attached || attached.window.isDestroyed()) {
      throw new Error('The sender BrowserWindow is not attached to electron-mpv-video')
    }
    if (!attached.ready) throw new Error('MPV document is navigating or not loaded')
    return attached.window
  }

  private getOwnedSession(event: IpcMainInvokeEvent, playerIdValue: unknown) {
    this.resolveOwner(event)
    const playerId = normalizePlayerId(playerIdValue)
    const session = this.sessions.get(playerId)
    if (!session) throw new Error(`Unknown player session: ${playerId}`)
    if (!session.belongsTo(event.sender)) {
      throw new Error(`Player session does not belong to the sender: ${playerId}`)
    }
    return session
  }

  private async destroyWindowSessions(window: BrowserWindow) {
    await this.destroyOwnerSessions(window.webContents.id)
  }

  private async destroyOwnerSessions(ownerWebContentsId: number) {
    const pending = this.pendingOwners.get(ownerWebContentsId)
    if (pending) pending.cancelled = true
    const owned = Array.from(this.sessions.values()).filter((session) =>
      session.belongsTo(ownerWebContentsId),
    )
    await Promise.all(owned.map((session) => session.destroy()))
  }

  private registerIpc() {
    electron.ipcMain.handle(channel('player:capabilities'), async event => {
      this.resolveOwner(event)
      return this.capabilities()
    })
    electron.ipcMain.handle(channel('player:create'), async (event, value?: unknown) => {
      const owner = this.resolveOwner(event)
      if (this.pendingOwners.has(event.sender.id) || Array.from(this.sessions.values()).some(session => session.belongsTo(event.sender))) throw new Error('An active or pending MPV session already exists')
      const options = value && typeof value === 'object'
        ? value as { pipeline?: unknown; renderSize?: unknown }
        : {}
      const pipeline = normalizePipeline(options.pipeline ?? (this.capabilities().supportsD3d11 ? 'd3d11' : 'software'))
      if (pipeline === 'd3d11' && (this.options.preferredPipeline !== 'd3d11' || process.platform !== 'win32' || process.arch !== 'x64'))
        throw new Error('D3D11 is unavailable in this package')
      const renderSize = normalizeRenderSize(options.renderSize ?? { width: 960, height: 540 })
      const token = { cancelled: false }
      this.pendingOwners.set(event.sender.id, token)
      try {
      const session = await PlayerSession.create(
        owner,
        owner.webContents.id,
        this.getNativeModule(),
        (id) => this.sessions.delete(id),
        {
          pipeline,
          renderSize,
        },
        this.options.diagnostic,
      )
      if (token.cancelled || this.disposed || this.windows.get(event.sender.id)?.ready !== true || owner.isDestroyed()) {
        await session.destroy()
        throw new Error('MPV initialization cancelled by navigation or disposal')
      }
      this.sessions.set(session.id, session)
      try { await session.start(gpuEvent => {
        try { return this.resolveOwner(gpuEvent as IpcMainInvokeEvent) === owner }
        catch { return false }
      }) }
      catch (error) { await session.destroy(); throw error }
      if (token.cancelled || this.disposed || this.windows.get(event.sender.id)?.ready !== true) {
        await session.destroy()
        throw new Error('MPV initialization cancelled by navigation or disposal')
      }
      return { id: session.id, actualPipeline: session.actualPipeline }
      } finally {
        if (this.pendingOwners.get(event.sender.id) === token) this.pendingOwners.delete(event.sender.id)
      }
    })

    const command = (event: IpcMainInvokeEvent, id: unknown, operation: (session: PlayerSession) => unknown) => {
      const session = this.getOwnedSession(event, id)
      return session.run(() => operation(session))
    }
    electron.ipcMain.handle(channel('player:open'), async (event, id, source, headers) =>
      command(event, id, session => session.open(this.options.normalizeSource ? this.options.normalizeSource(source) : normalizeSource(source), normalizeHeaders(headers))))
    electron.ipcMain.handle(channel('player:play'), async (event, id) =>
      command(event, id, session => session.play()))
    electron.ipcMain.handle(channel('player:pause'), async (event, id) =>
      command(event, id, session => session.pause()))
    electron.ipcMain.handle(channel('player:stop'), async (event, id) =>
      command(event, id, session => session.stop()))
    electron.ipcMain.handle(channel('player:seek'), async (event, id, seconds) =>
      command(event, id, session => session.seek(finiteNumber(seconds, 'seconds'))))
    electron.ipcMain.handle(channel('player:set-volume'), async (event, id, value) =>
      command(event, id, session => session.setVolume(finiteNumber(value, 'volume'))))
    electron.ipcMain.handle(channel('player:set-speed'), async (event, id, value) =>
      command(event, id, session => session.setSpeed(value)))
    electron.ipcMain.handle(channel('player:set-audio-track'), async (event, id, value) =>
      command(event, id, session => session.setTrack('audio', value)))
    electron.ipcMain.handle(channel('player:set-subtitle-track'), async (event, id, value) =>
      command(event, id, session => session.setTrack('sub', value)))
    electron.ipcMain.handle(channel('player:set-render-size'), async (event, id, size) =>
      command(event, id, session => session.setRenderSize(normalizeRenderSize(size))))
    electron.ipcMain.handle(channel('player:set-render-pipeline'), async (event, id, pipeline) =>
      command(event, id, session => {
        const next = normalizePipeline(pipeline)
        if (next === 'd3d11' && (this.options.preferredPipeline !== 'd3d11' || process.platform !== 'win32' || process.arch !== 'x64'))
          throw new Error('D3D11 is unavailable in this package')
        return session.setRenderPipeline(next)
      }))
    electron.ipcMain.handle(channel('player:destroy'), async (event, id) =>
      this.getOwnedSession(event, id).destroy())
  }

  private capabilities() {
    const supportsD3d11 = this.options.preferredPipeline === 'd3d11' &&
      process.platform === 'win32' && process.arch === 'x64' &&
      Boolean(electron.sharedTexture?.subtle?.importSharedTexture) &&
      typeof this.getNativeModule().createD3d11Player === 'function'
    return { supportsD3d11, defaultRenderMode: supportsD3d11 ? 'd3d11' : 'webgl' }
  }
}

export function createMpvMain(options: MpvMainOptions = {}): MpvMain {
  if (activeService) {
    throw new Error('Only one electron-mpv-video main service can be active at a time')
  }
  activeService = new MpvMainService(options)
  return activeService
}
