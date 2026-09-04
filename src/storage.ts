/**
 * Сохранение сессии между перезагрузками.
 *
 * Настройки — в localStorage: пара килобайт JSON. Файлы и правки — в
 * IndexedDB: в localStorage они не влезут (лимит около пяти мегабайт, а один
 * спрайт 1024×1024 с масками стираний весит больше), и она умеет хранить Blob
 * и типизированные массивы без сериализации.
 */

const DB_NAME = 'pixel-fix'
const DB_VERSION = 1
const ASSETS = 'assets'
const EDITS = 'edits'
const SETTINGS_KEY = 'pixel-fix:settings'
const STATE_KEY = 'pixel-fix:state'

// Держим сессию в разумных рамках: база не должна разрастаться на гигабайты.
const MAX_ASSETS = 300
const MAX_BYTES = 150 * 1024 * 1024

export interface StoredAsset {
  id: string
  name: string
  path: string
  blob: Blob
}

export interface StoredEdit {
  type: 'erase' | 'restore'
  pixels: Int32Array
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(EDITS)) db.createObjectStore(EDITS)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function saveAssets(assets: StoredAsset[]): Promise<boolean> {
  const total = assets.reduce((sum, a) => sum + a.blob.size, 0)
  if (assets.length > MAX_ASSETS || total > MAX_BYTES) return false
  const db = await openDb()
  const tx = db.transaction(ASSETS, 'readwrite')
  const store = tx.objectStore(ASSETS)
  store.clear()
  for (const asset of assets) store.put(asset)
  await done(tx)
  db.close()
  return true
}

export async function loadAssets(): Promise<StoredAsset[]> {
  const db = await openDb()
  const tx = db.transaction(ASSETS, 'readonly')
  const request = tx.objectStore(ASSETS).getAll()
  const rows = await new Promise<StoredAsset[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredAsset[])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows
}

export async function saveEdits(edits: Map<string, StoredEdit[]>): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(EDITS, 'readwrite')
  const store = tx.objectStore(EDITS)
  store.clear()
  for (const [id, list] of edits) store.put(list, id)
  await done(tx)
  db.close()
}

export async function loadEdits(): Promise<Map<string, StoredEdit[]>> {
  const db = await openDb()
  const tx = db.transaction(EDITS, 'readonly')
  const store = tx.objectStore(EDITS)
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = store.getAllKeys()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const values = await new Promise<StoredEdit[][]>((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result as StoredEdit[][])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return new Map(keys.map((key, i) => [String(key), values[i]]))
}

export async function clearSession(): Promise<void> {
  localStorage.removeItem(SETTINGS_KEY)
  localStorage.removeItem(STATE_KEY)
  const db = await openDb()
  const tx = db.transaction([ASSETS, EDITS], 'readwrite')
  tx.objectStore(ASSETS).clear()
  tx.objectStore(EDITS).clear()
  await done(tx)
  db.close()
}

export function saveJson(key: 'settings' | 'state', value: unknown): void {
  try {
    localStorage.setItem(key === 'settings' ? SETTINGS_KEY : STATE_KEY, JSON.stringify(value))
  } catch {
    // Приватный режим и переполнение квоты — не повод ронять приложение.
  }
}

export function loadJson<T>(key: 'settings' | 'state'): T | null {
  try {
    const raw = localStorage.getItem(key === 'settings' ? SETTINGS_KEY : STATE_KEY)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
