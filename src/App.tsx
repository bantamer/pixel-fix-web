import { useCallback, useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  defaultSettings,
  fillPolygon,
  magicSelect,
  removeBackground,
  type Settings,
  type Stats,
} from './lib/pixelfix'
import { EditorCanvas } from './EditorCanvas'
import { FloatingPanel } from './FloatingPanel'
import { Toolbar, type ToolId } from './Toolbar'
import { TOOL_HELP } from './cursors'
import { WorkerPool } from './pool'
import {
  clearSession,
  loadAssets,
  loadEdits,
  loadJson,
  saveAssets,
  saveEdits,
  saveJson,
} from './storage'
import './App.css'

interface Asset {
  id: string
  name: string
  path: string
  file: File
  originalUrl: string
}

/** Правка одного ассета: стереть пиксели или вернуть их из оригинала. */
interface Edit {
  type: 'erase' | 'restore'
  pixels: Int32Array
}

/**
 * Шаг истории. Одна лента на всё: пользователь ждёт, что Ctrl+Z отменит
 * последнее сделанное, будь то мазок ластиком или сдвинутый ползунок.
 */
type Step =
  | { kind: 'settings'; before: Settings; after: Settings; keys: string }
  | { kind: 'edit'; assetId: string; edit: Edit }

/** Пауза, внутри которой правки одного ползунка считаются одним шагом. */
const COALESCE_MS = 700

interface Result {
  url: string
  stats: Stats
  ms: number
  blob: Blob
  key: string
}

interface StoredState {
  selected: string | null
  eraseTolerance: number
  eraseFeather: number
  panels: Record<string, boolean>
}

const TOOL_TITLES: Record<ToolId, string> = {
  hand: 'Рука',
  pick: 'Пипетка',
  erase: 'Палочка',
  lasso: 'Лассо',
}

const GALLERY_STEP = 24
const RESULT_CACHE = 120
const IMAGE_TYPES = /\.(png|webp|gif|bmp)$/i

const readState = () => loadJson<StoredState>('state')

async function decode(file: File) {
  const bitmap = await createImageBitmap(file)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  bitmap.close()
  return { data: image.data, width: image.width, height: image.height }
}

async function toBlob(data: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  const pixels = new Uint8ClampedArray(data.buffer as ArrayBuffer)
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

/** Достаёт файлы из перетащенной папки, спускаясь по всем подпапкам. */
async function walkEntry(entry: FileSystemEntry, prefix = ''): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    )
    if (!IMAGE_TYPES.test(file.name)) return []
    Object.defineProperty(file, 'relPath', { value: prefix + file.name })
    return [file]
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const entries: FileSystemEntry[] = []
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (!batch.length) break
    entries.push(...batch)
  }
  const nested = await Promise.all(entries.map((e) => walkEntry(e, `${prefix}${entry.name}/`)))
  return nested.flat()
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => ({
    ...defaultSettings,
    ...(loadJson<Partial<Settings>>('settings') ?? {}),
  }))
  const [assets, setAssets] = useState<Asset[]>([])
  const [results, setResults] = useState<Map<string, Result>>(new Map())
  const [edits, setEdits] = useState<Map<string, Edit[]>>(new Map())
  const [history, setHistory] = useState<Step[]>([])
  const [future, setFuture] = useState<Step[]>([])
  const lastStepAt = useRef(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [limit, setLimit] = useState(GALLERY_STEP)
  const [busy, setBusy] = useState(0)
  const [note, setNote] = useState('перетащи картинку или папку')
  const [dragging, setDragging] = useState(false)
  const [tool, setTool] = useState<ToolId>('hand')
  const [showOriginal, setShowOriginal] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [restored, setRestored] = useState(false)
  const [eraseTolerance, setEraseTolerance] = useState(() => readState()?.eraseTolerance ?? 14)
  const [eraseFeather, setEraseFeather] = useState(() => readState()?.eraseFeather ?? 2)
  const [panels, setPanels] = useState<Record<string, boolean>>(
    () => readState()?.panels ?? { files: true },
  )
  const [pool] = useState(() => new WorkerPool())
  const [generation, setGeneration] = useState(0)

  const current = assets.find((a) => a.id === selected) ?? null
  const currentResult = current ? results.get(current.id) : null
  const settingsKey = JSON.stringify(settings)

  const applyEdits = useCallback(
    (image: { data: Uint8ClampedArray; width: number; height: number }, id: string) => {
      const list = edits.get(id)
      if (!list?.length) return image
      // Правки накатываются по порядку: восстановление снимает пометку,
      // поставленную более ранним стиранием.
      const hidden = new Uint8Array(image.width * image.height)
      for (const edit of list) {
        const value = edit.type === 'erase' ? 1 : 0
        for (const i of edit.pixels) hidden[i] = value
      }
      const data = image.data.slice()
      for (let i = 0; i < hidden.length; i++) if (hidden[i]) data[i * 4 + 3] = 0
      return { data, width: image.width, height: image.height }
    },
    [edits],
  )

  // ---------- обработка ----------

  useEffect(() => {
    if (!assets.length) return
    const run = generation + 1
    setGeneration(run)
    let alive = true
    const timer = setTimeout(async () => {
      const targets = assets.slice(0, limit)
      setBusy(targets.length)
      for (const asset of targets) {
        if (!alive) return
        try {
          const source = applyEdits(await decode(asset.file), asset.id)
          const result = await pool.run(source, settings)
          if (!alive) return
          const blob = await toBlob(result.data, result.width, result.height)
          setResults((prev) => {
            const next = new Map(prev)
            const previous = next.get(asset.id)
            if (previous) URL.revokeObjectURL(previous.url)
            next.set(asset.id, {
              url: URL.createObjectURL(blob),
              stats: result.stats,
              ms: result.ms,
              blob,
              key: settingsKey,
            })
            while (next.size > RESULT_CACHE) {
              const oldest = next.keys().next().value as string
              const dropped = next.get(oldest)
              if (dropped) URL.revokeObjectURL(dropped.url)
              next.delete(oldest)
            }
            return next
          })
        } catch {
          setNote(`не открылся файл ${asset.name}`)
        }
        setBusy((n) => n - 1)
      }
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // generation меняем сами внутри, в зависимостях он не нужен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, assets, limit, pool, applyEdits])

  // ---------- сессия ----------

  useEffect(() => {
    let alive = true
    Promise.all([loadAssets(), loadEdits()]).then(([stored, savedEdits]) => {
      if (!alive) return
      if (stored.length) {
        const loaded: Asset[] = stored.map((row) => ({
          id: row.id,
          name: row.name,
          path: row.path,
          file: new File([row.blob], row.name, { type: row.blob.type || 'image/png' }),
          originalUrl: URL.createObjectURL(row.blob),
        }))
        setAssets(loaded)
        setEdits(new Map(savedEdits))
        const wanted = readState()?.selected
        setSelected(loaded.some((a) => a.id === wanted) ? wanted! : loaded[0].id)
        setNote(`сессия восстановлена: ${loaded.length} файлов`)
      }
      setRestored(true)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    saveJson('settings', settings)
  }, [settingsKey, settings])

  useEffect(() => {
    saveJson('state', { selected, eraseTolerance, eraseFeather, panels })
  }, [selected, eraseTolerance, eraseFeather, panels])

  useEffect(() => {
    if (!restored) return
    const timer = setTimeout(() => {
      saveEdits(edits).catch(() => setNote('правки не сохранились в браузере'))
    }, 600)
    return () => clearTimeout(timer)
  }, [edits, restored])

  // ---------- файлы ----------

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    const images = files.filter((f) => IMAGE_TYPES.test(f.name))
    if (!images.length) {
      setNote('картинок не нашлось: нужны png, webp, gif или bmp')
      return
    }
    const loaded: Asset[] = images.map((file, index) => ({
      id: `${file.name}-${index}`,
      name: file.name,
      path: (file as File & { relPath?: string }).relPath ?? file.name,
      file,
      originalUrl: URL.createObjectURL(file),
    }))
    setAssets((previous) => {
      for (const asset of previous) URL.revokeObjectURL(asset.originalUrl)
      return loaded
    })
    setResults((previous) => {
      for (const result of previous.values()) URL.revokeObjectURL(result.url)
      return new Map()
    })
    setEdits(new Map())
    setSelected(loaded[0]?.id ?? null)
    setLimit(GALLERY_STEP)
    setNote(`загружено: ${loaded.length}`)
    const saved = await saveAssets(
      loaded.map((a) => ({ id: a.id, name: a.name, path: a.path, blob: a.file })),
    )
    if (!saved) setNote(`загружено: ${loaded.length} — пачка велика, сессия не сохранится`)
  }, [])

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const items = Array.from(event.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean) as FileSystemEntry[]
      if (items.length) {
        const nested = await Promise.all(items.map((entry) => walkEntry(entry)))
        await addFiles(nested.flat())
        return
      }
      await addFiles(Array.from(event.dataTransfer.files))
    },
    [addFiles],
  )

  const downloadZip = useCallback(async () => {
    const zip = new JSZip()
    setNote('собираю архив…')
    for (const asset of assets) {
      const cached = results.get(asset.id)
      const blob = cached
        ? cached.blob
        : await decode(asset.file)
            .then((source) => pool.run(applyEdits(source, asset.id), settings))
            .then((r) => toBlob(r.data, r.width, r.height))
      zip.file(asset.path.replace(/\.[^.]+$/, '') + '.png', blob)
    }
    const archive = await zip.generateAsync({ type: 'blob' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(archive)
    link.download = 'pixel-fix.zip'
    link.click()
    setNote(`архив собран: ${assets.length} файлов`)
  }, [assets, results, pool, settings, applyEdits])

  // ---------- инструменты ----------

  const pushEdit = useCallback((id: string, edit: Edit) => {
    setEdits((prev) => {
      const next = new Map(prev)
      next.set(id, [...(next.get(id) ?? []), edit])
      return next
    })
    setHistory((prev) => [...prev, { kind: 'edit', assetId: id, edit }])
    setFuture([])
    lastStepAt.current = 0
  }, [])

  /**
   * Меняет настройки и кладёт шаг в историю. Движение одного ползунка
   * рождает десятки изменений — подряд идущие правки тех же ключей
   * склеиваются в один шаг, иначе Ctrl+Z пришлось бы жать сто раз.
   */
  const applySettings = useCallback(
    (update: Partial<Settings> | ((current: Settings) => Settings)) => {
      setSettings((current) => {
        const next =
          typeof update === 'function' ? update(current) : { ...current, ...update }
        const keys = (Object.keys(next) as Array<keyof Settings>)
          .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]))
          .join(',')
        if (!keys) return current

        const now = performance.now()
        const fresh = now - lastStepAt.current < COALESCE_MS
        lastStepAt.current = now
        setHistory((prev) => {
          const last = prev[prev.length - 1]
          if (fresh && last?.kind === 'settings' && last.keys === keys) {
            return [...prev.slice(0, -1), { ...last, after: next }]
          }
          return [...prev, { kind: 'settings', before: current, after: next, keys }]
        })
        setFuture([])
        return next
      })
    },
    [],
  )

  const onCanvasPick = useCallback(
    async (x: number, y: number) => {
      if (!current) return
      const pixels = applyEdits(await decode(current.file), current.id)
      const index = (y * pixels.width + x) * 4

      if (tool === 'pick') {
        if (pixels.data[index + 3] === 0) {
          setNote('в этой точке пусто — ткни в саму обводку')
          return
        }
        const color: [number, number, number] = [
          pixels.data[index],
          pixels.data[index + 1],
          pixels.data[index + 2],
        ]
        applySettings({ outlineColor: color })
        setTool('hand')
        setNote(`цвет обводки: rgb(${color.join(', ')})`)
        return
      }

      const stroke = magicSelect(
        pixels.data, pixels.width, pixels.height, x, y, eraseTolerance, eraseFeather,
      )
      if (!stroke.length) {
        setNote('в этой точке уже пусто')
        return
      }
      pushEdit(current.id, { type: 'erase', pixels: stroke })
      let visible = 0
      for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] > 128) visible++
      const share = visible ? (stroke.length / visible) * 100 : 0
      setNote(
        share > 15
          ? `стёрто ${stroke.length} px — это ${share.toFixed(0)}% картинки, проверь и отмени при промахе`
          : `стёрто ${stroke.length} px (${share.toFixed(1)}%)`,
      )
    },
    [current, tool, eraseTolerance, eraseFeather, applyEdits, pushEdit, applySettings],
  )

  const onCanvasLasso = useCallback(
    async (points: Array<[number, number]>) => {
      if (!current) return
      const pixels = await decode(current.file)
      const area = fillPolygon(points, pixels.width, pixels.height)
      if (!area.length) {
        setNote('контур пустой — обведи область целиком')
        return
      }
      pushEdit(current.id, { type: 'restore', pixels: area })
      setNote(`возвращено ${area.length} px оригинала`)
    },
    [current, pushEdit],
  )

  const dropBackgroundEverywhere = useCallback(async () => {
    // Настройки общие для всей пачки, а правки — свои у каждой картинки.
    // Поэтому «ко всем» это не режим, а прогон одного и того же действия
    // по каждому файлу со своими цветами фона.
    if (!assets.length) return
    setNote(`убираю фон: 0 из ${assets.length}`)
    let done = 0
    let touched = 0
    for (const asset of assets) {
      try {
        const pixels = applyEdits(await decode(asset.file), asset.id)
        const stroke = removeBackground(
          pixels.data, pixels.width, pixels.height, eraseTolerance, eraseFeather,
        )
        if (stroke.length) {
          pushEdit(asset.id, { type: 'erase', pixels: stroke })
          touched++
        }
      } catch {
        setNote(`не открылся файл ${asset.name}`)
      }
      done++
      if (done % 5 === 0) setNote(`убираю фон: ${done} из ${assets.length}`)
    }
    setNote(`фон убран у ${touched} из ${assets.length} картинок`)
  }, [assets, eraseTolerance, eraseFeather, applyEdits, pushEdit])

  const dropBackground = useCallback(async () => {
    if (!current) return
    const pixels = applyEdits(await decode(current.file), current.id)
    const stroke = removeBackground(
      pixels.data, pixels.width, pixels.height, eraseTolerance, eraseFeather,
    )
    if (!stroke.length) {
      setNote('фон по рамке не нашёлся — она уже прозрачная')
      return
    }
    pushEdit(current.id, { type: 'erase', pixels: stroke })
    setNote(`фон убран: ${stroke.length} px`)
  }, [current, eraseTolerance, eraseFeather, applyEdits, pushEdit])

  const dropEdit = useCallback((assetId: string) => {
    setEdits((prev) => {
      const list = prev.get(assetId)
      if (!list?.length) return prev
      const next = new Map(prev)
      const rest = list.slice(0, -1)
      if (rest.length) next.set(assetId, rest)
      else next.delete(assetId)
      return next
    })
  }, [])

  const addEdit = useCallback((assetId: string, edit: Edit) => {
    setEdits((prev) => {
      const next = new Map(prev)
      next.set(assetId, [...(next.get(assetId) ?? []), edit])
      return next
    })
  }, [])

  const undoStep = useCallback(() => {
    setHistory((prev) => {
      const step = prev[prev.length - 1]
      if (!step) return prev
      if (step.kind === 'settings') {
        setSettings(step.before)
        setNote('настройки откачены')
      } else {
        dropEdit(step.assetId)
        setNote('правка отменена')
      }
      setFuture((stack) => [...stack, step])
      lastStepAt.current = 0
      return prev.slice(0, -1)
    })
  }, [dropEdit])

  const redoStep = useCallback(() => {
    setFuture((prev) => {
      const step = prev[prev.length - 1]
      if (!step) return prev
      if (step.kind === 'settings') {
        setSettings(step.after)
        setNote('настройки возвращены')
      } else {
        addEdit(step.assetId, step.edit)
        setNote('правка возвращена')
      }
      setHistory((stack) => [...stack, step])
      lastStepAt.current = 0
      return prev.slice(0, -1)
    })
  }, [addEdit])

  // Ctrl/Cmd+Z отменяет, с Shift — возвращает. Игнорируем нажатия в полях
  // ввода, чтобы не мешать правке текста.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      // Событие может прийти от window, у которого нет closest.
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea')) return
      event.preventDefault()
      if (event.shiftKey) redoStep()
      else undoStep()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoStep, redoStep])

  const togglePanel = useCallback((id: string) => {
    setPanels((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  // Выбрал инструмент — открылись его параметры. Иначе непонятно, где
  // крутить допуск: инструмент в одном месте, его ручки в другом.
  const selectTool = useCallback((next: ToolId) => {
    setTool(next)
    // Своё окно есть только у палочки и лассо — там настраивать допуск.
    // Пипетке окно не нужно: курсор и строка подсказки говорят всё.
    if (next === 'erase' || next === 'lasso') {
      setPanels((prev) => ({ ...prev, tool: true }))
    }
  }, [])

  // ---------- разметка ----------

  const slider = (
    label: string,
    key: keyof Settings,
    min: number,
    max: number,
    step = 1,
    scale = 1,
  ) => (
    <label className="slider" key={key}>
      <span>
        {label}: <b>{Math.round((settings[key] as number) * scale)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={(settings[key] as number) * scale}
        onChange={(e) => applySettings({ [key]: Number(e.target.value) / scale })}
      />
    </label>
  )

  const toggle = (label: string, key: keyof Settings) => (
    <label className="toggle" key={key}>
      <input
        type="checkbox"
        checked={settings[key] as boolean}
        onChange={(e) => applySettings({ [key]: e.target.checked })}
      />
      {label}
    </label>
  )

  const stats = currentResult?.stats
  const overlay = !current
    ? note
    : showOriginal
      ? `оригинал · ${current.name}`
      : stats
        ? `${current.name} · полости ${stats.holes}, щели ${stats.gaps}` +
          (stats.smoothed ? `, сглажено ${stats.smoothed}` : '') +
          (stats.merged ? `, слито ${stats.merged}` : '') +
          (stats.outline ? `, обводка ${stats.outline}` : '') +
          (currentResult.key === settingsKey ? '' : ' · пересчитываю…')
        : `${current.name} · считаю…`

  // «Оригинал» показывает именно исходный файл, без правок и обработки:
  // иначе кнопка возвращала бы к промежуточному шагу, а не к тому, что было.
  const canvasSource = !current
    ? null
    : showOriginal
      ? current.originalUrl
      : (currentResult?.url ?? current.originalUrl)

  return (
    <div
      className={dragging ? 'editor dragging' : 'editor'}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="topbar">
        <strong>Pixel Fix</strong>
        <label className="button">
          Открыть
          <input
            type="file"
            multiple
            accept="image/png,image/webp,image/gif,image/bmp"
            onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        <label className="button">
          Папку
          <input
            type="file"
            multiple
            // @ts-expect-error нестандартный атрибут выбора папки
            webkitdirectory=""
            onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        <button
          className={showOriginal ? 'active' : undefined}
          onMouseDown={() => setShowOriginal(true)}
          onMouseUp={() => setShowOriginal(false)}
          onMouseLeave={() => setShowOriginal(false)}
          disabled={!current}
          title="Удерживай, чтобы увидеть оригинал"
        >
          Оригинал
        </button>
        <button onClick={undoStep} disabled={!history.length} title="Ctrl/Cmd + Z">
          Отменить
        </button>
        <button onClick={redoStep} disabled={!future.length} title="Ctrl/Cmd + Shift + Z">
          Вернуть
        </button>
        <button onClick={downloadZip} disabled={!assets.length}>
          Скачать ZIP
        </button>
        <span className="note">
          {note}
          {busy > 0 ? ` · считаю ${busy}` : ''}
        </span>
      </header>

      <div className="workspace">
        <Toolbar
          tool={tool}
          onSelect={selectTool}
          panels={panels}
          onTogglePanel={togglePanel}
          disabled={!current}
        />
        <EditorCanvas
          source={canvasSource}
          compare={current?.originalUrl ?? null}
          compareMode={compareMode}
          onToggleCompare={() => setCompareMode((on) => !on)}
          overlay={overlay}
          viewKey={current?.id ?? 'empty'}
          tool={tool}
          onPick={onCanvasPick}
          onLasso={onCanvasLasso}
        />
      </div>

      {panels.tool && (tool === 'erase' || tool === 'lasso') && (
        <FloatingPanel
          id="tool"
          title={`Инструмент: ${TOOL_TITLES[tool]}`}
          initial={{ x: 96, y: 96 }}
          onClose={() => togglePanel('tool')}
        >
          <p className="hint">{TOOL_HELP[tool]}</p>

          {(tool === 'erase' || tool === 'lasso') && (
            <>
              <label className="slider">
                <span>
                  Допуск: <b>{eraseTolerance}</b>
                </span>
                <input
                  type="range"
                  min={1}
                  max={48}
                  value={eraseTolerance}
                  onChange={(e) => setEraseTolerance(Number(e.target.value))}
                />
              </label>
              <label className="slider">
                <span>
                  Добор края: <b>{eraseFeather}</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={4}
                  value={eraseFeather}
                  onChange={(e) => setEraseFeather(Number(e.target.value))}
                />
              </label>
              <p className="hint">
                Тем же допуском работает «Убрать фон»: он заливает внутрь от
                рамки картинки, сам находя цвета фона — включая шахматку из
                двух оттенков.
              </p>
              <div className="row">
                <button onClick={dropBackground} disabled={!current}>
                  Убрать фон
                </button>
                <button
                  onClick={dropBackgroundEverywhere}
                  disabled={assets.length < 2}
                >
                  У всех ({assets.length})
                </button>
              </div>
            </>
          )}

          <div className="row">
            <button onClick={undoStep} disabled={!history.length}>
              Отменить
            </button>
            <button onClick={redoStep} disabled={!future.length}>
              Вернуть
            </button>
          </div>
          <p className="hint">
            Ползунки обработки общие для всей пачки. Стирания, лассо и убранный
            фон — у каждой картинки свои.
          </p>
        </FloatingPanel>
      )}

      {panels.outline && (
        <FloatingPanel
          id="outline"
          title="Обводка"
          initial={{ x: 128, y: 128 }}
          onClose={() => togglePanel('outline')}
        >
          <div className="row">
            <span
              className="swatch"
              style={{
                background: settings.outlineColor
                  ? `rgb(${settings.outlineColor.join(',')})`
                  : 'repeating-linear-gradient(45deg,#555,#555 4px,#333 4px,#333 8px)',
              }}
              title={settings.outlineColor ? settings.outlineColor.join(', ') : 'определяется сам'}
            />
            <button
              className={tool === 'pick' ? 'active' : undefined}
              onClick={() => selectTool(tool === 'pick' ? 'hand' : 'pick')}
              disabled={!current}
            >
              {tool === 'pick' ? 'Кликни по обводке…' : 'Пипетка'}
            </button>
            <button
              onClick={() => applySettings({ outlineColor: null })}
              disabled={!settings.outlineColor}
            >
              Авто
            </button>
          </div>
          <p className="hint">
            Рваную обводку не чинят на месте: её форма повторяет рваный силуэт.
            Сценарий снимает старую обводку, выравнивает край и рисует новую.
            Цвета внутри картинки он не трогает.
          </p>
          <button
            className="wide"
            onClick={() =>
              // Только контур: слияние оттенков и сглаживание зон трогают
              // цвет по всей картинке — на мачете это 93% внутренних
              // пикселей. Для пиксель-арта это потеря рисунка, поэтому
              // в сценарий они не входят и включаются вручную.
              applySettings((c) => ({
                ...c,
                stripOutline: 30,
                stripDepth: 4,
                smoothRadius: 3,
                despeckle: 6,
                outlineGrow: 4,
                outlineThickness: 0,
                mergeTolerance: 0,
                regionSmooth: 0,
              }))
            }
          >
            Сценарий: обводка заново
          </button>
          <p className="hint">
            Снимается то, что похоже на цвет обводки: допуск — насколько цвет
            пикселя может от него отличаться (расстояние по RGB, 0 — только
            точное совпадение). Съём идёт лишь в полосе заданной глубины от
            края, а толстые области того же цвета — тёмные штаны, волосы —
            остаются на месте.
          </p>
          {slider('Снять обводку, допуск цвета', 'stripOutline', 0, 90)}
          {slider('Глубина полосы от края, px', 'stripDepth', 1, 10)}
          {slider('Нарисовать обводку снаружи, px', 'outlineGrow', 0, 6)}
          {slider('Перекрасить кромку внутрь, px', 'outlineThickness', 0, 6)}
          <p className="hint">
            Снаружи обводки часто остаётся светлый ореол — недоеденный фон.
            Он снимается слоями с края: пиксель уходит, если он ярче порога.
            Тёмная обводка порог не проходит и останавливает съём.
          </p>
          {slider('Снять ореол, слоёв', 'haloStrip', 0, 5)}
          {slider('Ореол — ярче чем', 'haloLevel', 100, 255)}
        </FloatingPanel>
      )}

      {panels.cleanup && (
        <FloatingPanel
          id="cleanup"
          title="Чистка и сглаживание"
          initial={{ x: 160, y: 160 }}
          onClose={() => togglePanel('cleanup')}
        >
          <p className="hint">
            Дырки в обводке и мусор по краю. Отверстия рисунка отличаются от
            артефактов толщиной, а не размером.
          </p>
          {slider('Порог альфы', 'alphaThreshold', 0, 255)}
          {slider('Отверстие — от толщины, px', 'holeThickness', 0, 6)}
          {slider('Закрытие щелей', 'closeRadius', 0, 4)}
          {slider('Дырка при N соседях', 'neighborMin', 0, 8)}
          {slider('Проходов по соседям', 'neighborPasses', 0, 5)}
          {slider('Убрать мусор ≤ px', 'despeckle', 0, 12)}
          {slider('Сглаживание контура', 'smoothRadius', 0, 16)}
          {slider('Проходов сглаживания', 'smoothPasses', 1, 4)}
          {slider('Мягкость края, %', 'edgeSoftness', 0, 100, 1, 100)}
          {slider('Растяжка цвета за край', 'colorBleed', 0, 8)}
          {toggle('Заливать внутренние полости', 'fillHoles')}
          {toggle('Чистить цвет края', 'defringe')}
          {toggle('Альфа только 0 или 255', 'binarizeAlpha')}
        </FloatingPanel>
      )}

      {panels.color && (
        <FloatingPanel
          id="color"
          title="Цвет"
          initial={{ x: 192, y: 192 }}
          onClose={() => togglePanel('color')}
        >
          <p className="hint">
            Эти ручки меняют цвет по всей площади картинки, а не по краю.
            На чистом пиксель-арте они съедают градиенты — включай осознанно.
          </p>
          {slider('Слить похожие цвета', 'mergeTolerance', 0, 60)}
          {slider('Палитра, цветов', 'paletteColors', 0, 64)}
          {slider('Сглаживание цвета', 'regionSmooth', 0, 4)}
          {slider('Проходов по цвету', 'regionPasses', 1, 4)}
          {slider('Беречь тонкие линии, %', 'regionKeep', 0, 90, 1, 100)}
        </FloatingPanel>
      )}

      {panels.pixelize && (
        <FloatingPanel
          id="pixelize"
          title="Пикселизация"
          initial={{ x: 224, y: 224 }}
          onClose={() => togglePanel('pixelize')}
        >
          <p className="hint">
            Сводит картинку к сетке арт-пикселей. «Резкая» выбирает цвет блока
            голосованием — так тонкая обводка выживает, но градиенты станут
            ступенчатыми.
          </p>
          {slider('Размер пикселя', 'pixelBlock', 0, 32)}
          {slider('Палитра пикселизации', 'pixelColors', 2, 64)}
          {toggle('Резкая (по цвету блока)', 'pixelDominant')}
          {toggle('Вернуть исходный размер', 'pixelUpscale')}
        </FloatingPanel>
      )}

      {panels.files && (
        <FloatingPanel
          id="files"
          title={`Файлы (${assets.length})`}
          initial={{ x: Math.max(96, window.innerWidth - 300), y: 96 }}
          onClose={() => togglePanel('files')}
        >
          {!assets.length && <p className="hint">Перетащи картинки или папку в окно.</p>}
          <div className="file-list">
            {assets.slice(0, limit).map((asset) => {
              const done = results.get(asset.id)
              return (
                <button
                  key={asset.id}
                  className={asset.id === selected ? 'file active' : 'file'}
                  onClick={() => setSelected(asset.id)}
                >
                  <img className="thumb" src={done?.url ?? asset.originalUrl} alt="" />
                  <span>{asset.name}</span>
                </button>
              )
            })}
          </div>
          {limit < assets.length && (
            <button className="wide" onClick={() => setLimit((n) => n + GALLERY_STEP)}>
              Показать ещё ({assets.length - limit})
            </button>
          )}
          <div className="row">
            <button onClick={() => applySettings(() => defaultSettings)}>Сбросить настройки</button>
            <button
              onClick={async () => {
                await clearSession()
                setNote('сессия забыта')
              }}
            >
              Забыть сессию
            </button>
          </div>
        </FloatingPanel>
      )}

      {!assets.length && (
        <div className="dropzone">
          <p>Перетащи картинку или папку</p>
          <p className="hint">png, webp, gif, bmp · всё считается в браузере</p>
        </div>
      )}
    </div>
  )
}
