/**
 * Курсоры инструментов.
 *
 * Рисуем сами и подставляем через data-URI: системный crosshair не говорит,
 * чем именно ты сейчас работаешь. Каждая иконка белая с тёмной обводкой,
 * чтобы читаться и на светлом спрайте, и на тёмной шахматке.
 */

const wrap = (body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">${body}</svg>`,
  )}`

// Кончик пипетки — в левом нижнем углу, туда же указывает горячая точка.
const pipette = wrap(`
  <g fill="none" stroke="#12141a" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 22l1-4 9-9 3 3-9 9z"/><path d="M15.5 6.5l4 4"/><path d="M17 3.5l5.5 5.5"/>
  </g>
  <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 22l1-4 9-9 3 3-9 9z"/><path d="M15.5 6.5l4 4"/><path d="M17 3.5l5.5 5.5"/>
  </g>`)

// Волшебная палочка: остриё в левом нижнем углу, искры у рукояти.
const wand = wrap(`
  <g fill="none" stroke="#12141a" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 23L16 10"/><path d="M14 8l4 4"/>
    <path d="M20 3v4M18 5h4M21.5 11v3M20 12.5h3"/>
  </g>
  <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 23L16 10"/><path d="M14 8l4 4"/>
    <path d="M20 3v4M18 5h4M21.5 11v3M20 12.5h3"/>
  </g>`)

// Лассо: петля с хвостиком, горячая точка на конце хвоста.
const lasso = wrap(`
  <g fill="none" stroke="#12141a" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 4c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6c0-1.7 1-3.2 2.7-4.3"/>
    <path d="M8 15.5c0 3 1.5 4 1.5 6"/>
  </g>
  <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 4c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6c0-1.7 1-3.2 2.7-4.3"/>
    <path d="M8 15.5c0 3 1.5 4 1.5 6"/>
  </g>`)

/** Курсор с горячей точкой в том месте, куда инструмент реально ткнёт. */
export const CURSORS: Record<string, string> = {
  hand: 'grab',
  pick: `url("${pipette}") 4 22, crosshair`,
  erase: `url("${wand}") 3 23, crosshair`,
  lasso: `url("${lasso}") 10 22, crosshair`,
}

/** Что инструмент делает и чем отличается от привычного по редакторам. */
export const TOOL_HELP: Record<string, string> = {
  hand: 'Тащи холст мышью, колесо — зум к курсору, двойной клик — вписать.',
  pick: 'Кликни по обводке на картинке — возьмём её цвет.',
  erase: 'Клик стирает связную область похожего цвета целиком — это не кисть. Ширину захвата задаёт «Допуск» в окне «Фон».',
  lasso: 'Обведи область — внутри вернётся оригинал. Это отмена стираний на участке, а не выделение для копирования.',
}
