/**
 * Чистка спрайтов в браузере: заделка дырок в обводке, сглаживание контура,
 * пикселизация. Порт питоновского ядра на типизированные массивы.
 *
 * Изображение везде — RGBA в Uint8ClampedArray плюс ширина и высота.
 */

export interface Settings {
  pixelBlock: number
  pixelUpscale: boolean
  pixelDominant: boolean
  pixelColors: number
  alphaThreshold: number
  fillHoles: boolean
  holeThickness: number
  closeRadius: number
  neighborMin: number
  neighborPasses: number
  despeckle: number
  defringe: boolean
  binarizeAlpha: boolean
  smoothRadius: number
  smoothPasses: number
  edgeSoftness: number
  colorBleed: number
  paletteColors: number
  regionSmooth: number
  regionPasses: number
  regionKeep: number
  mergeTolerance: number
  haloStrip: number
  haloLevel: number
  outlineThickness: number
  stripOutline: number
  stripDepth: number
  outlineGrow: number
  outlineColor: [number, number, number] | null
}

export const defaultSettings: Settings = {
  pixelBlock: 0,
  pixelUpscale: true,
  pixelDominant: false,
  pixelColors: 32,
  alphaThreshold: 128,
  fillHoles: true,
  holeThickness: 2,
  closeRadius: 1,
  neighborMin: 5,
  neighborPasses: 2,
  despeckle: 2,
  defringe: true,
  binarizeAlpha: false,
  smoothRadius: 0,
  smoothPasses: 2,
  edgeSoftness: 0,
  colorBleed: 2,
  paletteColors: 0,
  regionSmooth: 0,
  regionPasses: 1,
  regionKeep: 0.35,
  mergeTolerance: 0,
  haloStrip: 0,
  haloLevel: 200,
  outlineThickness: 0,
  stripOutline: 0,
  stripDepth: 3,
  outlineGrow: 0,
  outlineColor: null,
}

export interface Bitmap {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface Stats {
  stripped: number
  holes: number
  gaps: number
  specks: number
  fringe: number
  smoothed: number
  recolored: number
  grid: number
  merged: number
  halo: number
  outline: number
}

const NEIGHBORS: Array<[number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
]

/** Сдвиг булевой маски с нулями по краям. */
function shift(mask: Uint8Array, w: number, h: number, dy: number, dx: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const y0 = Math.max(dy, 0)
  const y1 = h + Math.min(dy, 0)
  const x0 = Math.max(dx, 0)
  const x1 = w + Math.min(dx, 0)
  for (let y = y0; y < y1; y++) {
    const src = (y - dy) * w
    const dst = y * w
    for (let x = x0; x < x1; x++) out[dst + x] = mask[src + x - dx]
  }
  return out
}

function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let current = mask
  for (let r = 0; r < radius; r++) {
    const acc = current.slice()
    for (const [dy, dx] of NEIGHBORS) {
      const moved = shift(current, w, h, dy, dx)
      for (let i = 0; i < acc.length; i++) acc[i] |= moved[i]
    }
    current = acc
  }
  return current
}

function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1
  return out
}

function erode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return invert(dilate(invert(mask), w, h, radius))
}

function neighborCount(mask: Uint8Array, w: number, h: number): Uint8Array {
  const acc = new Uint8Array(w * h)
  for (const [dy, dx] of NEIGHBORS) {
    const moved = shift(mask, w, h, dy, dx)
    for (let i = 0; i < acc.length; i++) acc[i] += moved[i]
  }
  return acc
}

/**
 * Усреднение по квадратному окну через интегральное изображение.
 * Края продлеваются, иначе силуэт у рамки картинки подъедается.
 */
export function boxBlur(field: Float64Array, w: number, h: number, radius: number): Float64Array {
  if (radius <= 0) return field
  const pw = w + 2 * radius
  const ph = h + 2 * radius
  const integral = new Float64Array((pw + 1) * (ph + 1))
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(Math.max(y - radius, 0), h - 1)
    let rowSum = 0
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(Math.max(x - radius, 0), w - 1)
      rowSum += field[sy * w + sx]
      integral[(y + 1) * (pw + 1) + x + 1] = integral[y * (pw + 1) + x + 1] + rowSum
    }
  }
  const k = 2 * radius + 1
  const area = k * k
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = integral[(y + k) * (pw + 1) + x + k]
      const b = integral[y * (pw + 1) + x + k]
      const c = integral[(y + k) * (pw + 1) + x]
      const d = integral[y * (pw + 1) + x]
      out[y * w + x] = (a - b - c + d) / area
    }
  }
  return out
}

/** Заливка от рамки: всё недостижимое — замкнутая внутренняя полость. */
function floodFromBorder(passable: Uint8Array, w: number, h: number): Uint8Array {
  const reached = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (i: number) => {
    if (passable[i] && !reached[i]) {
      reached[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (stack.length) {
    const i = stack.pop()!
    const y = (i / w) | 0
    const x = i % w
    for (const [dy, dx] of NEIGHBORS) {
      const ny = y + dy
      const nx = x + dx
      if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue
      push(ny * w + nx)
    }
  }
  return reached
}

/** Разметка 8-связных компонент за один проход с union-find. */
function connectedComponents(mask: Uint8Array, w: number, h: number): Int32Array {
  const labels = new Int32Array(w * h)
  const parent: number[] = [0]
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const back: Array<[number, number]> = [[-1, -1], [-1, 0], [-1, 1], [0, -1]]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i]) continue
      let base = 0
      const seen: number[] = []
      for (const [dy, dx] of back) {
        const ny = y + dy
        const nx = x + dx
        if (ny < 0 || nx < 0 || nx >= w) continue
        const label = labels[ny * w + nx]
        if (label) seen.push(label)
      }
      if (!seen.length) {
        parent.push(parent.length)
        labels[i] = parent.length - 1
      } else {
        base = Math.min(...seen)
        labels[i] = base
        for (const other of seen) union(base, other)
      }
    }
  }
  const lookup = new Int32Array(parent.length)
  for (let i = 0; i < parent.length; i++) lookup[i] = find(i)
  const out = new Int32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = lookup[labels[i]]
  return out
}

/**
 * Красит пиксели target цветом-модой известных соседей, расходясь волной.
 * Мода, а не среднее: новых промежуточных оттенков не появляется.
 */
function fillColors(
  rgb: Int16Array,
  known: Uint8Array,
  target: Uint8Array,
  w: number,
  h: number,
): void {
  const filled = known.slice()
  const todo = new Uint8Array(w * h)
  let remaining = 0
  for (let i = 0; i < todo.length; i++) {
    if (target[i] && !known[i]) {
      todo[i] = 1
      remaining++
    }
  }
  while (remaining > 0) {
    const active: number[] = []
    const picked: number[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!todo[i]) continue
        const cand: number[] = []
        for (const [dy, dx] of NEIGHBORS) {
          // Знак минус повторяет порядок соседей питоновского ядра, чтобы при
          // равном числе голосов веб и десктоп выбирали один и тот же цвет.
          const ny = y - dy
          const nx = x - dx
          if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue
          const j = ny * w + nx
          if (filled[j]) cand.push(j)
        }
        if (!cand.length) continue
        // Голосование: побеждает цвет, повторённый большинством соседей.
        let bestVotes = -1
        let bestSource = cand[0]
        for (const a of cand) {
          let votes = 0
          for (const b of cand) {
            if (
              rgb[a * 3] === rgb[b * 3] &&
              rgb[a * 3 + 1] === rgb[b * 3 + 1] &&
              rgb[a * 3 + 2] === rgb[b * 3 + 2]
            ) votes++
          }
          if (votes > bestVotes) {
            bestVotes = votes
            bestSource = a
          }
        }
        active.push(i)
        picked.push(bestSource)
      }
    }
    if (!active.length) return // остаток недостижим
    for (let k = 0; k < active.length; k++) {
      const i = active[k]
      const src = picked[k]
      rgb[i * 3] = rgb[src * 3]
      rgb[i * 3 + 1] = rgb[src * 3 + 1]
      rgb[i * 3 + 2] = rgb[src * 3 + 2]
      filled[i] = 1
      todo[i] = 0
      remaining--
    }
  }
}

/**
 * Палитра из N оттенков по видимой части спрайта — медианное сечение.
 * Бокс с наибольшим разбросом канала делится по медиане, пока не наберётся
 * нужное число боксов; цвет бокса — среднее его пикселей.
 */
export function buildPalette(
  rgb: Int16Array,
  mask: Uint8Array,
  colors: number,
): Int16Array {
  const pixels: number[] = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) pixels.push(i)
  if (!pixels.length) return new Int16Array(0)

  // Больше 60k образцов палитре ничего не добавляют, а делят её долго.
  const step = Math.max(1, Math.floor(pixels.length / 60000))
  const sample: number[] = []
  for (let i = 0; i < pixels.length; i += step) sample.push(pixels[i])

  let boxes: number[][] = [sample]
  while (boxes.length < colors) {
    let target = -1
    let bestSpread = -1
    let bestChannel = 0
    boxes.forEach((box, index) => {
      if (box.length < 2) return
      for (let c = 0; c < 3; c++) {
        let lo = 255
        let hi = 0
        for (const i of box) {
          const v = rgb[i * 3 + c]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        const spread = hi - lo
        if (spread > bestSpread) {
          bestSpread = spread
          target = index
          bestChannel = c
        }
      }
    })
    if (target < 0 || bestSpread <= 0) break
    const box = boxes[target]
    box.sort((a, b) => rgb[a * 3 + bestChannel] - rgb[b * 3 + bestChannel])
    const half = box.length >> 1
    boxes = boxes.filter((_, index) => index !== target)
    boxes.push(box.slice(0, half), box.slice(half))
  }

  const palette = new Int16Array(boxes.length * 3)
  boxes.forEach((box, index) => {
    let r = 0
    let g = 0
    let b = 0
    for (const i of box) {
      r += rgb[i * 3]
      g += rgb[i * 3 + 1]
      b += rgb[i * 3 + 2]
    }
    palette[index * 3] = Math.round(r / box.length)
    palette[index * 3 + 1] = Math.round(g / box.length)
    palette[index * 3 + 2] = Math.round(b / box.length)
  })
  return palette
}

/** Индекс ближайшего цвета палитры для каждого пикселя. */
export function mapToPalette(rgb: Int16Array, palette: Int16Array): Int32Array {
  const count = palette.length / 3
  const total = rgb.length / 3
  const out = new Int32Array(total)
  for (let i = 0; i < total; i++) {
    let best = 0
    let bestDist = Infinity
    for (let p = 0; p < count; p++) {
      const dr = rgb[i * 3] - palette[p * 3]
      const dg = rgb[i * 3 + 1] - palette[p * 3 + 1]
      const db = rgb[i * 3 + 2] - palette[p * 3 + 2]
      const dist = dr * dr + dg * dg + db * db
      if (dist < bestDist) {
        bestDist = dist
        best = p
      }
    }
    out[i] = best
  }
  return out
}

/**
 * Сглаживает границы цветовых зон мягким голосованием.
 *
 * keep защищает тонкие структуры: пиксель меняет цвет, только если его
 * оттенок слабее победителя в (1 - keep) раз. Без этого обводка в два
 * пикселя всегда проигрывала бы заливке тела и растворялась.
 */
function smoothRegions(
  index: Int32Array,
  count: number,
  mask: Uint8Array,
  w: number,
  h: number,
  radius: number,
  passes: number,
  keep: number,
): Int32Array {
  const ratio = 1 - Math.min(Math.max(keep, 0), 0.95)
  let current = index
  for (let pass = 0; pass < Math.max(1, passes); pass++) {
    const best = new Float64Array(w * h)
    const winner = new Int32Array(w * h)
    const own = new Float64Array(w * h)
    for (let c = 0; c < count; c++) {
      const field = new Float64Array(w * h)
      for (let i = 0; i < field.length; i++) field[i] = mask[i] && current[i] === c ? 1 : 0
      const score = boxBlur(field, w, h, radius)
      for (let i = 0; i < score.length; i++) {
        if (score[i] > best[i]) {
          best[i] = score[i]
          winner[i] = c
        }
        if (current[i] === c) own[i] = score[i]
      }
    }
    const next = current.slice()
    for (let i = 0; i < next.length; i++) {
      if (mask[i] && own[i] < best[i] * ratio) next[i] = winner[i]
    }
    current = next
  }
  return current
}

/** Подгоняет картинку под холст обрезкой или прозрачными полями по центру. */
function fitCanvas(src: Bitmap, width: number, height: number): Bitmap {
  if (src.width === width && src.height === height) return src
  const out = new Uint8ClampedArray(width * height * 4)
  const copyW = Math.min(src.width, width)
  const copyH = Math.min(src.height, height)
  const sy = (src.height - copyH) >> 1
  const sx = (src.width - copyW) >> 1
  const dy = (height - copyH) >> 1
  const dx = (width - copyW) >> 1
  for (let y = 0; y < copyH; y++) {
    const from = ((sy + y) * src.width + sx) * 4
    const to = ((dy + y) * width + dx) * 4
    out.set(src.data.subarray(from, from + copyW * 4), to)
  }
  return { data: out, width, height }
}

/** Увеличение по целому множителю ближайшим соседом. */
function upscaleNearest(src: Bitmap, factor: number): Bitmap {
  const width = src.width * factor
  const height = src.height * factor
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = (y / factor) | 0
    for (let x = 0; x < width; x++) {
      const sx = (x / factor) | 0
      const from = (sy * src.width + sx) * 4
      const to = (y * width + x) * 4
      out[to] = src.data[from]
      out[to + 1] = src.data[from + 1]
      out[to + 2] = src.data[from + 2]
      out[to + 3] = src.data[from + 3]
    }
  }
  return { data: out, width, height }
}

/**
 * Сводит картинку к сетке арт-пикселей размером block.
 *
 * Цвет усредняется по блоку с домножением на альфу, иначе прозрачные
 * пиксели подмешивают свой мусорный цвет в края. В режиме dominant цвет
 * блока выбирается голосованием по палитре: среднее размывает тонкую
 * обводку, голосование её сохраняет.
 */
export function pixelize(
  image: Bitmap,
  block: number,
  alphaThreshold: number,
  upscale: boolean,
  dominant: boolean,
  colors: number,
): { image: Bitmap; grid: number } {
  const { width: w, height: h, data } = image
  const gridW = Math.ceil(w / block)
  const gridH = Math.ceil(h / block)
  const small = new Uint8ClampedArray(gridW * gridH * 4)

  if (dominant) {
    const total = w * h
    const rgb = new Int16Array(total * 3)
    const mask = new Uint8Array(total)
    for (let i = 0; i < total; i++) {
      rgb[i * 3] = data[i * 4]
      rgb[i * 3 + 1] = data[i * 4 + 1]
      rgb[i * 3 + 2] = data[i * 4 + 2]
      mask[i] = data[i * 4 + 3] >= alphaThreshold ? 1 : 0
    }
    const palette = buildPalette(rgb, mask, Math.max(2, colors))
    const index = palette.length ? mapToPalette(rgb, palette) : new Int32Array(total)
    const paletteCount = Math.max(1, palette.length / 3)

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const votes = new Int32Array(paletteCount)
        let covered = 0
        let cells = 0
        for (let y = gy * block; y < Math.min((gy + 1) * block, h); y++) {
          for (let x = gx * block; x < Math.min((gx + 1) * block, w); x++) {
            const i = y * w + x
            cells++
            if (mask[i]) {
              covered++
              votes[index[i]]++
            }
          }
        }
        const out = (gy * gridW + gx) * 4
        // Блок остаётся в спрайте, если его закрывает больше половины пикселей.
        if (!cells || covered * 2 < block * block) {
          small[out + 3] = 0
          continue
        }
        let bestColor = 0
        for (let c = 1; c < paletteCount; c++) if (votes[c] > votes[bestColor]) bestColor = c
        small[out] = palette[bestColor * 3]
        small[out + 1] = palette[bestColor * 3 + 1]
        small[out + 2] = palette[bestColor * 3 + 2]
        small[out + 3] = 255
      }
    }
  } else {
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let y = gy * block; y < Math.min((gy + 1) * block, h); y++) {
          for (let x = gx * block; x < Math.min((gx + 1) * block, w); x++) {
            const i = (y * w + x) * 4
            const weight = data[i + 3] / 255
            r += data[i] * weight
            g += data[i + 1] * weight
            b += data[i + 2] * weight
            a += data[i + 3]
          }
        }
        const area = block * block
        const meanAlpha = a / area
        const out = (gy * gridW + gx) * 4
        if (meanAlpha < alphaThreshold) {
          small[out + 3] = 0
          continue
        }
        const weightSum = a / 255
        small[out] = Math.round(r / weightSum)
        small[out + 1] = Math.round(g / weightSum)
        small[out + 2] = Math.round(b / weightSum)
        small[out + 3] = 255
      }
    }
  }

  const smallImage: Bitmap = { data: small, width: gridW, height: gridH }
  if (!upscale) return { image: smallImage, grid: gridW }
  return { image: fitCanvas(upscaleNearest(smallImage, block), w, h), grid: gridW }
}

/**
 * Схлопывает близкие оттенки в один.
 *
 * Частые цвета становятся якорями, редкие липнут к ближайшему якорю в
 * пределах допуска. В отличие от палитры фиксированного размера, редкий, но
 * далёкий цвет (акцент, кровь на лезвии) выживает, а шум масштабирования —
 * десяток почти одинаковых серых — сливается в один оттенок.
 */
export function mergeSimilar(
  rgb: Int16Array,
  mask: Uint8Array,
  tolerance: number,
): number {
  const counts = new Map<number, number>()
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const key = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  // Стабильный порядок: по убыванию частоты, при равенстве — по значению
  // цвета. Иначе выбор якорей разъезжается с питоновской версией.
  const ordered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([key]) => key)

  const limit = tolerance * tolerance + 1
  const anchors: number[] = []
  const remap = new Map<number, number>()
  for (const key of ordered) {
    const r = (key >> 16) & 255
    const g = (key >> 8) & 255
    const b = key & 255
    let best = -1
    let bestDist = limit
    for (const anchor of anchors) {
      const dr = r - ((anchor >> 16) & 255)
      const dg = g - ((anchor >> 8) & 255)
      const db = b - (anchor & 255)
      const dist = dr * dr + dg * dg + db * db
      if (dist < bestDist) {
        bestDist = dist
        best = anchor
      }
    }
    if (best < 0) {
      anchors.push(key)
      remap.set(key, key)
    } else {
      remap.set(key, best)
    }
  }

  let changed = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const key = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]
    const target = remap.get(key)!
    if (target === key) continue
    rgb[i * 3] = (target >> 16) & 255
    rgb[i * 3 + 1] = (target >> 8) & 255
    rgb[i * 3 + 2] = target & 255
    changed++
  }
  return changed
}

/** Яркость по восприятию: обводку от заливки отличаем именно по ней. */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Цвет обводки: мода среди самых тёмных пикселей кромки.
 *
 * Берём кольцо по краю силуэта, оставляем четверть самых тёмных и выбираем
 * среди них самый частый цвет — так обводка находится сама, без настройки.
 */
export function detectOutlineColor(
  rgb: Int16Array,
  solid: Uint8Array,
  w: number,
  h: number,
): [number, number, number] | null {
  const ring = new Uint8Array(solid.length)
  const inner = erode(solid, w, h, 3)
  let count = 0
  for (let i = 0; i < solid.length; i++) {
    if (solid[i] && !inner[i]) {
      ring[i] = 1
      count++
    }
  }
  if (!count) return null

  const samples: Array<[number, number]> = []
  for (let i = 0; i < ring.length; i++) {
    if (ring[i]) samples.push([luminance(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]), i])
  }
  samples.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const dark = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.25)))

  const counts = new Map<number, number>()
  for (const [, i] of dark) {
    const key = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey = -1
  let bestCount = -1
  for (const [key, value] of counts) {
    if (value > bestCount) {
      bestCount = value
      bestKey = key
    }
  }
  if (bestKey < 0) return null
  return [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255]
}

/**
 * Снимает обводку: тонкую ленту цвета обводки вдоль кромки силуэта.
 *
 * Два ограничения делают съём безопасным. Во-первых, снимается только полоса
 * глубиной depth от края — то, что лежит внутри рисунка, не трогается.
 * Во-вторых, морфологическое открытие оставляет нетронутыми толстые области
 * того же цвета: тёмные штаны, ботинки, волосы переживают эрозию, а обводка
 * в пару пикселей — нет. Без этого у персонажа сносило половину силуэта:
 * тёмная одежда сливается с обводкой в одну область.
 */
export function stripOutlineColor(
  rgb: Int16Array,
  solid: Uint8Array,
  w: number,
  h: number,
  color: [number, number, number],
  tolerance: number,
  depth: number,
): Uint8Array {
  const total = w * h
  const limit = tolerance * tolerance
  const similar = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    if (!solid[i]) continue
    const dr = rgb[i * 3] - color[0]
    const dg = rgb[i * 3 + 1] - color[1]
    const db = rgb[i * 3 + 2] - color[2]
    if (dr * dr + dg * dg + db * db <= limit) similar[i] = 1
  }

  const reach = Math.max(1, depth)
  // Открытие: толстые области остаются, тонкая лента исчезает.
  const kept = dilate(erode(similar, w, h, reach), w, h, reach)
  // Полоса вдоль кромки: глубже неё не заходим.
  const nearEdge = dilate(invert(solid), w, h, reach)

  const doomed = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    if (similar[i] && nearEdge[i] && !kept[i]) doomed[i] = 1
  }
  return doomed
}

/** Полный пайплайн обработки одного спрайта. */
export function processImage(input: Bitmap, cfg: Settings): { image: Bitmap; stats: Stats } {
  const stats: Stats = {
    holes: 0, gaps: 0, specks: 0, fringe: 0, smoothed: 0, recolored: 0, grid: 0,
    merged: 0, halo: 0, outline: 0, stripped: 0,
  }

  let image = input
  if (cfg.pixelBlock > 1) {
    // Пикселизация идёт первой: дальше вся чистка работает уже по сетке.
    const result = pixelize(
      image, cfg.pixelBlock, cfg.alphaThreshold,
      cfg.pixelUpscale, cfg.pixelDominant, cfg.pixelColors,
    )
    image = result.image
    stats.grid = result.grid
  }

  const w = image.width
  const h = image.height
  const total = w * h
  const rgb = new Int16Array(total * 3)
  const alpha = new Int16Array(total)
  for (let i = 0; i < total; i++) {
    rgb[i * 3] = image.data[i * 4]
    rgb[i * 3 + 1] = image.data[i * 4 + 1]
    rgb[i * 3 + 2] = image.data[i * 4 + 2]
    alpha[i] = image.data[i * 4 + 3]
  }

  let solid = new Uint8Array(total)
  let anySolid = false
  for (let i = 0; i < total; i++) {
    solid[i] = alpha[i] >= cfg.alphaThreshold ? 1 : 0
    if (solid[i]) anySolid = true
  }
  if (!anySolid) return { image, stats }

  // Цвет обводки нужен и для съёма, и для рисовки — считаем один раз по
  // исходному силуэту, пока обводка ещё на месте.
  const outlineColor =
    cfg.outlineColor ??
    (cfg.stripOutline > 0 || cfg.outlineGrow > 0 || cfg.outlineThickness > 0
      ? detectOutlineColor(rgb, solid, w, h)
      : null)

  if (cfg.stripOutline > 0 && outlineColor) {
    const doomed = stripOutlineColor(
      rgb, solid, w, h, outlineColor, cfg.stripOutline, cfg.stripDepth,
    )
    for (let i = 0; i < total; i++) {
      if (doomed[i]) {
        solid[i] = 0
        alpha[i] = 0
        stats.stripped++
      }
    }
  }

  const toFill = new Uint8Array(total)

  if (cfg.fillHoles) {
    const outside = floodFromBorder(invert(solid), w, h)
    const holes = new Uint8Array(total)
    for (let i = 0; i < total; i++) holes[i] = !solid[i] && !outside[i] ? 1 : 0

    if (cfg.holeThickness > 0) {
      // Артефакт — тонкая щель вдоль обводки: она может быть длинной, но
      // никогда не бывает толстой. Настоящее отверстие в рисунке переживает
      // эрозию, поэтому решает толщина, а не площадь: у кирки есть дырка
      // в 43 пикселя, которую любой порог по площади залил бы.
      const thick = erode(holes, w, h, cfg.holeThickness)
      if (thick.some((v) => v)) {
        const labels = connectedComponents(holes, w, h)
        const keep = new Set<number>()
        for (let i = 0; i < total; i++) if (thick[i]) keep.add(labels[i])
        for (let i = 0; i < total; i++) {
          if (holes[i] && keep.has(labels[i])) holes[i] = 0
        }
      }
    }

    for (let i = 0; i < total; i++) {
      if (holes[i]) {
        toFill[i] = 1
        stats.holes++
      }
    }
  }

  if (cfg.closeRadius > 0) {
    const union = new Uint8Array(total)
    for (let i = 0; i < total; i++) union[i] = solid[i] | toFill[i]
    const closed = erode(dilate(union, w, h, cfg.closeRadius), w, h, cfg.closeRadius)
    for (let i = 0; i < total; i++) {
      if (closed[i] && !union[i]) {
        toFill[i] = 1
        stats.gaps++
      }
    }
  }

  if (cfg.neighborMin > 0) {
    for (let pass = 0; pass < cfg.neighborPasses; pass++) {
      const current = new Uint8Array(total)
      for (let i = 0; i < total; i++) current[i] = solid[i] | toFill[i]
      const counts = neighborCount(current, w, h)
      let found = false
      for (let i = 0; i < total; i++) {
        if (!current[i] && counts[i] >= cfg.neighborMin) {
          toFill[i] = 1
          stats.gaps++
          found = true
        }
      }
      if (!found) break
    }
  }

  if (toFill.some((v) => v)) {
    fillColors(rgb, solid, toFill, w, h)
    for (let i = 0; i < total; i++) {
      if (toFill[i]) {
        alpha[i] = 255
        solid[i] = 1
      }
    }
  }

  if (cfg.despeckle > 0) {
    const labels = connectedComponents(solid, w, h)
    const sizes = new Map<number, number>()
    for (let i = 0; i < total; i++) {
      if (solid[i]) sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1)
    }
    for (let i = 0; i < total; i++) {
      if (solid[i] && (sizes.get(labels[i]) ?? 0) <= cfg.despeckle) {
        alpha[i] = 0
        solid[i] = 0
        stats.specks++
      }
    }
  }

  if (cfg.haloStrip > 0) {
    // Светлый ореол от вырезания фона лежит снаружи тёмной обводки. Снимаем
    // его слоями: тёмная обводка порог не проходит и останавливает съём.
    for (let layer = 0; layer < cfg.haloStrip; layer++) {
      const outside = invert(solid)
      const exposed = dilate(outside, w, h, 1)
      const doomed = new Uint8Array(total)
      let any = false
      for (let i = 0; i < total; i++) {
        if (!solid[i] || !exposed[i]) continue
        if (luminance(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) >= cfg.haloLevel) {
          doomed[i] = 1
          any = true
        }
      }
      if (!any) break
      for (let i = 0; i < total; i++) {
        if (doomed[i]) {
          solid[i] = 0
          alpha[i] = 0
          stats.halo++
        }
      }
    }
  }

  if (cfg.smoothRadius > 0) {
    // Доля тела в окне вокруг пикселя: порог 0.5 срезает зубцы и достраивает
    // выемки, ступенчатый контур становится плавным.
    const source = new Float64Array(total)
    for (let i = 0; i < total; i++) source[i] = solid[i]
    let field: Float64Array<ArrayBufferLike> = source
    for (let pass = 0; pass < Math.max(1, cfg.smoothPasses); pass++) {
      field = boxBlur(field as Float64Array, w, h, cfg.smoothRadius)
    }
    const soft = Math.min(Math.max(cfg.edgeSoftness, 0), 1)
    const newAlpha = new Int16Array(total)
    const newSolid = new Uint8Array(total)
    for (let i = 0; i < total; i++) {
      const value = soft <= 0
        ? (field[i] >= 0.5 ? 255 : 0)
        : Math.round(Math.min(Math.max((field[i] - 0.5) / (soft * 0.5) + 0.5, 0), 1) * 255)
      newAlpha[i] = value
      newSolid[i] = value >= cfg.alphaThreshold ? 1 : 0
      if (newSolid[i] !== solid[i]) stats.smoothed++
    }
    const grown = new Uint8Array(total)
    for (let i = 0; i < total; i++) grown[i] = newAlpha[i] > 0 && !solid[i] ? 1 : 0
    if (grown.some((v) => v)) fillColors(rgb, solid, grown, w, h)
    for (let i = 0; i < total; i++) {
      // Внутри прежнего силуэта альфу не трогаем: полупрозрачные детали
      // должны пережить сглаживание контура.
      if (!(newSolid[i] && solid[i])) alpha[i] = newAlpha[i]
      solid[i] = newSolid[i]
    }
  }

  if (cfg.mergeTolerance > 0) {
    stats.merged = mergeSimilar(rgb, solid, cfg.mergeTolerance)
  }

  if (cfg.paletteColors > 0 || cfg.regionSmooth > 0) {
    // Сглаживание зон работает по индексам палитры: у сырых цветов с
    // интерполяции почти каждый пиксель уникален и голосовать не за что.
    const colors = cfg.paletteColors > 0 ? cfg.paletteColors : 32
    const palette = buildPalette(rgb, solid, colors)
    if (palette.length) {
      let index = mapToPalette(rgb, palette)
      if (cfg.regionSmooth > 0) {
        index = smoothRegions(
          index, palette.length / 3, solid, w, h,
          cfg.regionSmooth, cfg.regionPasses, cfg.regionKeep,
        )
      }
      if (cfg.paletteColors > 0) {
        // Квантование пользователь запросил явно — красим цветом палитры.
        for (let i = 0; i < total; i++) {
          if (!solid[i]) continue
          const p = index[i] * 3
          if (rgb[i * 3] !== palette[p] || rgb[i * 3 + 1] !== palette[p + 1] ||
              rgb[i * 3 + 2] !== palette[p + 2]) stats.recolored++
          rgb[i * 3] = palette[p]
          rgb[i * 3 + 1] = palette[p + 1]
          rgb[i * 3 + 2] = palette[p + 2]
        }
      } else {
        // Палитра нужна была только для голосования. Красить её усреднёнными
        // цветами нельзя: на богатом спрайте тридцати двух оттенков не хватает
        // и фиолетовая кожа уезжает в серый. Берём фактический цвет ближайшего
        // соседа, который уже принадлежит выигравшей зоне.
        const before = mapToPalette(rgb, palette)
        const radius = Math.max(1, cfg.regionSmooth) + 1
        const source = rgb.slice()
        for (let i = 0; i < total; i++) {
          if (!solid[i] || index[i] === before[i]) continue
          const y = (i / w) | 0
          const x = i % w
          let bestDist = Infinity
          let bestIndex = -1
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy
            if (ny < 0 || ny >= h) continue
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = x + dx
              if (nx < 0 || nx >= w) continue
              const j = ny * w + nx
              if (!solid[j] || before[j] !== index[i]) continue
              const dist = dy * dy + dx * dx
              if (dist < bestDist) {
                bestDist = dist
                bestIndex = j
              }
            }
          }
          if (bestIndex < 0) continue
          rgb[i * 3] = source[bestIndex * 3]
          rgb[i * 3 + 1] = source[bestIndex * 3 + 1]
          rgb[i * 3 + 2] = source[bestIndex * 3 + 2]
          stats.recolored++
        }
      }
    }
  }

  if (cfg.outlineGrow > 0 && outlineColor) {
    // Обводка наращивается снаружи тела, поэтому спрайт не худеет от съёма
    // старой каймы, а форма берётся уже сглаженной.
    const grown = dilate(solid, w, h, cfg.outlineGrow)
    for (let i = 0; i < total; i++) {
      if (!grown[i] || solid[i]) continue
      rgb[i * 3] = outlineColor[0]
      rgb[i * 3 + 1] = outlineColor[1]
      rgb[i * 3 + 2] = outlineColor[2]
      alpha[i] = 255
      solid[i] = 1
      stats.outline++
    }
  }

  if (cfg.outlineThickness > 0) {
    // Заливка дырок красит их модой соседей, а вокруг разрыва в обводке
    // соседей-заливки больше — обводка так и остаётся дырявой. Поэтому
    // кромку просто перерисовываем найденным цветом обводки.
    const color = outlineColor
    if (color) {
      const inner = erode(solid, w, h, cfg.outlineThickness)
      for (let i = 0; i < total; i++) {
        if (!solid[i] || inner[i]) continue
        if (rgb[i * 3] === color[0] && rgb[i * 3 + 1] === color[1] && rgb[i * 3 + 2] === color[2]) {
          continue
        }
        rgb[i * 3] = color[0]
        rgb[i * 3 + 1] = color[1]
        rgb[i * 3 + 2] = color[2]
        stats.outline++
      }
    }
  }

  if (cfg.defringe) {
    // Полупрозрачный край несёт грязный цвет от масштабирования: альфу
    // сохраняем, RGB берём от тела спрайта.
    const fringe = new Uint8Array(total)
    for (let i = 0; i < total; i++) {
      if (!solid[i] && alpha[i] > 0) {
        fringe[i] = 1
        stats.fringe++
      }
    }
    if (stats.fringe) fillColors(rgb, solid, fringe, w, h)
  }

  if (cfg.binarizeAlpha) {
    for (let i = 0; i < total; i++) alpha[i] = alpha[i] >= cfg.alphaThreshold ? 255 : 0
  }

  // Цвет продлевается за контур, иначе движок при масштабировании подмешивает
  // из-под краевых пикселей чёрную кайму.
  const visible = new Uint8Array(total)
  for (let i = 0; i < total; i++) visible[i] = alpha[i] > 0 ? 1 : 0
  if (cfg.colorBleed > 0) {
    const grown = dilate(visible, w, h, cfg.colorBleed)
    const skirt = new Uint8Array(total)
    let any = false
    for (let i = 0; i < total; i++) {
      if (grown[i] && !visible[i]) {
        skirt[i] = 1
        any = true
      }
    }
    if (any) {
      fillColors(rgb, visible, skirt, w, h)
      for (let i = 0; i < total; i++) if (skirt[i]) visible[i] = 1
    }
  }

  const out = new Uint8ClampedArray(total * 4)
  for (let i = 0; i < total; i++) {
    if (visible[i]) {
      out[i * 4] = rgb[i * 3]
      out[i * 4 + 1] = rgb[i * 3 + 1]
      out[i * 4 + 2] = rgb[i * 3 + 2]
    }
    out[i * 4 + 3] = alpha[i]
  }
  return { image: { data: out, width: w, height: h }, stats }
}
