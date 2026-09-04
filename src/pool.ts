import type { Settings, Stats } from './lib/pixelfix'
import type { JobRequest, JobResponse } from './worker'

export interface PoolResult {
  data: Uint8ClampedArray
  width: number
  height: number
  stats: Stats
  ms: number
}

/**
 * Пул воркеров: держит обработку вне главного потока, поэтому ползунки
 * остаются отзывчивыми даже когда считается целая папка.
 */
export class WorkerPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: Array<() => void> = []
  private pending = new Map<string, (result: PoolResult) => void>()
  private counter = 0

  constructor(size = Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1))) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<JobResponse>) => {
        const { id, width, height, buffer, stats, ms } = event.data
        const resolve = this.pending.get(id)
        this.pending.delete(id)
        this.idle.push(worker)
        this.pump()
        resolve?.({ data: new Uint8ClampedArray(buffer), width, height, stats, ms })
      }
      this.workers.push(worker)
      this.idle.push(worker)
    }
  }

  run(image: { data: Uint8ClampedArray; width: number; height: number }, settings: Settings) {
    return new Promise<PoolResult>((resolve) => {
      const id = `job-${this.counter++}`
      this.pending.set(id, resolve)
      // Копия нужна: буфер уходит воркеру во владение, а исходник ещё нужен.
      const copy = image.data.slice()
      const request: JobRequest = {
        id,
        width: image.width,
        height: image.height,
        buffer: copy.buffer as ArrayBuffer,
        settings,
      }
      this.queue.push(() => {
        const worker = this.idle.pop()!
        worker.postMessage(request, [request.buffer])
      })
      this.pump()
    })
  }

  private pump() {
    while (this.queue.length && this.idle.length) this.queue.shift()!()
  }

  terminate() {
    for (const worker of this.workers) worker.terminate()
  }
}
