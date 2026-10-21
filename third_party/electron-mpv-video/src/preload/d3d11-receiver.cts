import type { IpcRenderer, SharedTexture, SharedTextureImportedSubtle, SharedTextureTransfer } from 'electron'
import { GPU_ACK_CHANNEL, GPU_TRANSFER_CHANNEL, gpuLeaseKey, validGpuMetadata } from '../shared/gpu-frame.js'
import type { GpuFrameMetadata } from '../shared/gpu-frame.js'

interface Options {
  ipcRenderer: Pick<IpcRenderer, 'on' | 'removeListener' | 'send'>
  sharedTexture: SharedTexture
  onFrame: (frame: VideoFrame, metadata: GpuFrameMetadata) => void | Promise<void>
  playerId?: string
}

export function registerD3d11Receiver({ ipcRenderer, sharedTexture, onFrame, playerId }: Options): () => Promise<void> {
  const pending = new Set<Promise<void>>()
  const active = new Set<string>()
  let disposed = false
  let latestGeneration = 0
  let latestSequence = 0
  const lastSeen = new Map<number, number>()
  let retiredFloor = 0
  const listener = (_event: unknown, packet: unknown) => {
    if (disposed || !packet || typeof packet !== 'object') return
    const { metadata, transfer } = packet as { metadata?: unknown, transfer?: SharedTextureTransfer }
    if (!validGpuMetadata(metadata) || (playerId && metadata.playerId !== playerId) || !transfer ||
        active.has(gpuLeaseKey(metadata)) || active.size >= 6) return
    if (metadata.generation <= retiredFloor || metadata.sequence <= (lastSeen.get(metadata.generation) ?? 0)) return
    lastSeen.set(metadata.generation, metadata.sequence)
    if (lastSeen.size > 2) {
      const oldest = Math.min(...lastSeen.keys())
      lastSeen.delete(oldest)
      retiredFloor = Math.max(retiredFloor, oldest)
    }
    const key = gpuLeaseKey(metadata)
    const stale = metadata.generation < latestGeneration ||
      (metadata.generation === latestGeneration && metadata.sequence <= latestSequence)
    if (!stale) {
      latestGeneration = metadata.generation
      latestSequence = metadata.sequence
    }
    active.add(key)
    const receive = async () => {
      let imported: SharedTextureImportedSubtle | undefined
      let frame: VideoFrame | undefined
      let callbackFailed = false
      try {
        imported = sharedTexture.subtle.finishTransferSharedTexture(transfer)
        ipcRenderer.send(GPU_ACK_CHANNEL, { playerId: metadata.playerId, slot: metadata.slot,
          generation: metadata.generation, sequence: metadata.sequence, phase: 'imported',
          syncToken: imported.getFrameCreationSyncToken() })
        frame = imported.getVideoFrame()
        if (!stale && !disposed) await onFrame(frame, metadata)
      } catch { callbackFailed = true }
      finally {
        try { frame?.close() }
        catch { callbackFailed = true }
        finally { if (imported) {
          await new Promise<void>(resolve => {
            imported!.release(() => {
              try {
                ipcRenderer.send(GPU_ACK_CHANNEL, { playerId: metadata.playerId, slot: metadata.slot,
                  generation: metadata.generation, sequence: metadata.sequence, phase: 'released',
                  ...(callbackFailed ? { errorCode: 'GPU_FRAME_CALLBACK' } : {}) })
              } catch { /* Navigation can close IPC while GPU cleanup is finishing. */ }
              finally { resolve() }
            })
          })
        } }
      }
    }
    const work = receive().catch(() => { /* The owner watchdog quarantines failed imports/releases. */ })
      .finally(() => { active.delete(key); pending.delete(work) })
    pending.add(work)
  }
  ipcRenderer.on(GPU_TRANSFER_CHANNEL, listener)
  return async () => {
    disposed = true
    ipcRenderer.removeListener(GPU_TRANSFER_CHANNEL, listener)
    // In-flight callbacks retain their frames until their GPU-safe finally runs.
    // A renderer shutdown must not wait indefinitely for a failed consumer.
  }
}
