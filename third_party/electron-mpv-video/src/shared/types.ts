export type RenderMode = 'shared-texture' | 'webgl' | 'canvas2d' | 'd3d11'
export type RenderPipeline = 'shared-texture' | 'software' | 'd3d11'
export type PlayerCapabilities = { defaultRenderMode: RenderMode; supportsD3d11: boolean }

export type PlayerFrame = {
  playerId: string
  width: number
  height: number
  rgba: ArrayBuffer
}

export type PlayerEvent = {
  playerId: string
  type: string
  name?: string
  data?: unknown
  error?: string
  reason?: number
}

export type PlayerCreateOptions = {
  renderMode?: RenderMode
  width?: number
  height?: number
}

export type Dispose = () => void

export type MpvPlayerSession = {
  readonly id: string
  readonly pipeline: RenderPipeline
  open(source: string, headers?: Record<string, string>): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  seek(seconds: number): Promise<void>
  setVolume(value: number): Promise<void>
  setSpeed(value: number): Promise<void>
  setAudioTrack(id: number | 'no'): Promise<void>
  setSubtitleTrack(id: number | 'no'): Promise<void>
  setRenderSize(width: number, height: number): Promise<void>
  setRenderMode(mode: RenderMode): Promise<void>
  destroy(): Promise<void>
  onFrame(callback: (frame: PlayerFrame) => void): Dispose
  onSharedTextureFrame(callback: (frame: VideoFrame) => Promise<void> | void): Dispose
  onGpuFrame(callback: (frame: VideoFrame, metadata: import('./gpu-frame.js').GpuFrameMetadata) => Promise<void> | void): Dispose
  onEvent(callback: (event: PlayerEvent) => void): Dispose
}

export type ElectronMpvVideoApi = {
  readonly platform: string
  readonly supportsSharedTexture: boolean
  getCapabilities(): Promise<PlayerCapabilities>
  create(options?: PlayerCreateOptions): Promise<MpvPlayerSession>
}

export type MpvVideoState = {
  playerId: string
  status: string
  renderMode: RenderMode
  rendererName: string
  time: number
  duration: number
  width: number
  height: number
  codec: string
  fps: number
}

declare global {
  interface Window {
    _electronMpvVideo: ElectronMpvVideoApi
  }
}
