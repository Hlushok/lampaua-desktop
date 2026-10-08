import * as electron from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { RenderPipeline } from '../shared/types.js'

const CHANNEL_PREFIX = 'electron-mpv-video:v1'
const channel = (name: string) => `${CHANNEL_PREFIX}:${name}`
const IPC_CHANNELS = [
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
  renderFrame(width: number, height: number): NativeFrame
  renderSharedTexture(width: number, height: number): Electron.SharedTextureImportTextureInfo
  pollEvents(): NativeEvent[]
  destroy(): void
}

type NativeModule = {
  MpvPlayer: new (options?: { mode?: RenderPipeline }) => NativePlayer
}

type RenderSize = {
  width: number
  height: number
}

type AttachedWindow = {
  window: BrowserWindow
  onClosed: () => void
  onNavigation: (...args: any[]) => void
  onLoaded: () => void
  ready: boolean
}

export type MpvMainOptions = {
  addonPath?: string
  authorize?: (event: IpcMainInvokeEvent) => boolean
  normalizeSource?: (source: unknown) => string
  diagnostic?: (type: string, data: { playerId?: string; error?: string; format?: string }) => void
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
  if (value !== 'software' && value !== 'shared-texture') {
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
  private player: NativePlayer
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
  private volume = 100
  private paused = true
  private stopped = true
  private tracks: Array<{ id: number; type: string }> = []

  constructor(
    private readonly window: BrowserWindow,
    private readonly ownerWebContentsId: number,
    private readonly nativeModule: NativeModule,
    private readonly onDestroyed: (id: string) => void,
    options: { pipeline: RenderPipeline; renderSize: RenderSize },
    private readonly diagnostic: NonNullable<MpvMainOptions['diagnostic']> = () => {},
  ) {
    this.pipeline = options.pipeline
    if (this.pipeline === 'shared-texture' && !supportsSharedTexturePipeline()) {
      this.pipeline = 'software'
    }
    this.renderSize = options.renderSize
    this.player = new this.nativeModule.MpvPlayer({ mode: this.pipeline })
    this.startCallbacks()
  }

  belongsTo(sender: WebContents | number) {
    return this.ownerWebContentsId === (typeof sender === 'number' ? sender : sender.id)
  }

  open(source: string, headers: string[]) {
    this.assertAlive()
    this.tracks = []
    const format = manifestFormat(source)
    this.diagnostic('open', {playerId: this.id, format})
    this.player.open(source, headers, format)
    this.source = source
    this.headers = headers
    this.currentTime = 0
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
    this.player.stop()
    this.currentTime = 0
    this.paused = true
    this.stopped = true
  }

  seek(seconds: number) {
    this.assertAlive()
    const nextTime = bounded(seconds, 'seconds', 0, Number.MAX_SAFE_INTEGER)
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
    this.player.setSpeed(bounded(value, 'speed', 0.25, 4))
  }

  setTrack(type: 'audio' | 'sub', id: unknown) {
    this.assertAlive()
    if (id !== 'no' && (!Number.isInteger(id) || !this.tracks.some(track => track.id === id && track.type === type))) {
      throw new TypeError('Unknown track for this media')
    }
    if (type === 'audio') this.player.setAudioTrack(id as number | 'no')
    else this.player.setSubtitleTrack(id as number | 'no')
  }

  setRenderSize(size: RenderSize) {
    this.assertAlive()
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
    const previousPipeline = this.pipeline
    this.stopCallbacks()
    await this.waitForFramePump()
    this.assertAlive()

    let replacement: NativePlayer | null = null
    let restoredEvents: NativeEvent[] = []
    try {
      replacement = new this.nativeModule.MpvPlayer({ mode: nextPipeline })
      replacement.setVolume(this.volume)
      if (this.source && !this.stopped) {
        replacement.open(this.source, this.headers, manifestFormat(this.source))
        restoredEvents = await this.waitForFileLoaded(replacement)
        this.assertAlive()
        if (this.currentTime > 0) replacement.seek(this.currentTime)
        if (this.paused) replacement.pause()
        else replacement.play()
      }

      this.player = replacement
      this.pipeline = nextPipeline
      for (const event of restoredEvents) {
        const transientProperty = event.type === 'property-change' &&
          (event.name === 'time-pos' || event.name === 'pause' || event.name === 'eof-reached')
        if (!transientProperty) this.sendEvent(event)
      }
      this.startCallbacks()
    } catch (error) {
      replacement?.destroy()
      this.player = previousPlayer
      this.pipeline = previousPipeline
      if (!this.destroyed) this.startCallbacks()
      throw error
    }
    previousPlayer.destroy()
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
      this.player.destroy()
      this.diagnostic('destroy-complete', {playerId: this.id})
    }).finally(() => this.onDestroyed(this.id))
    return this.destroyPromise
  }


  private async waitForFileLoaded(player: NativePlayer) {
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
    } else if (event.name === 'pause' && typeof event.data === 'boolean') {
      this.paused = event.data
    } else if (event.name === 'eof-reached' && event.data === true) {
      this.paused = true
    }
  }

  private sendEvent(event: NativeEvent) {
    if (this.destroyed) return
    this.trackEvent(event)
    if (['file-loaded', 'end-file'].includes(event.type)) {
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
    if (this.pipeline === 'shared-texture') {
      if (!electron.sharedTexture) {
        throw new Error('Electron sharedTexture API is not available in this runtime')
      }
      if (this.sharedTextureFrameInFlight) return

      this.sharedTextureFrameInFlight = true
      let imported: Electron.SharedTextureImported | undefined
      try {
        const textureInfo = this.player.renderSharedTexture(
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
      const frame = this.player.renderFrame(this.renderSize.width, this.renderSize.height)
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
            this.sendError('render-error', error)
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
    this.windows.set(id, { window, onClosed, onNavigation, onLoaded, ready: false })
    window.once('closed', onClosed)
    window.webContents.on('did-start-navigation', onNavigation)
    window.webContents.on('did-finish-load', onLoaded)
  }

  async detachWindow(window: BrowserWindow) {
    const attached = this.windows.get(window.webContents.id)
    if (attached) {
      attached.window.off('closed', attached.onClosed)
      window.webContents.off('did-start-navigation', attached.onNavigation)
      window.webContents.off('did-finish-load', attached.onLoaded)
      this.windows.delete(window.webContents.id)
    }
    await this.destroyWindowSessions(window)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true

    for (const attached of this.windows.values()) {
      attached.window.off('closed', attached.onClosed)
      if (!attached.window.webContents.isDestroyed()) {
        attached.window.webContents.off('did-start-navigation', attached.onNavigation)
        attached.window.webContents.off('did-finish-load', attached.onLoaded)
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
    const owned = Array.from(this.sessions.values()).filter((session) =>
      session.belongsTo(ownerWebContentsId),
    )
    await Promise.all(owned.map((session) => session.destroy()))
  }

  private registerIpc() {
    electron.ipcMain.handle(channel('player:create'), async (event, value?: unknown) => {
      const owner = this.resolveOwner(event)
      if (Array.from(this.sessions.values()).some(session => session.belongsTo(event.sender))) throw new Error('An active MPV session already exists')
      const options = value && typeof value === 'object'
        ? value as { pipeline?: unknown; renderSize?: unknown }
        : {}
      const session = new PlayerSession(
        owner,
        owner.webContents.id,
        this.getNativeModule(),
        (id) => this.sessions.delete(id),
        {
          pipeline: normalizePipeline(options.pipeline ?? 'software'),
          renderSize: normalizeRenderSize(options.renderSize ?? { width: 960, height: 540 }),
        },
        this.options.diagnostic,
      )
      this.sessions.set(session.id, session)
      return session.id
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
      command(event, id, session => session.setRenderPipeline(normalizePipeline(pipeline))))
    electron.ipcMain.handle(channel('player:destroy'), async (event, id) =>
      this.getOwnedSession(event, id).destroy())
  }
}

export function createMpvMain(options: MpvMainOptions = {}): MpvMain {
  if (activeService) {
    throw new Error('Only one electron-mpv-video main service can be active at a time')
  }
  activeService = new MpvMainService(options)
  return activeService
}
