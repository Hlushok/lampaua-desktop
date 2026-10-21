import type { SharedTextureImportTextureInfo, SharedTextureSyncToken } from 'electron'

export const GPU_TRANSFER_CHANNEL = 'electron-mpv-video:v1:gpu:transfer'
export const GPU_ACK_CHANNEL = 'electron-mpv-video:v1:gpu:ack'

export interface GpuFrameKey {
  slot: number
  generation: number
  sequence: number
}

export interface GpuFrameMetadata extends GpuFrameKey {
  playerId: string
  targetTimeNs: number
  frameFlags: number
}

export interface NativeGpuFrame {
  key: GpuFrameKey
  textureInfo: SharedTextureImportTextureInfo
  targetTimeNs: number
  frameFlags: number
  renderSubmissionMs: number
  gpuReadyMs: number
}

export interface GpuAck extends GpuFrameKey {
  playerId: string
  phase: 'imported' | 'released'
  syncToken?: SharedTextureSyncToken
  errorCode?: 'GPU_FRAME_CALLBACK'
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validGpuKey(value: unknown): value is GpuFrameKey {
  if (!record(value)) return false
  return Number.isSafeInteger(value.slot) && (value.slot as number) >= 0 && (value.slot as number) < 3 &&
    Number.isSafeInteger(value.generation) && (value.generation as number) > 0 &&
    Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0
}

export function validGpuMetadata(value: unknown): value is GpuFrameMetadata {
  if (!record(value) || !validGpuKey(value)) return false
  const item = value as unknown as Record<string, unknown>
  return typeof item.playerId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(item.playerId) &&
    typeof item.targetTimeNs === 'number' && Number.isFinite(item.targetTimeNs) && item.targetTimeNs >= 0 &&
    Number.isSafeInteger(item.frameFlags) && (item.frameFlags as number) >= 0 && (item.frameFlags as number) <= 15
}

export function validGpuAck(value: unknown): value is GpuAck {
  if (!record(value) || !validGpuKey(value)) return false
  const item = value as unknown as Record<string, unknown>
  if (typeof item.playerId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(item.playerId) ||
      Object.keys(item).some(key => !['playerId', 'slot', 'generation', 'sequence', 'phase', 'syncToken', 'errorCode'].includes(key))) return false
  if (item.phase === 'released') return item.syncToken === undefined &&
    (item.errorCode === undefined || item.errorCode === 'GPU_FRAME_CALLBACK')
  if (item.phase !== 'imported' || item.errorCode !== undefined || !record(item.syncToken)) return false
  const token = item.syncToken
  return Object.keys(token).length === 1 && typeof token.syncToken === 'string' &&
    token.syncToken.length > 0 && token.syncToken.length <= 4096 && /^[\x20-\x7e]+$/.test(token.syncToken)
}

export function gpuLeaseKey(key: GpuFrameKey): string {
  return `${key.generation}:${key.slot}:${key.sequence}`
}
