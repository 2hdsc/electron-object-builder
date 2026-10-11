/**
 * Recently opened client file sets for the web build, persisted in IndexedDB.
 *
 * What gets stored depends on how the files were opened:
 * - directory: the FileSystemDirectoryHandle (Chromium). Read permission is
 *   re-requested when the entry is reopened.
 * - files: FileSystemFileHandles when the File System Access API was used,
 *   otherwise only the file names (the user is asked to select them again).
 * - preload: the `?dat=&spr=` query string, fetched again on reopen.
 *
 * File contents are never stored.
 */

export interface PermissionHandleLike {
  name: string
  queryPermission?: (d?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

export interface FileHandleLike extends PermissionHandleLike {
  kind?: 'file'
  getFile(): Promise<File>
}

export interface DirectoryHandleLike extends PermissionHandleLike {
  kind?: 'directory'
  values(): AsyncIterable<{ kind: string; name: string; getFile?: () => Promise<File> }>
}

export type RecentSource =
  | { kind: 'directory'; name: string; handle: DirectoryHandleLike }
  | { kind: 'files'; name: string; fileNames: string[]; handles?: FileHandleLike[] }
  | { kind: 'preload'; name: string; search: string }

export interface RecentEntry {
  /** Stable key: same source => same entry (moved to the top on reopen) */
  id: string
  /** Display label, e.g. "860" or "Tibia.dat + Tibia.spr" */
  label: string
  /** Extra info, e.g. client version "8.60 v2" */
  detail?: string
  openedAt: number
  source: RecentSource
}

const DB_NAME = 'object-builder-web'
const DB_VERSION = 1
const STORE = 'recents'
export const MAX_RECENTS = 10

export function recentId(source: RecentSource): string {
  switch (source.kind) {
    case 'directory':
      return `directory:${source.name}`
    case 'files':
      return `files:${[...source.fileNames].sort().join('|')}`
    case 'preload':
      return `preload:${source.search}`
  }
}

export function recentLabel(source: RecentSource): string {
  switch (source.kind) {
    case 'directory':
      return source.name
    case 'files':
      return source.fileNames.join(' + ')
    case 'preload': {
      const params = new URLSearchParams(source.search)
      const dat = params.get('dat') ?? ''
      return dat.replace(/\/?[^/]*$/, '') || dat || source.name
    }
  }
}

export class RecentsStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  get available(): boolean {
    return !!this.factory
  }

  private db(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error('IndexedDB not available'))
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = this.factory!.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: 'id' })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    }
    return this.dbPromise
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | void
  ): Promise<T | undefined> {
    const db = await this.db()
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const req = fn(t.objectStore(STORE))
      t.oncomplete = () => resolve(req ? req.result : undefined)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }

  async list(): Promise<RecentEntry[]> {
    if (!this.available) return []
    const all = ((await this.tx('readonly', (s) => s.getAll())) ?? []) as RecentEntry[]
    return all.sort((a, b) => b.openedAt - a.openedAt)
  }

  async add(source: RecentSource, detail?: string, now = Date.now()): Promise<RecentEntry> {
    const entry: RecentEntry = {
      id: recentId(source),
      label: recentLabel(source),
      detail,
      openedAt: now,
      source
    }
    if (!this.available) return entry
    await this.tx('readwrite', (s) => s.put(entry))
    const all = await this.list()
    const stale = all.slice(MAX_RECENTS)
    if (stale.length > 0) {
      await this.tx('readwrite', (s) => {
        stale.forEach((e) => s.delete(e.id))
      })
    }
    return entry
  }

  async remove(id: string): Promise<void> {
    if (!this.available) return
    await this.tx('readwrite', (s) => s.delete(id))
  }

  async clear(): Promise<void> {
    if (!this.available) return
    await this.tx('readwrite', (s) => s.clear())
  }
}

/** Ensures read permission on a stored handle (must run from a user gesture to prompt). */
export async function ensureReadPermission(handle: PermissionHandleLike): Promise<boolean> {
  const opts = { mode: 'read' as const }
  if (!handle.queryPermission) return true
  if ((await handle.queryPermission(opts)) === 'granted') return true
  if (!handle.requestPermission) return false
  return (await handle.requestPermission(opts)) === 'granted'
}
