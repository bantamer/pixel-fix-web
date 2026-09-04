import { useCallback, useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { defaultSettings, type Settings, type Stats } from './lib/pixelfix'
import { CompareViewer, type Frame } from './CompareViewer'
import { WorkerPool } from './pool'
import './App.css'

interface Asset {
  id: string
  name: string
  path: string
  width: number
  height: number
  data: Uint8ClampedArray
  beforeUrl: string
}

interface Result {
  url: string
  stats: Stats
  ms: number
  blob: Blob
  frame: Frame
  key: string
}

const GALLERY_STEP = 24
const IMAGE_TYPES = /\.(png|webp|gif|bmp)$/i

async function decode(file: File): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
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
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [assets, setAssets] = useState<Asset[]>([])
  const [results, setResults] = useState<Map<string, Result>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [limit, setLimit] = useState(GALLERY_STEP)
  const [busy, setBusy] = useState(0)
  const [note, setNote] = useState('перетащи сюда ассеты или папку')
  const [dragging, setDragging] = useState(false)

  // Пул живёт всю сессию страницы. В StrictMode эффект с cleanup убил бы
  // воркеры на повторном монтировании, поэтому держим его в ref.
  const poolRef = useRef<WorkerPool | null>(null)
  if (!poolRef.current) poolRef.current = new WorkerPool()
  const pool = poolRef.current

  const generation = useRef(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const visible = assets.slice(0, limit)

  const settingsKey = JSON.stringify(settings)

  // Настройки изменились — пересчитываем видимые. Старые результаты держим
  // на экране до готовности новых, иначе картинка справа мигает пустотой.
  useEffect(() => {
    if (!assets.length) return
    const run = ++generation.current
    const timer = setTimeout(async () => {
      const targets = assets.slice(0, limit)
      setBusy(targets.length)
      for (const asset of targets) {
        if (generation.current !== run) return
        const result = await pool.run(asset, settingsRef.current)
        if (generation.current !== run) return
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
            frame: { data: result.data, width: result.width, height: result.height },
            key: settingsKey,
          })
          return next
        })
        setBusy((n) => n - 1)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [settingsKey, settings, assets, limit, pool])

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => IMAGE_TYPES.test(f.name))
    if (!images.length) {
      setNote('картинок не нашлось: нужны png, webp, gif или bmp')
      return
    }
    setNote(`читаю ${images.length}…`)
    const loaded: Asset[] = []
    for (const file of images) {
      try {
        const decoded = await decode(file)
        const blob = await toBlob(decoded.data, decoded.width, decoded.height)
        loaded.push({
          id: `${file.name}-${loaded.length}`,
          name: file.name,
          path: (file as File & { relPath?: string }).relPath ?? file.name,
          ...decoded,
          beforeUrl: URL.createObjectURL(blob),
        })
      } catch {
        setNote(`не открылся файл ${file.name}`)
      }
    }
    setAssets((previous) => {
      for (const asset of previous) URL.revokeObjectURL(asset.beforeUrl)
      return loaded
    })
    setResults((previous) => {
      for (const result of previous.values()) URL.revokeObjectURL(result.url)
      return new Map()
    })
    setSelected(loaded[0]?.id ?? null)
    setLimit(GALLERY_STEP)
    setNote(`загружено: ${loaded.length}`)
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
    setNote('считаю всё для архива…')
    for (const asset of assets) {
      const cached = results.get(asset.id)
      const blob = cached
        ? cached.blob
        : await pool
            .run(asset, settingsRef.current)
            .then((r) => toBlob(r.data, r.width, r.height))
      zip.file(asset.path.replace(/\.[^.]+$/, '') + '.png', blob)
    }
    const archive = await zip.generateAsync({ type: 'blob' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(archive)
    link.download = 'pixel-fix.zip'
    link.click()
    setNote(`архив собран: ${assets.length} файлов`)
  }, [assets, results, pool])

  const current = assets.find((a) => a.id === selected) ?? null
  const currentResult = current ? results.get(current.id) : null

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
        onChange={(e) =>
          setSettings({ ...settings, [key]: Number(e.target.value) / scale })
        }
      />
    </label>
  )

  const toggle = (label: string, key: keyof Settings) => (
    <label className="toggle" key={key}>
      <input
        type="checkbox"
        checked={settings[key] as boolean}
        onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
      />
      {label}
    </label>
  )

  return (
    <div className="app">
      <aside className="panel">
        <h1>Pixel Fix</h1>
        <p className="hint">
          Всё считается прямо в браузере — файлы никуда не загружаются.
        </p>

        <h2>Пикселизация</h2>
        {slider('Размер пикселя', 'pixelBlock', 0, 32)}
        {slider('Палитра пикселизации', 'pixelColors', 2, 64)}
        {toggle('Резкая (по цвету блока)', 'pixelDominant')}
        {toggle('Вернуть исходный размер', 'pixelUpscale')}

        <h2>Чистка обводки</h2>
        {slider('Порог альфы', 'alphaThreshold', 0, 255)}
        {slider('Закрытие щелей', 'closeRadius', 0, 4)}
        {slider('Дырка при N соседях', 'neighborMin', 0, 8)}
        {slider('Проходов по соседям', 'neighborPasses', 0, 5)}
        {slider('Убрать мусор ≤ px', 'despeckle', 0, 12)}

        <h2>Сглаживание контура</h2>
        {slider('Радиус', 'smoothRadius', 0, 16)}
        {slider('Проходов', 'smoothPasses', 1, 4)}
        {slider('Мягкость края, %', 'edgeSoftness', 0, 100, 1, 100)}
        {slider('Растяжка цвета за край', 'colorBleed', 0, 8)}

        <h2>Цвет</h2>
        {slider('Палитра, цветов', 'paletteColors', 0, 64)}
        {slider('Сглаживание цвета', 'regionSmooth', 0, 4)}
        {slider('Проходов по цвету', 'regionPasses', 1, 4)}
        {slider('Беречь тонкие линии, %', 'regionKeep', 0, 90, 1, 100)}

        <h2>Прочее</h2>
        {toggle('Заливать внутренние полости', 'fillHoles')}
        {toggle('Чистить цвет края', 'defringe')}
        {toggle('Альфа только 0 или 255', 'binarizeAlpha')}

        <button className="ghost" onClick={() => setSettings(defaultSettings)}>
          Сбросить настройки
        </button>
      </aside>

      <main
        className={dragging ? 'work dragging' : 'work'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <header>
          <label className="button">
            Файлы…
            <input
              type="file"
              multiple
              accept="image/png,image/webp,image/gif,image/bmp"
              onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          <label className="button">
            Папка…
            <input
              type="file"
              multiple
              // @ts-expect-error нестандартный атрибут выбора папки
              webkitdirectory=""
              onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          <button disabled={!assets.length} onClick={downloadZip}>
            Скачать ZIP
          </button>
          <span className="note">
            {note}
            {busy > 0 ? ` · считаю ${busy}` : ''}
          </span>
        </header>

        {current && (
          <CompareViewer
            before={current}
            after={currentResult?.frame ?? null}
            captionBefore={`до · ${current.name} · ${current.width}×${current.height}`}
            captionAfter={
              currentResult
                ? `после · полости ${currentResult.stats.holes}, щели ${currentResult.stats.gaps}, ` +
                  `сглажено ${currentResult.stats.smoothed}, цвет ${currentResult.stats.recolored}` +
                  (currentResult.stats.grid ? `, сетка ${currentResult.stats.grid}` : '') +
                  ` · ${currentResult.ms} мс` +
                  (currentResult.key === settingsKey ? '' : ' · пересчитываю…')
                : 'после · считаю…'
            }
          />
        )}

        {assets.length > 1 && (
          <section className="gallery">
            {visible.map((asset) => {
              const result = results.get(asset.id)
              return (
                <button
                  key={asset.id}
                  className={asset.id === selected ? 'card active' : 'card'}
                  onClick={() => setSelected(asset.id)}
                >
                  <div className="pair">
                    <img className="checker" src={asset.beforeUrl} alt="" />
                    {result ? (
                      <img className="checker" src={result.url} alt="" />
                    ) : (
                      <div className="checker placeholder" />
                    )}
                  </div>
                  <span>{asset.name}</span>
                </button>
              )
            })}
            {limit < assets.length && (
              <button
                className="more"
                onClick={() => setLimit((n) => n + GALLERY_STEP)}
              >
                Показать ещё ({assets.length - limit})
              </button>
            )}
          </section>
        )}

        {!assets.length && (
          <div className="dropzone">
            <p>Перетащи сюда ассеты или целую папку</p>
            <p className="hint">png, webp, gif, bmp · обрабатывается локально</p>
          </div>
        )}
      </main>
    </div>
  )
}
