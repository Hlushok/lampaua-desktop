import * as electron from 'electron'
import type { IpcMain, IpcMainEvent, SharedTexture, SharedTextureImportedSubtle, WebContents } from 'electron'
import { GPU_ACK_CHANNEL, GPU_TRANSFER_CHANNEL, gpuLeaseKey, validGpuAck, validGpuMetadata } from '../shared/gpu-frame.js'
import type { GpuAck, GpuFrameKey, GpuFrameMetadata, NativeGpuFrame } from '../shared/gpu-frame.js'

type GpuIpcEvent = Pick<IpcMainEvent, 'sender' | 'senderFrame'>
export class D3d11TransportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'D3d11TransportError' }
}

interface Options {
  playerId: string
  owner: WebContents
  authorize: (event: GpuIpcEvent) => boolean
  releaseNative: (key: GpuFrameKey) => Promise<boolean | void>
  onError: (error: D3d11TransportError) => void
  sharedTexture?: SharedTexture
  ipcMain?: Pick<IpcMain, 'on' | 'removeListener'>
  watchdogMs?: number
}

interface Lease {
  metadata: GpuFrameMetadata
  imported?: SharedTextureImportedSubtle
  phase: 'sent' | 'imported' | 'releasing'
  timer: ReturnType<typeof setTimeout>
  completing: boolean
  callbackFailed: boolean
}

const owners = new WeakMap<WebContents, D3d11Transport>()
let outstandingLeases = 0

export class D3d11Transport {
  private readonly leases = new Map<string, Lease>()
  private readonly sharedTexture: SharedTexture
  private readonly ipcMain: Pick<IpcMain, 'on' | 'removeListener'>
  private generation = 1
  private lastSequence = 0
  private failed = false
  private disposed = false
  private detached = false

  constructor(private readonly options: Options) {
    if (owners.has(options.owner)) throw new D3d11TransportError('GPU_OWNER_RETIRED', 'GPU owner has an active or retired transport')
    this.sharedTexture = options.sharedTexture ?? electron.sharedTexture
    this.ipcMain = options.ipcMain ?? electron.ipcMain
    if (!this.sharedTexture?.subtle?.importSharedTexture) throw new D3d11TransportError('GPU_API_UNAVAILABLE', 'Public GPU texture API is unavailable')
    owners.set(options.owner, this)
    this.ipcMain.on(GPU_ACK_CHANNEL, this.onAck)
    options.owner.on('render-process-gone', this.onOwnerGone)
    options.owner.on('destroyed', this.onOwnerGone)
  }

  async send(frame: NativeGpuFrame): Promise<void> {
    const metadata: GpuFrameMetadata = { playerId: this.options.playerId, ...frame.key,
      targetTimeNs: frame.targetTimeNs, frameFlags: frame.frameFlags }
    if (this.disposed || this.failed || this.options.owner.isDestroyed()) throw new D3d11TransportError('GPU_CLOSED', 'GPU transport is closed')
    if (!validGpuMetadata(metadata) || metadata.generation !== this.generation || metadata.sequence <= this.lastSequence)
      throw new D3d11TransportError('GPU_STALE_FRAME', 'Invalid or stale GPU frame sequence')
    const id = gpuLeaseKey(metadata)
    const current = [...this.leases.values()].filter(lease => lease.metadata.generation === this.generation).length
    if (current >= 3 || this.leases.size >= 6 || outstandingLeases >= 6 || this.leases.has(id))
      throw new D3d11TransportError('GPU_BUSY', 'GPU lease limit is busy')
    const lease: Lease = { metadata, phase: 'sent', completing: false, callbackFailed: false,
      timer: setTimeout(() => this.fail('GPU_RELEASE_TIMEOUT', 'GPU release was not confirmed; leases remain retired'), this.options.watchdogMs ?? 5000) }
    lease.timer.unref()
    this.leases.set(id, lease)
    this.lastSequence = metadata.sequence
    outstandingLeases++
    // From here this transport owns the lease even if import/IPC fails.
    try {
      lease.imported = this.sharedTexture.subtle.importSharedTexture(frame.textureInfo)
      const transfer = lease.imported.startTransferSharedTexture()
      this.options.owner.send(GPU_TRANSFER_CHANNEL, { metadata, transfer })
    } catch {
      this.fail('GPU_TRANSFER_FAILED', 'GPU texture transfer failed')
      // An unconfirmed transfer is quarantined, never freed by a timer.
    }
  }

  invalidate(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) throw new D3d11TransportError('GPU_GENERATION', 'Invalid GPU generation')
    const generations = new Set([...this.leases.values()].map(lease => lease.metadata.generation))
    if (generations.size > 1) {
      this.fail('GPU_GENERATION_LIMIT', 'GPU retired generation has not drained')
      return
    }
    this.generation = generation
  }

  stats() { return { leases: this.leases.size, generation: this.generation, failed: this.failed, disposed: this.disposed } }

  async dispose(): Promise<void> {
    this.disposed = true
    this.detachIfDrained()
    // Pending GPU leases keep their exact ack listener and owner reservation.
    // Disposal must not block the UI waiting for a crashed renderer.
  }

  private onOwnerGone = () => this.fail('GPU_OWNER_GONE', 'GPU renderer is no longer available')

  private authorized(event: GpuIpcEvent): boolean {
    try {
      return !this.options.owner.isDestroyed() && event.sender === this.options.owner &&
        event.senderFrame === this.options.owner.mainFrame && this.options.authorize(event)
    } catch { return false }
  }

  private onAck = (event: GpuIpcEvent, value: unknown) => {
    if (!this.authorized(event) || !validGpuAck(value)) return
    const ack: GpuAck = value
    if (ack.playerId !== this.options.playerId) return
    const lease = this.leases.get(gpuLeaseKey(ack))
    if (!lease?.imported) return
    if (ack.phase === 'imported' && lease.phase === 'sent') {
      try {
        lease.imported.setReleaseSyncToken(ack.syncToken!)
        lease.phase = 'imported'
      } catch { this.fail('GPU_SYNC_FAILED', 'GPU creation sync token failed') }
    } else if (ack.phase === 'released' && lease.phase === 'imported') {
      lease.phase = 'releasing'
      lease.callbackFailed = ack.errorCode === 'GPU_FRAME_CALLBACK'
      try {
        lease.imported.release(() => { void this.complete(lease) })
      } catch { this.fail('GPU_RELEASE_FAILED', 'GPU resource release failed') }
    }
  }

  private async complete(lease: Lease) {
    if (lease.completing) return
    lease.completing = true
    try {
      const { slot, generation, sequence } = lease.metadata
      const accepted = await this.options.releaseNative({ slot, generation, sequence })
      if (accepted === false) throw new Error('Native GPU release rejected')
      this.leases.delete(gpuLeaseKey(lease.metadata))
      outstandingLeases--
      clearTimeout(lease.timer)
      if (lease.callbackFailed) this.fail('GPU_FRAME_CALLBACK', 'GPU frame consumer failed')
      this.detachIfDrained()
    } catch { this.fail('GPU_NATIVE_RELEASE', 'Native GPU lease release failed') }
  }

  private fail(code: string, message: string) {
    if (this.failed) return
    this.failed = true
    try {
      void Promise.resolve(this.options.onError(new D3d11TransportError(code, message))).catch(() => {})
    } catch { /* Error reporting must not throw into Electron IPC or a watchdog. */ }
  }

  private detachIfDrained() {
    if (!this.disposed || this.leases.size || this.detached) return
    this.detached = true
    this.ipcMain.removeListener(GPU_ACK_CHANNEL, this.onAck)
    this.options.owner.removeListener('render-process-gone', this.onOwnerGone)
    this.options.owner.removeListener('destroyed', this.onOwnerGone)
    owners.delete(this.options.owner)
  }
}
