import { MpvVideoElement } from './mpv-video.js'

export { MpvVideoElement } from './mpv-video.js'
export type {
  ElectronMpvVideoApi,
  MpvPlayerSession,
  MpvVideoState,
  PlayerCreateOptions,
  PlayerEvent,
  PlayerFrame,
  RenderMode,
} from '../shared/types.js'

export function defineMpvVideoElement() {
  if (!customElements.get('mpv-video')) {
    customElements.define('mpv-video', MpvVideoElement)
  }
  return MpvVideoElement
}
