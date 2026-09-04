import { useCallback, useEffect, useRef, useState } from 'react'

interface View {
  scale: number
  x: number
  y: number
}

const MIN_SCALE = 0.05
const MAX_SCALE = 64

/** Шахматка рисуется в экранных координатах, поэтому клетки не «плывут» при зуме. */
function makeChecker(ctx: CanvasRenderingContext2D): CanvasPattern {
  const tile = document.createElement('canvas')
  tile.width = 16
  tile.height = 16
  const tctx = tile.getContext('2d')!
  tctx.fillStyle = '#d8d8d8'
  tctx.fillRect(0, 0, 16, 16)
  tctx.fillStyle = '#b8b8b8'
  tctx.fillRect(0, 0, 8, 8)
  tctx.fillRect(8, 8, 8, 8)
  return ctx.createPattern(tile, 'repeat')!
}

/**
 * Холсты получают картинки ссылками на блобы, а не массивами пикселей:
 * распакованный кадр 512×512 весит мегабайт, и держать их пачкой нельзя.
 */
async function toBitmap(src: string | null): Promise<ImageBitmap | null> {
  if (!src) return null
  const blob = await fetch(src).then((response) => response.blob())
  return createImageBitmap(blob)
}

/**
 * Две картинки бок о бок с общим зумом и сдвигом: один и тот же вид
 * рисуется на обоих холстах, поэтому глаз сравнивает одну и ту же область.
 */
export function CompareViewer({
  before,
  after,
  captionBefore,
  captionAfter,
  onPick,
  viewKey,
}: {
  before: string
  after: string | null
  captionBefore: string
  captionAfter: string
  onPick?: (x: number, y: number) => void
  /** Что считать «другой картинкой». Правки меняют before, но не вид. */
  viewKey: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLCanvasElement>(null)
  const rightRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [bitmaps, setBitmaps] = useState<{ before: ImageBitmap | null; after: ImageBitmap | null }>(
    { before: null, after: null },
  )
  const dragging = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const fitted = useRef<string>('')

  // Размер холстов следует за колонкой, поэтому превью занимает всю ширину.
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      setSize({ width: Math.max(1, (box.width - 12) / 2), height: Math.max(1, box.height - 26) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    Promise.all([toBitmap(before), toBitmap(after)]).then(([b, a]) => {
      if (alive) setBitmaps({ before: b, after: a })
    })
    return () => {
      alive = false
    }
  }, [before, after])

  const source = bitmaps.before
  const fit = useCallback(() => {
    if (!size.width || !size.height || !source) return
    const scale = Math.min(size.width / source.width, size.height / source.height) * 0.94
    setView({
      scale,
      x: (size.width - source.width * scale) / 2,
      y: (size.height - source.height * scale) / 2,
    })
  }, [source, size])

  // Вписываем заново только при смене ассета или размера окна. Ключ берём по
  // viewKey, а не по before: стирание рисует новый объектный URL, и по нему
  // вид сбрасывался бы после каждого клика пипеткой или ластиком.
  useEffect(() => {
    if (!source) return
    const key = `${viewKey}:${size.width}x${size.height}`
    if (fitted.current === key) return
    fitted.current = key
    fit()
  }, [fit, viewKey, source, size])

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    for (const [ref, bitmap] of [
      [leftRef, bitmaps.before],
      [rightRef, bitmaps.after],
    ] as const) {
      const canvas = ref.current
      if (!canvas) continue
      canvas.width = Math.round(size.width * dpr)
      canvas.height = Math.round(size.height * dpr)
      canvas.style.width = `${size.width}px`
      canvas.style.height = `${size.height}px`
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.width, size.height)
      ctx.fillStyle = makeChecker(ctx)
      ctx.fillRect(0, 0, size.width, size.height)
      if (!bitmap) continue
      ctx.imageSmoothingEnabled = false
      ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y)
      ctx.drawImage(bitmap, 0, 0)
    }
  }, [bitmaps, view, size])

  // Колесо слушаем вручную: React вешает пассивный обработчик, который
  // не даёт отменить прокрутку страницы.
  useEffect(() => {
    const zoomAt = (canvas: HTMLCanvasElement, event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      setView((current) => {
        const factor = Math.exp(-event.deltaY * 0.0015)
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
        const ratio = scale / current.scale
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
      })
    }
    const handlers: Array<[HTMLCanvasElement, (e: WheelEvent) => void]> = []
    for (const ref of [leftRef, rightRef]) {
      const canvas = ref.current
      if (!canvas) continue
      const handler = (event: WheelEvent) => zoomAt(canvas, event)
      canvas.addEventListener('wheel', handler, { passive: false })
      handlers.push([canvas, handler])
    }
    return () => handlers.forEach(([canvas, handler]) => canvas.removeEventListener('wheel', handler))
  }, [])

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = { x: event.clientX, y: event.clientY, moved: false }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    const dx = event.clientX - dragging.current.x
    const dy = event.clientY - dragging.current.y
    if (Math.abs(dx) + Math.abs(dy) > 2) dragging.current.moved = true
    dragging.current = { x: event.clientX, y: event.clientY, moved: dragging.current.moved }
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId)
    // Клик без протяжки в режиме пипетки — выбор цвета под курсором.
    if (onPick && dragging.current && !dragging.current.moved) {
      const rect = event.currentTarget.getBoundingClientRect()
      const x = Math.floor((event.clientX - rect.left - view.x) / view.scale)
      const y = Math.floor((event.clientY - rect.top - view.y) / view.scale)
      if (source && x >= 0 && y >= 0 && x < source.width && y < source.height) onPick(x, y)
    }
    dragging.current = null
  }

  const zoomBy = (factor: number) =>
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
      const ratio = scale / current.scale
      const cx = size.width / 2
      const cy = size.height / 2
      return { scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio }
    })

  const oneToOne = () =>
    setView((current) => {
      const cx = size.width / 2
      const cy = size.height / 2
      const ratio = 1 / current.scale
      return { scale: 1, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio }
    })

  const canvasProps = {
    className: onPick ? 'viewer-canvas picking' : 'viewer-canvas',
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onDoubleClick: fit,
  }

  return (
    <section className="viewer">
      <div className="viewer-bar">
        <button onClick={() => zoomBy(1 / 1.4)}>−</button>
        <span className="zoom">{Math.round(view.scale * 100)}%</span>
        <button onClick={() => zoomBy(1.4)}>+</button>
        <button onClick={fit}>Вписать</button>
        <button onClick={oneToOne}>1:1</button>
        <span className="note">колесо — зум к курсору, перетаскивание — сдвиг, двойной клик — вписать</span>
      </div>
      <div className="viewer-body" ref={wrapRef}>
        <div className="viewer-pane">
          <canvas ref={leftRef} {...canvasProps} />
          <figcaption>{captionBefore}</figcaption>
        </div>
        <div className="viewer-pane">
          <canvas ref={rightRef} {...canvasProps} />
          <figcaption>{captionAfter}</figcaption>
        </div>
      </div>
    </section>
  )
}
