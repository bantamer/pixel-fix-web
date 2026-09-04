import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Position {
  x: number
  y: number
}

/**
 * Плавающее окно с настройками инструмента: таскается за заголовок,
 * помнит своё место между запусками.
 */
export function FloatingPanel({
  id,
  title,
  onClose,
  initial,
  children,
}: {
  id: string
  title: string
  onClose: () => void
  initial: Position
  children: ReactNode
}) {
  const storageKey = `pixel-fix:panel:${id}`
  const [position, setPosition] = useState<Position>(() => {
    // Место могло сохраниться при другом размере окна. Загоняем его в
    // видимую область, но только если размеры уже известны: в свёрнутой
    // панели предпросмотра innerWidth равен нулю, и кламп свалил бы все
    // окна в один угол.
    const clamp = (p: Position): Position =>
      window.innerWidth < 200
        ? p
        : {
            x: Math.min(Math.max(p.x, 8), window.innerWidth - 280),
            y: Math.min(Math.max(p.y, 8), window.innerHeight - 80),
          }
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) return clamp(JSON.parse(saved) as Position)
    } catch {
      // приватный режим — просто встанем на место по умолчанию
    }
    return clamp(initial)
  })
  const drag = useRef<{ dx: number; dy: number } | null>(null)


  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(position))
    } catch {
      // не смогли запомнить место — не беда
    }
  }, [storageKey, position])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Захват указателя на заголовке съедает клик по крестику: событие уходит
    // заголовку, а не кнопке. Поэтому нажатие на кнопку не начинает перенос.
    if ((event.target as HTMLElement).closest('button')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // Не даём утащить окно за пределы экрана: заголовок должен остаться в руках.
    const x = Math.min(Math.max(event.clientX - drag.current.dx, 0), window.innerWidth - 120)
    const y = Math.min(Math.max(event.clientY - drag.current.dy, 0), window.innerHeight - 40)
    setPosition({ x, y })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null
  }

  return (
    <section className="panel-window" style={{ left: position.x, top: position.y }}>
      <header
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span>{title}</span>
        <button
          className="close"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          title="Закрыть"
        >
          ×
        </button>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}
