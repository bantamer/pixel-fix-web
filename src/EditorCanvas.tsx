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

/** Рисует один холст: шахматка, картинка в текущем виде, контур лассо. */
function paint(
  canvas: HTMLCanvasElement | null,
  image: ImageBitmap | null,
  view: View,
  size: { width: number; height: number },
  lassoScreen: Array<[number, number]>,
): void {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(size.width * dpr)
  canvas.height = Math.round(size.height * dpr)
  canvas.style.width = `${size.width}px`
  canvas.style.height = `${size.height}px`
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.fillStyle = makeChecker(ctx)
  ctx.fillRect(0, 0, size.width, size.height)
  if (image) {
    ctx.imageSmoothingEnabled = false
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y)
    ctx.drawImage(image, 0, 0)
  }
  if (lassoScreen.length > 1) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.beginPath()
    ctx.moveTo(lassoScreen[0][0], lassoScreen[0][1])
    for (const [px, py] of lassoScreen.slice(1)) ctx.lineTo(px, py)
    ctx.closePath()
    ctx.strokeStyle = '#4f8cff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.stroke()
    ctx.setLineDash([])
  }
}

async function toBitmap(src: string | null): Promise<ImageBitmap | null> {
  if (!src) return null
  const blob = await fetch(src).then((response) => response.blob())
  return createImageBitmap(blob)
}

/**
 * Холст редактора: одна картинка, общий зум и сдвиг, инструменты поверх.
 *
 * Картинки приходят ссылками на блобы, а не массивами пикселей: распакованный
 * кадр 1024×1024 весит четыре мегабайта, держать их пачкой нельзя.
 */
export function EditorCanvas({
  source,
  compare,
  overlay,
  viewKey,
  tool,
  compareMode,
  onToggleCompare,
  onPick,
  onLasso,
}: {
  /** Что показывать сейчас — результат или оригинал. */
  source: string | null
  /** Второй холст для сравнения. Null — режим выключен. */
  compare: string | null
  /** Подпись поверх холста. */
  overlay: string
  /** Что считать другой картинкой: правки меняют src, но не вид. */
  viewKey: string
  tool: 'hand' | 'pick' | 'erase' | 'lasso'
  compareMode: boolean
  onToggleCompare: () => void
  onPick?: (x: number, y: number) => void
  onLasso?: (points: Array<[number, number]>) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compareRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [compareBitmap, setCompareBitmap] = useState<ImageBitmap | null>(null)
  const [lassoScreen, setLassoScreen] = useState<Array<[number, number]>>([])
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const lasso = useRef<Array<[number, number]>>([])
  const fitted = useRef('')

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      // В режиме сравнения каждому холсту достаётся половина минус зазор.
      const width = compareMode ? (box.width - 8) / 2 : box.width
      setSize({ width: Math.max(1, width), height: Math.max(1, box.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [compareMode])

  useEffect(() => {
    let alive = true
    toBitmap(source).then((next) => {
      if (alive) setBitmap(next)
    })
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    let alive = true
    toBitmap(compareMode ? compare : null).then((next) => {
      if (alive) setCompareBitmap(next)
    })
    return () => {
      alive = false
    }
  }, [compare, compareMode])

  const fit = useCallback(() => {
    if (!size.width || !size.height || !bitmap) return
    const scale = Math.min(size.width / bitmap.width, size.height / bitmap.height) * 0.92
    setView({
      scale,
      x: (size.width - bitmap.width * scale) / 2,
      y: (size.height - bitmap.height * scale) / 2,
    })
  }, [bitmap, size])

  // Вписываем только при смене картинки или размера окна: правки и пересчёт
  // настроек не должны сбрасывать зум.
  useEffect(() => {
    if (!bitmap) return
    const key = `${viewKey}:${size.width}x${size.height}:${compareMode}`
    if (fitted.current === key) return
    fitted.current = key
    fit()
  }, [fit, viewKey, bitmap, size, compareMode])

  useEffect(() => {
    // Оба холста рисуют один и тот же вид, поэтому глаз сравнивает одну и
    // ту же область при любом зуме.
    if (compareMode) paint(compareRef.current, compareBitmap, view, size, lassoScreen)
    paint(canvasRef.current, bitmap, view, size, lassoScreen)
  }, [bitmap, compareBitmap, compareMode, view, size, lassoScreen])

  // Колесо слушаем вручную: React вешает пассивный обработчик, который не
  // даёт отменить прокрутку страницы.
  useEffect(() => {
    const targets = [canvasRef.current, compareRef.current].filter(Boolean) as HTMLCanvasElement[]
    if (!targets.length) return
    const handler = (event: WheelEvent) => {
      event.preventDefault()
      const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      setView((current) => {
        const factor = Math.exp(-event.deltaY * 0.0015)
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
        const ratio = scale / current.scale
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
      })
    }
    for (const target of targets) target.addEventListener('wheel', handler, { passive: false })
    return () => {
      for (const target of targets) target.removeEventListener('wheel', handler)
    }
  }, [compareMode])

  const toImage = (
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
  ): [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [
      (clientX - rect.left - view.x) / view.scale,
      (clientY - rect.top - view.y) / view.scale,
    ]
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, moved: false }
    if (tool === 'lasso') {
      lasso.current = [toImage(event.currentTarget, event.clientX, event.clientY)]
      const rect = event.currentTarget.getBoundingClientRect()
      setLassoScreen([[event.clientX - rect.left, event.clientY - rect.top]])
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return
    if (tool === 'lasso') {
      lasso.current.push(toImage(event.currentTarget, event.clientX, event.clientY))
      const rect = event.currentTarget.getBoundingClientRect()
      setLassoScreen((current) => [
        ...current,
        [event.clientX - rect.left, event.clientY - rect.top],
      ])
      return
    }
    const dx = event.clientX - drag.current.x
    const dy = event.clientY - drag.current.y
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true
    drag.current = { x: event.clientX, y: event.clientY, moved: drag.current.moved }
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (tool === 'lasso') {
      const points = lasso.current
      lasso.current = []
      setLassoScreen([])
      drag.current = null
      if (points.length > 2) onLasso?.(points)
      return
    }
    // Клик без протяжки в режиме пипетки или палочки — действие по точке.
    if ((tool === 'pick' || tool === 'erase') && drag.current && !drag.current.moved && bitmap) {
      const [x, y] = toImage(event.currentTarget, event.clientX, event.clientY)
      const px = Math.floor(x)
      const py = Math.floor(y)
      if (px >= 0 && py >= 0 && px < bitmap.width && py < bitmap.height) onPick?.(px, py)
    }
    drag.current = null
  }

  const zoomBy = (factor: number) =>
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
      const ratio = scale / current.scale
      const cx = size.width / 2
      const cy = size.height / 2
      return { scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio }
    })

  return (
    <div className="stage">
      <div className="stage-bar">
        <button onClick={() => zoomBy(1 / 1.4)}>−</button>
        <span className="zoom">{Math.round(view.scale * 100)}%</span>
        <button onClick={() => zoomBy(1.4)}>+</button>
        <button onClick={fit}>Вписать</button>
        <button onClick={() => setView((c) => ({ ...c, scale: 1 }))}>1:1</button>
        <button className={compareMode ? 'active' : undefined} onClick={onToggleCompare}>
          Сравнить
        </button>
        <span className="note">{overlay}</span>
      </div>
      <div className={compareMode ? 'stage-body compare' : 'stage-body'} ref={wrapRef}>
        {compareMode && (
          <div className="stage-pane">
            <canvas
              ref={compareRef}
              className={`stage-canvas tool-${tool}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={fit}
            />
            <span className="pane-label">оригинал</span>
          </div>
        )}
        <div className="stage-pane">
          <canvas
            ref={canvasRef}
            className={`stage-canvas tool-${tool}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={fit}
          />
          {compareMode && <span className="pane-label">результат</span>}
        </div>
      </div>
    </div>
  )
}
