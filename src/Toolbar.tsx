export type ToolId = 'hand' | 'pick' | 'erase' | 'lasso'

interface Item {
  id: ToolId
  label: string
  hint: string
  icon: string
}

const TOOLS: Item[] = [
  { id: 'hand', label: 'Рука', hint: 'Двигать и зумить холст · H', icon: '✋' },
  { id: 'erase', label: 'Палочка', hint: 'Стереть область по клику · W', icon: '✨' },
  { id: 'lasso', label: 'Лассо', hint: 'Вернуть оригинал в области · L', icon: '🔗' },
]

/** Вертикальный ряд инструментов слева: выбор режима работы с холстом. */
export function Toolbar({
  tool,
  onSelect,
  panels,
  onTogglePanel,
  disabled,
}: {
  tool: ToolId
  onSelect: (tool: ToolId) => void
  panels: Record<string, boolean>
  onTogglePanel: (id: string) => void
  disabled: boolean
}) {
  return (
    <nav className="toolbar">
      {TOOLS.map((item) => (
        <button
          key={item.id}
          className={tool === item.id ? 'tool active' : 'tool'}
          onClick={() => onSelect(item.id)}
          disabled={disabled && item.id !== 'hand'}
          title={`${item.label} — ${item.hint}`}
        >
          <span className="icon">{item.icon}</span>
          <span className="caption">{item.label}</span>
        </button>
      ))}

      <div className="toolbar-divider" />

      {[
        { id: 'outline', label: 'Обводка', icon: '🖊' },
        { id: 'cleanup', label: 'Чистка', icon: '🩹' },
        { id: 'color', label: 'Цвет', icon: '🎨' },
        { id: 'pixelize', label: 'Пиксели', icon: '🔲' },
        { id: 'files', label: 'Файлы', icon: '🗂' },
      ].map((item) => (
        <button
          key={item.id}
          className={panels[item.id] ? 'tool active' : 'tool'}
          onClick={() => onTogglePanel(item.id)}
          title={item.label}
        >
          <span className="icon">{item.icon}</span>
          <span className="caption">{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
