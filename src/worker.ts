/// <reference lib="webworker" />
import { processImage, type Settings, type Stats } from './lib/pixelfix'

export interface JobRequest {
  id: string
  width: number
  height: number
  buffer: ArrayBuffer
  settings: Settings
}

export interface JobResponse {
  id: string
  width: number
  height: number
  buffer: ArrayBuffer
  stats: Stats
  ms: number
}

self.onmessage = (event: MessageEvent<JobRequest>) => {
  const { id, width, height, buffer, settings } = event.data
  const started = performance.now()
  const { image, stats } = processImage(
    { data: new Uint8ClampedArray(buffer), width, height },
    settings,
  )
  const out = image.data.buffer as ArrayBuffer
  const response: JobResponse = {
    id,
    width: image.width,
    height: image.height,
    buffer: out,
    stats,
    ms: Math.round(performance.now() - started),
  }
  ;(self as unknown as Worker).postMessage(response, [out])
}
