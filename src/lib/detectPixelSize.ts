/**
 * Определение размера арт-пикселя у псевдопиксельной картинки.
 *
 * Псевдопиксельная — это пиксель-арт, растянутый до большого размера: каждый
 * арт-пиксель стал квадратом в несколько экранных. Задача — найти сторону
 * этого квадрата и начало сетки, чтобы `pixelize` свёл картинку обратно.
 *
 * Идея взята из клиентской детекции pixels.rocks. Серверная версия там же
 * считает Canny и Хафа через OpenCV — её не тащим: у нас нет и не будет
 * сервера, а обещание «файлы никуда не уходят» дороже пары процентов точности.
 *
 * Работа идёт по профилю перепадов: для каждой границы столбцов (и строк)
 * складывается величина изменения цвета. У растянутого арта цвет меняется
 * только на линиях сетки, поэтому профиль — почти гребёнка. Период гребёнки
 * ищется одной суммой Фурье на каждой пробной частоте: сколько массы
 * перепадов сидит ровно на этой частоте. Такой ответ не зависит от допусков,
 * работает с дробным шагом и заодно даёт фазу — начало сетки.
 */

import type { Bitmap } from './pixelfix'

export interface PixelSizeResult {
  /** Сторона арт-пикселя в экранных пикселях, может быть дробной. */
  block: number
  /** Доля массы перепадов, севшая на сетку, 0..1. */
  confidence: number
  /** Сдвиг сетки: где начинается первый целый блок. */
  offsetX: number
  offsetY: number
}

export interface DetectOptions {
  /**
   * Допустимый разброс цвета внутри блока (среднеквадратичное отклонение).
   * Сорок, а не двадцать: у арта, сделанного нейросетью, арт-пиксель не
   * плоский — внутри него живёт шум и лёгкий градиент. Со строгим порогом
   * проверка на однородность отсеивала сотню ассетов из двухсот, включая те,
   * где спектр находил сетку уверенно.
   */
  maxDeviation?: number
  minBlock?: number
  maxBlock?: number
}

/** Цвет считается сменившимся, если он отъехал заметнее шума сжатия. */
const CHANGE_LEVEL = 12

/**
 * Второй проход считает только сильные перепады. У картинок с плотным шумом
 * (фотореалистичный рендер, тяжёлый JPEG) мелкие перепады идут сплошняком и
 * топят сетку: на портрете зомби слабый порог даёт 0.17, строгий — 0.81.
 */
const STRONG_LEVEL = 70

/** Доля самых сильных позиций профиля, по которым считается период. */
const PROFILE_SHARE = 0.25

/**
 * Ниже этой доли массы «сетка» неотличима от случайной периодичности: у шума
 * и у картинки с убитой сеткой выходит 0.14–0.33, поэтому ответы слабее 0.35
 * возвращаются как есть, но вызывающий должен предупредить о ненадёжности.
 */
const MIN_MAGNITUDE = 0.2

/** Выше этого порога сетке можно верить без оговорок. */
export const SURE_MAGNITUDE = 0.35

/** Ниже этой доли однородных блоков гипотеза не рассматривается. */
const MIN_SCORE = 0.8

/**
 * Профиль перепадов: насколько сильно меняется цвет на границе x−1 | x
 * (или y−1 | y), сложенное по всей линии.
 *
 * Считается величина перепада, а не факт: на линии сетки цвет прыгает на
 * сотню, а шум сжатия ползает у порога. По числу событий шумная картинка не
 * отличается от сетки, по величине — отличается.
 */
function changeProfile(image: Bitmap, axis: 'x' | 'y'): { soft: Float64Array; strong: Float64Array } {
  const { data, width, height } = image
  const size = axis === 'x' ? width : height
  const across = axis === 'x' ? height : width
  const soft = new Float64Array(size)
  const strong = new Float64Array(size)

  // Оба порога считаются за один проход: на картинке 2500×2500 второй проход
  // стоит полсекунды, а нужен он только ради другого порога отсечки.
  for (let at = 1; at < size; at++) {
    let sumSoft = 0
    let sumStrong = 0
    for (let other = 0; other < across; other++) {
      const x = axis === 'x' ? at : other
      const y = axis === 'x' ? other : at
      const i = (y * width + x) * 4
      const j = axis === 'x' ? i - 4 : i - width * 4
      const alphaGap = Math.abs(data[i + 3] - data[j + 3])
      if (alphaGap > 64) {
        sumSoft += alphaGap
        sumStrong += alphaGap
        continue
      }
      // Прозрачные пиксели сравнивать по цвету бессмысленно — там мусор.
      if (data[i + 3] < 128 || data[j + 3] < 128) continue
      const gap = Math.max(
        Math.abs(data[i] - data[j]),
        Math.abs(data[i + 1] - data[j + 1]),
        Math.abs(data[i + 2] - data[j + 2]),
      )
      if (gap > CHANGE_LEVEL) sumSoft += gap
      if (gap > STRONG_LEVEL) sumStrong += gap
    }
    soft[at] = sumSoft
    strong[at] = sumStrong
  }

  return { soft: keepStrongest(soft), strong: keepStrongest(strong) }
}

/**
 * Оставляет в профиле только самые сильные позиции.
 *
 * Шум сжатия даёт перепады всюду и ровным слоем. Медиана — это его уровень;
 * вычитаем её, а затем оставляем четверть самых сильных позиций: линии сетки
 * сидят именно там, а всё остальное только разбавляет ответ.
 */
function keepStrongest(profile: Float64Array): Float64Array {
  const sorted = Float64Array.from(profile.subarray(1)).sort()
  if (!sorted.length) return profile
  const middle = sorted[sorted.length >> 1]
  const cut = sorted[Math.floor(sorted.length * (1 - PROFILE_SHARE))]
  const out = new Float64Array(profile.length)
  for (let at = 1; at < profile.length; at++) {
    const value = profile[at] - middle
    out[at] = profile[at] > cut && value > 0 ? value : 0
  }
  return out
}

/**
 * Сколько массы перепадов сидит на частоте с периодом `period`, и с какой фазой.
 *
 * Одна сумма Фурье: единица — все перепады строго на линиях сетки, ноль —
 * они разбросаны как попало. Фаза угла поворота даёт начало сетки с точностью
 * лучше пикселя, поэтому отдельный перебор сдвига не нужен.
 */
function periodEnergy(profile: Float64Array, period: number): { magnitude: number; phase: number } {
  let re = 0
  let im = 0
  let total = 0
  for (let at = 1; at < profile.length; at++) {
    const value = profile[at]
    if (!value) continue
    const angle = (-2 * Math.PI * at) / period
    re += value * Math.cos(angle)
    im += value * Math.sin(angle)
    total += value
  }
  if (!total) return { magnitude: 0, phase: 0 }

  let phase = ((-Math.atan2(im, re) / (2 * Math.PI)) * period) % period
  if (phase < 0) phase += period
  return { magnitude: Math.hypot(re, im) / total, phase }
}

/**
 * Разброс цвета в квадрате. Прозрачные пиксели не учитываются, а квадрат,
 * закрытый ими больше чем наполовину, возвращает -1: считать пустоту
 * однородной нечестно, иначе прозрачные поля вокруг спрайта одобрят любую
 * гипотезу о размере блока.
 */
function regionDeviation(image: Bitmap, startX: number, startY: number, size: number): number {
  const { data, width } = image
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let count = 0
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const i = ((startY + dy) * width + startX + dx) * 4
      if (data[i + 3] < 128) continue
      sumR += data[i]
      sumG += data[i + 1]
      sumB += data[i + 2]
      count++
    }
  }
  if (count * 2 < size * size) return -1

  const meanR = sumR / count
  const meanG = sumG / count
  const meanB = sumB / count
  let varR = 0
  let varG = 0
  let varB = 0
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const i = ((startY + dy) * width + startX + dx) * 4
      if (data[i + 3] < 128) continue
      varR += (data[i] - meanR) ** 2
      varG += (data[i + 1] - meanG) ** 2
      varB += (data[i + 2] - meanB) ** 2
    }
  }
  return Math.sqrt(Math.max(varR, varG, varB) / count)
}

/**
 * Доля однородных блоков при данной сетке — вторая проверка, уже по картинке,
 * а не по профилю. Внутри арт-пикселя цвет ровный, поэтому смотрим середину
 * блока: край смазан растяжением.
 */
function blockUniformity(
  image: Bitmap,
  block: number,
  maxDeviation: number,
  offsetX: number,
  offsetY: number,
  maxSamples = 80,
): number {
  const { width, height } = image
  const gridX = Math.floor((width - offsetX) / block)
  const gridY = Math.floor((height - offsetY) / block)
  if (gridX < 4 || gridY < 4) return 0

  const total = gridX * gridY
  const step = Math.max(1, Math.floor(total / maxSamples))

  let uniform = 0
  let checked = 0
  for (let i = 0; i < total && checked < maxSamples; i += step) {
    const gx = i % gridX
    const gy = Math.floor(i / gridX)
    const x0 = offsetX + Math.round(gx * block)
    const y0 = offsetY + Math.round(gy * block)
    const side = Math.min(
      offsetX + Math.round((gx + 1) * block) - x0,
      offsetY + Math.round((gy + 1) * block) - y0,
    )
    // Меньше двух пикселей в пробе брать нельзя: разброс одного пикселя равен
    // нулю, и блок 2×2 тогда «однороден» в любом шуме.
    const probe = Math.min(side, Math.max(2, Math.floor(side / 2)))
    const x = x0 + Math.floor((side - probe) / 2)
    const y = y0 + Math.floor((side - probe) / 2)
    if (x < 0 || y < 0 || x + probe > width || y + probe > height) continue

    const deviation = regionDeviation(image, x, y, probe)
    if (deviation < 0) continue
    if (deviation <= maxDeviation) uniform++
    checked++
  }
  return checked >= 8 ? uniform / checked : 0
}

interface Candidate {
  block: number
  magnitude: number
  phaseX: number
  phaseY: number
}

/**
 * Свод двух осей в одну оценку.
 *
 * Сетка обязана быть одна и та же по горизонтали и по вертикали, поэтому
 * оценка должна падать, если ось молчит. Но минимум из двух — слишком строго:
 * у фасада дома почти вся деталь горизонтальная, вертикальных перепадов мало,
 * и настоящая сетка получала оценку молчащей оси. Среднее геометрическое
 * требует обеих осей, но не отдаёт ответ целиком слабейшей.
 */
function agreement(x: number, y: number): number {
  return Math.sqrt(x * y)
}

/** Пик на одной паре профилей: период с наибольшей долей массы. */
function findPeak(
  cols: Float64Array,
  rows: Float64Array,
  size: number,
  minBlock: number,
  maxBlock: number,
): Candidate {
  let best: Candidate = { block: 0, magnitude: 0, phaseX: 0, phaseY: 0 }
  // Перебор идёт по частоте, а не по периоду: ширина пика в периоде растёт
  // как квадрат периода, и равномерный шаг по периоду либо промахивается мимо
  // мелкой сетки, либо считает крупную сотню раз впустую.
  // Шаг по частоте — половина ширины пика: точное значение всё равно
  // уточняется потом, а грубый перебор на большой картинке самый дорогой.
  for (let frequency = size / maxBlock; frequency <= size / minBlock; frequency += 0.5) {
    const block = size / frequency
    const x = periodEnergy(cols, block)
    const y = periodEnergy(rows, block)
    const magnitude = agreement(x.magnitude, y.magnitude)
    if (magnitude > best.magnitude) {
      best = { block, magnitude, phaseX: x.phase, phaseY: y.phase }
    }
  }
  return best
}

/** Уточнение пика мелким шагом вокруг найденного периода. */
function refinePeak(
  cols: Float64Array,
  rows: Float64Array,
  around: number,
  span: number,
): Candidate {
  let best: Candidate = { block: around, magnitude: 0, phaseX: 0, phaseY: 0 }
  for (let block = around - span; block <= around + span; block += span / 20) {
    if (block <= 1) continue
    const x = periodEnergy(cols, block)
    const y = periodEnergy(rows, block)
    const magnitude = agreement(x.magnitude, y.magnitude)
    if (magnitude > best.magnitude) {
      best = { block, magnitude, phaseX: x.phase, phaseY: y.phase }
    }
  }
  return best
}

/**
 * Подгонка периода к «круглому» значению.
 *
 * Сначала к целому: 3.998 — это 4, а разница накопится по всей картинке в
 * лишний пиксель. Если целое не подходит, период подгоняется под целое число
 * арт-пикселей по стороне: у необрезанной картинки сетка обязана уложиться в
 * ширину без остатка.
 */
function snapBlock(block: number, width: number): number {
  const whole = Math.round(block)
  if (whole >= 2 && Math.abs(block - whole) / block < 0.01) return whole
  const grid = Math.round(width / block)
  if (grid >= 4) {
    const fitted = width / grid
    if (Math.abs(fitted - block) / block < 0.01) return fitted
  }
  return block
}

/** Фаза в пикселях: 4.98 при блоке 5 — это ноль, а не почти пять. */
function phaseToOffset(phase: number, block: number): number {
  const offset = Math.round(phase)
  return offset >= Math.round(block) ? 0 : offset
}

/**
 * Главный вход: возвращает размер арт-пикселя или null, если картинка не
 * похожа на растянутый пиксель-арт.
 */
export function detectPixelSize(image: Bitmap, options: DetectOptions = {}): PixelSizeResult | null {
  const { maxDeviation = 40, minBlock = 2, maxBlock = 64 } = options
  const { width, height } = image
  if (width < 16 || height < 16) return null

  const size = Math.max(width, height)
  let best: Candidate | null = null

  const byX = changeProfile(image, 'x')
  const byY = changeProfile(image, 'y')

  // Сначала слабый порог, потом строгий: у картинок с плотным шумом сетку
  // видно только по сильным перепадам, у мягко закрашенных — наоборот.
  for (const level of ['soft', 'strong'] as const) {
    const cols = byX[level]
    const rows = byY[level]
    const peak = findPeak(cols, rows, size, minBlock, maxBlock)
    if (!peak.magnitude) continue

    let sharpened = refinePeak(cols, rows, peak.block, peak.block / 40)
    // Половина настоящего блока звучит на той же гребёнке не тише целого: все
    // линии сетки лежат и на половинных. Поэтому проверяются кратные пику
    // периоды — и берётся самый крупный, звучащий не слабее. Именно кратные:
    // «просто самый крупный из сильных» уводит на случайную низкую частоту,
    // на портрете зомби — с настоящих 2.51 px на 48.7.
    const base = sharpened.magnitude
    const fundamental = sharpened.block
    for (let times = 2; times <= 8; times++) {
      // Кратные считаются от исходного пика, а не от уже принятого: иначе
      // после повышения 2 → 4 следующая проверка уходит на 12 и настоящие 8
      // не проверяются вовсе.
      const multiple = fundamental * times
      if (multiple > maxBlock) break
      // Сначала дешёвая проверка ровно на кратной частоте: уточнять пик,
      // который и близко не звучит, незачем.
      const probe = agreement(
        periodEnergy(cols, multiple).magnitude,
        periodEnergy(rows, multiple).magnitude,
      )
      if (probe < base * 0.7) continue
      const wider = refinePeak(cols, rows, multiple, multiple / 40)
      if (wider.magnitude >= base * 0.85) sharpened = wider
    }

    if (!best || sharpened.magnitude > best.magnitude) best = sharpened
    // Слабого ответа мало, чтобы бросить перебор: на портрете зомби мягкий
    // порог даёт 0.20 на 2.44 px, а строгий — 0.76 на настоящих 5 px.
    if (best.magnitude >= SURE_MAGNITUDE) break
  }

  if (!best || best.magnitude < MIN_MAGNITUDE) return null

  const block = snapBlock(best.block, width)
  const offsetX = phaseToOffset(best.phaseX, block)
  const offsetY = phaseToOffset(best.phaseY, block)
  if (blockUniformity(image, block, maxDeviation, offsetX, offsetY) < MIN_SCORE) return null

  return { block, confidence: best.magnitude, offsetX, offsetY }
}

/**
 * Грубая оценка размера блока, когда сетки нет.
 *
 * Бывает арт, у которого блоки есть, а общей сетки нет: каждый «пиксель»
 * стоит где придётся, поэтому спектр молчит, хотя глазами блоки видны — так
 * нарисован, например, `mainhand_anchor.png` из «Pack 1». Отвечать на такой
 * картинке «сетки нет» бесполезно: человек её видит. Медиана длин ровных
 * участков цвета даёт близкий ответ — на файлах, где сетка известна, она
 * попадает почти точно (3.53 → 3, 5.0 → 5, 5.72 → 5, 7.64 → 7).
 *
 * Возвращает null, если картинка нарисована гладко: медиана в один-два
 * пикселя означает антиалиасинг, а не блоки.
 */
export function estimateBlockSize(image: Bitmap): number | null {
  const { data, width, height } = image
  const runs: number[] = []

  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? width : height
    const across = axis === 'x' ? height : width
    for (let other = 0; other < across; other++) {
      let length = 1
      for (let at = 1; at < size; at++) {
        const x = axis === 'x' ? at : other
        const y = axis === 'x' ? other : at
        const i = (y * width + x) * 4
        const j = axis === 'x' ? i - 4 : i - width * 4
        const gap = Math.max(
          Math.abs(data[i] - data[j]),
          Math.abs(data[i + 1] - data[j + 1]),
          Math.abs(data[i + 2] - data[j + 2]),
        )
        if (data[i + 3] > 128 && data[j + 3] > 128 && gap <= CHANGE_LEVEL) {
          length++
          continue
        }
        if (data[j + 3] > 128 && length > 1) runs.push(length)
        length = 1
      }
    }
  }

  if (runs.length < 32) return null
  runs.sort((a, b) => a - b)
  const median = runs[runs.length >> 1]
  return median >= 3 ? median : null
}
