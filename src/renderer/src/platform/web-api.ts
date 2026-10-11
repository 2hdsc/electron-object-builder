/**
 * Browser implementation of `window.api` (the Electron preload bridge).
 *
 * Used only by the web build (`npm run dev:web` / `npm run build:web`).
 * Files are never uploaded: the user picks or drops local files, which are
 * kept in an in-memory virtual file system and read with the File API.
 * Paths are virtual (e.g. `/web/Tibia.dat`), so the existing renderer code
 * (OpenAssetsDialog, App.handleOpenConfirm, workers...) runs unchanged.
 *
 * Scope: viewing. Writes trigger a browser download; native-only features
 * (file watching, updater, recovery, log file) are no-ops.
 */

import type { ElectronAPI } from '../../../preload/index.d'
import type { MenuAction, MenuState } from '../../../shared/menu-actions'
import { createDefaultMenuState, MENU_FILE_OPEN } from '../../../shared/menu-actions'
import { createObjectBuilderSettings, createDefaultWindowState } from '../../../shared/settings'
import type { ObjectBuilderSettings } from '../../../shared/settings'
import { createProjectState } from '../../../shared/project-state'
import {
  RecentsStore,
  ensureReadPermission,
  type DirectoryHandleLike,
  type FileHandleLike,
  type RecentEntry,
  type RecentSource
} from './web-recents'
import type { ProjectState } from '../../../shared/project-state'

export const WEB_ROOT = '/web'

// ---------------------------------------------------------------------------
// Virtual file system
// ---------------------------------------------------------------------------

export class VirtualFileSystem {
  private files = new Map<string, Blob & { name?: string }>()

  clear(): void {
    this.files.clear()
  }

  add(file: Blob, name: string, dir = WEB_ROOT): string {
    const path = `${dir}/${name}`
    this.files.set(path, file)
    return path
  }

  addAll(files: Iterable<File>, dir = WEB_ROOT): string[] {
    return Array.from(files).map((f) => this.add(f, f.name, dir))
  }

  get(path: string): Blob | undefined {
    return this.files.get(path)
  }

  has(path: string): boolean {
    return this.files.has(path)
  }

  list(dir: string, extensions?: string[]): string[] {
    const exts = extensions?.map((e) => e.toLowerCase().replace(/^\./, ''))
    return Array.from(this.files.keys())
      .filter((p) => dirname(p) === dir)
      .filter((p) => !exts || exts.length === 0 || exts.includes(extname(p)))
      .sort()
  }

  get size(): number {
    return this.files.size
  }
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i < 0 ? '' : b.slice(i + 1).toLowerCase()
}

async function readBlob(vfs: VirtualFileSystem, path: string): Promise<ArrayBuffer> {
  const blob = vfs.get(path)
  if (!blob) throw new Error(`File not found: ${path}`)
  return blob.arrayBuffer()
}

// ---------------------------------------------------------------------------
// File picker helpers
// ---------------------------------------------------------------------------

/** Opens the browser file picker. Must be called from a user gesture. */
export function pickFiles(accept?: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    if (accept) input.accept = accept
    input.style.display = 'none'
    const done = (files: File[]): void => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => done([]))
    document.body.appendChild(input)
    input.click()
  })
}

/** Extensions relevant to the Open dialogs (client + server items). */
export const CLIENT_FILE_EXTENSIONS = ['dat', 'spr', 'otfi', 'otb', 'xml']

/** Keeps only client/server-item files (a picked folder may contain anything). */
export function filterClientFiles(files: File[]): File[] {
  return files.filter((f) => CLIENT_FILE_EXTENSIONS.includes(extname(f.name)))
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>
  showOpenFilePicker?: (options?: {
    multiple?: boolean
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<FileHandleLike[]>
}

export interface PickedDirectory {
  name: string
  files: File[]
  /** Present when the File System Access API was used (can be persisted) */
  handle?: DirectoryHandleLike
}

export interface PickedFiles {
  files: File[]
  /** Present when the File System Access API was used (can be persisted) */
  handles?: FileHandleLike[]
}

/** Reads the top-level files of a directory handle. */
export async function readDirectoryHandle(handle: DirectoryHandleLike): Promise<File[]> {
  const files: File[] = []
  for await (const entry of handle.values()) {
    if (entry.kind === 'file' && entry.getFile) files.push(await entry.getFile())
  }
  return files
}

/**
 * Lets the user pick client files (.dat + .spr together). Uses showOpenFilePicker
 * when available so the handles can be remembered, otherwise `<input multiple>`.
 */
export async function pickClientFileSet(win: DirectoryPickerWindow = window): Promise<PickedFiles> {
  if (typeof win.showOpenFilePicker === 'function') {
    try {
      const handles = await win.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: 'Client files',
            accept: { 'application/octet-stream': ['.dat', '.spr', '.otfi'] }
          }
        ]
      })
      return { files: await Promise.all(handles.map((h) => h.getFile())), handles }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return { files: [] }
      throw err
    }
  }
  return { files: await pickFiles('.dat,.spr,.otfi', true) }
}

/**
 * Lets the user pick a folder. Uses the File System Access API when available
 * (Chromium), otherwise an `<input webkitdirectory>`. Only top-level files are
 * returned. Must be called from a user gesture. Resolves null when canceled.
 */
export async function pickDirectory(
  win: DirectoryPickerWindow = window
): Promise<PickedDirectory | null> {
  if (typeof win.showDirectoryPicker === 'function') {
    let handle: DirectoryHandleLike
    try {
      handle = await win.showDirectoryPicker({ mode: 'read' })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
    return { name: handle.name, files: await readDirectoryHandle(handle), handle }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.setAttribute('webkitdirectory', '')
    input.style.display = 'none'
    const done = (value: PickedDirectory | null): void => {
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const all = Array.from(input.files ?? [])
      if (all.length === 0) return done(null)
      // webkitRelativePath is "<folder>/<sub>/<file>": keep top-level files only
      const rel = (f: File): string[] =>
        ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).split('/')
      const name = rel(all[0]).length > 1 ? rel(all[0])[0] : 'folder'
      done({ name, files: all.filter((f) => rel(f).length <= 2) })
    })
    input.addEventListener('cancel', () => done(null))
    document.body.appendChild(input)
    input.click()
  })
}

function acceptFromFilters(filters?: { extensions: string[] }[]): string | undefined {
  const exts = filters?.flatMap((f) => f.extensions).filter((e) => e && e !== '*')
  return exts && exts.length > 0 ? exts.map((e) => `.${e}`).join(',') : undefined
}

function download(name: string, data: BlobPart): void {
  const url = URL.createObjectURL(new Blob([data]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// ---------------------------------------------------------------------------
// Local storage helpers
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'ob-web-settings'
const RECENT_KEY = 'ob-web-recent'

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota / privacy mode errors
  }
}

// ---------------------------------------------------------------------------
// API factory
// ---------------------------------------------------------------------------

export interface WebApi extends ElectronAPI {
  /** Web-only helpers (not part of the Electron bridge) */
  web: {
    vfs: VirtualFileSystem
    /** Registers local files (picked or dropped) and opens the "Open" dialog. */
    openFiles(files: File[], source?: RecentSource, options?: { autoConfirm?: boolean }): void
    /** File picker for client files (select .dat + .spr together). Returns the virtual dir. */
    pickClientFiles(): Promise<string | null>
    /** Returns (and clears) the directory of files dropped/preloaded but not yet used. */
    consumePendingDirectory(): string | null
    /** Called whenever dropped/preloaded files become available. Returns cleanup. */
    onFilesReady(cb: (directory: string) => void): () => void
    dispatchMenuAction(action: MenuAction): void
    /** Remembers how the current files were opened (recorded as recent on load). */
    setSource(source: RecentSource | null): void
    /** Returns (and clears) whether the Open dialog should confirm automatically. */
    consumeAutoConfirm(): boolean
    /** Recently opened sets (IndexedDB), newest first. */
    listRecents(): Promise<RecentEntry[]>
    clearRecents(): Promise<void>
    removeRecent(id: string): Promise<void>
    onRecentsChanged(cb: () => void): () => void
    /**
     * Reopens a recent entry (call from a click: may prompt for permission or
     * for re-selecting the files). Loads directly when possible.
     */
    reopenRecent(entry: RecentEntry): Promise<ReopenResult>
  }
}

export type ReopenResult = 'opened' | 'canceled' | 'permission-denied' | 'failed'

export function createWebApi(vfs = new VirtualFileSystem(), recents = new RecentsStore()): WebApi {
  const menuListeners = new Set<(action: MenuAction) => void>()
  let menuState: MenuState = createDefaultMenuState()
  let projectState: ProjectState = createProjectState()
  let settings: ObjectBuilderSettings = loadJson(SETTINGS_KEY, createObjectBuilderSettings())
  let recent: Record<string, string | null> = loadJson(RECENT_KEY, {})
  /** Files dropped/opened outside the dialog, consumed by the next directory dialog. */
  let pendingDirectory: string | null = null
  const filesReadyListeners = new Set<(directory: string) => void>()
  const recentsListeners = new Set<() => void>()
  /** How the files currently in the VFS were opened */
  let currentSource: RecentSource | null = null
  let autoConfirm = false

  const notifyRecents = (): void => recentsListeners.forEach((cb) => cb())

  /** Puts files in the VFS and hands them to the Open dialog (opening it if needed). */
  const deliverFiles = (
    files: File[],
    dir: string,
    source: RecentSource | null,
    auto: boolean
  ): void => {
    vfs.clear()
    vfs.addAll(files, dir)
    currentSource = source
    pendingDirectory = dir
    autoConfirm = auto
    if (filesReadyListeners.size > 0) {
      filesReadyListeners.forEach((cb) => cb(dir))
    } else {
      dispatchMenuAction(MENU_FILE_OPEN as MenuAction)
    }
  }

  /** Actions dispatched before the app subscribed (e.g. preload on startup). */
  const queuedActions: MenuAction[] = []

  const dispatchMenuAction = (action: MenuAction): void => {
    if (menuListeners.size === 0) {
      queuedActions.push(action)
      return
    }
    menuListeners.forEach((cb) => cb(action))
  }

  const api: WebApi = {
    file: {
      async showOpenDialog(options) {
        const files = await pickFiles(acceptFromFilters(options?.filters), true)
        if (files.length === 0) return { canceled: true, filePaths: [] }
        vfs.clear()
        return { canceled: false, filePaths: vfs.addAll(files) }
      },
      async showSaveDialog(options) {
        const name = basename(options?.defaultPath ?? 'download.bin')
        return { canceled: false, filePath: `${WEB_ROOT}/${name}` }
      },
      async showDirectoryDialog() {
        if (pendingDirectory) {
          const dir = pendingDirectory
          pendingDirectory = null
          return { canceled: false, directoryPath: dir }
        }
        // Browsers can't hand out a real path: read the folder's files into the VFS.
        const picked = await pickDirectory()
        if (!picked) return { canceled: true, directoryPath: null }
        const dir = `${WEB_ROOT}/${picked.name || 'folder'}`
        const files = filterClientFiles(picked.files)
        vfs.clear()
        vfs.addAll(files, dir)
        currentSource = picked.handle
          ? { kind: 'directory', name: picked.name, handle: picked.handle }
          : { kind: 'files', name: picked.name, fileNames: files.map((f) => f.name) }
        return { canceled: false, directoryPath: dir }
      },
      readBinary: (p) => readBlob(vfs, p),
      async writeBinary(p, data) {
        download(basename(p), data)
      },
      async readText(p) {
        const blob = vfs.get(p)
        if (!blob) throw new Error(`File not found: ${p}`)
        return blob.text()
      },
      async writeText(p, content) {
        download(basename(p), content)
      },
      exists: async (p) => vfs.has(p),
      async getInfo(p) {
        const blob = vfs.get(p)
        return {
          path: p,
          name: basename(p),
          extension: extname(p),
          directory: dirname(p),
          size: blob?.size ?? 0,
          lastModified: blob instanceof File ? blob.lastModified : 0,
          exists: blob !== undefined
        }
      },
      list: async (dir, exts) => vfs.list(dir, exts),
      async findInDirectory(dir, name) {
        const lower = name.toLowerCase()
        return vfs.list(dir).find((p) => basename(p).toLowerCase() === lower) ?? null
      },
      watch: async () => {},
      unwatch: async () => {},
      unwatchAll: async () => {},
      onFileChanged: () => () => {}
    },
    recent: {
      load: async () => {},
      get: async (key) => recent[key] ?? null,
      async set(key, value) {
        recent = { ...recent, [key]: value }
        saveJson(RECENT_KEY, recent)
      },
      getAll: async () => recent as never,
      async clear() {
        recent = {}
        saveJson(RECENT_KEY, recent)
      }
    },
    project: {
      getState: async () => projectState,
      isLoaded: async () => projectState.loaded,
      async create(params) {
        projectState = { ...createProjectState(), ...params, loaded: true, isTemporary: true }
        return projectState
      },
      async load(params) {
        const [datBuffer, sprBuffer] = await Promise.all([
          readBlob(vfs, params.datFilePath),
          readBlob(vfs, params.sprFilePath)
        ])
        const dir = dirname(params.datFilePath)
        const otfi = vfs.list(dir, ['otfi'])[0]
        const serverDir = params.serverItemsPath ?? null
        const otb = serverDir ? vfs.list(serverDir, ['otb'])[0] : undefined
        const xml = serverDir ? vfs.list(serverDir, ['xml'])[0] : undefined
        projectState = {
          ...createProjectState(),
          loaded: true,
          datFilePath: params.datFilePath,
          sprFilePath: params.sprFilePath,
          serverItemsPath: serverDir,
          versionValue: params.versionValue,
          datSignature: params.datSignature,
          sprSignature: params.sprSignature,
          features: params.features,
          loadedFileName: basename(params.datFilePath).replace(/\.dat$/i, '')
        }
        if (currentSource) {
          const detail = `${Math.floor(params.versionValue / 100)}.${String(params.versionValue % 100).padStart(2, '0')}`
          recents
            .add(currentSource, detail)
            .then(notifyRecents)
            .catch((err) => console.warn('[ob] could not save recent:', err))
        }
        return {
          datBuffer,
          sprBuffer,
          otbBuffer: otb ? await readBlob(vfs, otb) : null,
          xmlContent: xml ? ((await vfs.get(xml)?.text()) ?? null) : null,
          otfiContent: otfi ? ((await vfs.get(otfi)?.text()) ?? null) : null
        }
      },
      async compile(params) {
        download(basename(params.datFilePath), params.datBuffer)
        download(basename(params.sprFilePath), params.sprBuffer)
      },
      async loadMergeFiles(params) {
        return {
          datBuffer: await readBlob(vfs, params.datFilePath),
          sprBuffer: await readBlob(vfs, params.sprFilePath)
        }
      },
      async unload() {
        projectState = createProjectState()
      },
      markChanged: async () => {
        projectState = { ...projectState, changed: true }
      },
      markSaved: async () => {
        projectState = { ...projectState, changed: false }
      },
      setServerItemsPath: async (p) => {
        projectState = { ...projectState, serverItemsPath: p }
      },
      updateFeatures: async (f) => {
        projectState = { ...projectState, features: { ...projectState.features, ...f } }
      },
      async discoverClientFiles(dir) {
        return {
          datFile: vfs.list(dir, ['dat'])[0] ?? null,
          sprFile: vfs.list(dir, ['spr'])[0] ?? null,
          otfiFile: vfs.list(dir, ['otfi'])[0] ?? null
        }
      },
      async discoverServerItemFiles(dir) {
        return {
          otbFile: vfs.list(dir, ['otb'])[0] ?? null,
          xmlFile: vfs.list(dir, ['xml'])[0] ?? null
        }
      },
      onStateChanged: () => () => {}
    },
    settings: {
      load: async () => settings,
      async save(s) {
        settings = s
        saveJson(SETTINGS_KEY, settings)
      },
      get: async (key) => settings[key],
      async set(key, value) {
        settings = { ...settings, [key]: value }
        saveJson(SETTINGS_KEY, settings)
      },
      getAll: async () => settings,
      async reset() {
        settings = createObjectBuilderSettings()
        saveJson(SETTINGS_KEY, settings)
        return settings
      },
      getWindowState: async () => createDefaultWindowState(),
      saveWindowState: async () => {}
    },
    menu: {
      async updateState(state) {
        menuState = { ...menuState, ...state }
      },
      getState: async () => menuState,
      onAction(cb) {
        menuListeners.add(cb)
        if (queuedActions.length > 0) {
          const actions = queuedActions.splice(0)
          setTimeout(() => actions.forEach((a) => cb(a)), 0)
        }
        return () => menuListeners.delete(cb)
      }
    },
    log: {
      async write(level, message) {
        const fn =
          level === 'error' ? console.error : level === 'warning' ? console.warn : console.info
        fn(`[ob] ${message}`)
      },
      getPath: async () => '',
      openFile: async () => {}
    },
    app: {
      onConfirmClose: () => () => {},
      closeConfirmed: async () => {}
    },
    recovery: {
      getData: async () => null,
      clear: async () => {}
    },
    updater: {
      checkForUpdates: async () => {},
      downloadUpdate: async () => {},
      installUpdate: async () => {},
      onStatus: () => () => {}
    },
    web: {
      vfs,
      openFiles(files, source, options) {
        if (files.length === 0) return
        deliverFiles(
          files,
          WEB_ROOT,
          source ?? { kind: 'files', name: 'files', fileNames: files.map((f) => f.name) },
          options?.autoConfirm ?? false
        )
      },
      async pickClientFiles() {
        const picked = await pickClientFileSet()
        if (picked.files.length === 0) return null
        vfs.clear()
        vfs.addAll(picked.files)
        pendingDirectory = null
        currentSource = {
          kind: 'files',
          name: 'files',
          fileNames: picked.files.map((f) => f.name),
          handles: picked.handles
        }
        return WEB_ROOT
      },
      consumePendingDirectory() {
        const dir = pendingDirectory
        pendingDirectory = null
        return dir
      },
      onFilesReady(cb) {
        filesReadyListeners.add(cb)
        return () => filesReadyListeners.delete(cb)
      },
      dispatchMenuAction,
      setSource(source) {
        currentSource = source
      },
      consumeAutoConfirm() {
        const value = autoConfirm
        autoConfirm = false
        return value
      },
      listRecents: () => recents.list().catch(() => []),
      async clearRecents() {
        await recents.clear()
        notifyRecents()
      },
      async removeRecent(id) {
        await recents.remove(id)
        notifyRecents()
      },
      onRecentsChanged(cb) {
        recentsListeners.add(cb)
        return () => recentsListeners.delete(cb)
      },
      async reopenRecent(entry) {
        const source = entry.source
        try {
          if (source.kind === 'directory') {
            if (!(await ensureReadPermission(source.handle))) return 'permission-denied'
            const files = filterClientFiles(await readDirectoryHandle(source.handle))
            deliverFiles(files, `${WEB_ROOT}/${source.name}`, source, true)
            return 'opened'
          }
          if (source.kind === 'files' && source.handles && source.handles.length > 0) {
            for (const h of source.handles) {
              if (!(await ensureReadPermission(h))) return 'permission-denied'
            }
            const files = await Promise.all(source.handles.map((h) => h.getFile()))
            deliverFiles(files, WEB_ROOT, source, true)
            return 'opened'
          }
          if (source.kind === 'files') {
            // No persisted handles (browser without File System Access API): reselect
            const picked = await pickClientFileSet()
            if (picked.files.length === 0) return 'canceled'
            deliverFiles(
              picked.files,
              WEB_ROOT,
              {
                kind: 'files',
                name: 'files',
                fileNames: picked.files.map((f) => f.name),
                handles: picked.handles
              },
              true
            )
            return 'opened'
          }
          const ok = await preloadFromQuery(api, recentPreloadLocation(source.search), true)
          return ok ? 'opened' : 'failed'
        } catch (err) {
          console.error('[ob] reopen failed:', err)
          return 'failed'
        }
      }
    }
  }

  return api
}

function recentPreloadLocation(search: string): Pick<Location, 'search' | 'href' | 'origin'> {
  const here = typeof window !== 'undefined' ? window.location : undefined
  const origin = here?.origin ?? 'http://localhost'
  const base = here ? `${here.origin}${here.pathname}` : `${origin}/`
  return { search, href: `${base}${search}`, origin }
}

/** Installs the web API on `window` plus a global drag-and-drop handler. */
export function installWebApi(): WebApi {
  const api = createWebApi()
  ;(window as unknown as { api: WebApi }).api = api

  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    api.web.openFiles(files)
  })

  void preloadFromQuery(api, window.location)
  return api
}

/**
 * Optional preload for private deployments: `?dat=<url>&spr=<url>[&otfi=<url>]`.
 * Only same-origin URLs are accepted. Assets are never bundled in the build;
 * the deployment decides whether to host them next to index.html.
 */
export async function preloadFromQuery(
  api: WebApi,
  location: Pick<Location, 'search' | 'href' | 'origin'>,
  autoConfirm = false
): Promise<boolean> {
  const params = new URLSearchParams(location.search)
  const entries = (['dat', 'spr', 'otfi'] as const)
    .map((key) => [key, params.get(key)] as const)
    .filter((e): e is readonly ['dat' | 'spr' | 'otfi', string] => !!e[1])
  if (!entries.some(([k]) => k === 'dat') || !entries.some(([k]) => k === 'spr')) return false

  try {
    const files: File[] = []
    for (const [, value] of entries) {
      const url = new URL(value, location.href)
      if (url.origin !== location.origin) throw new Error(`Cross-origin preload refused: ${url}`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to fetch ${url.pathname}: ${res.status}`)
      const name = decodeURIComponent(url.pathname.split('/').pop() || 'file')
      files.push(new File([await res.blob()], name))
    }
    const params2 = new URLSearchParams()
    entries.forEach(([k, v]) => params2.set(k, v))
    const search = `?${params2.toString()}`
    const source: RecentSource = { kind: 'preload', name: search, search }
    api.web.openFiles(files, source, { autoConfirm })
    return true
  } catch (err) {
    console.error('[ob] preload failed:', err)
    return false
  }
}
