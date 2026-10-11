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
    openFiles(files: File[]): void
    dispatchMenuAction(action: MenuAction): void
  }
}

export function createWebApi(vfs = new VirtualFileSystem()): WebApi {
  const menuListeners = new Set<(action: MenuAction) => void>()
  let menuState: MenuState = createDefaultMenuState()
  let projectState: ProjectState = createProjectState()
  let settings: ObjectBuilderSettings = loadJson(SETTINGS_KEY, createObjectBuilderSettings())
  let recent: Record<string, string | null> = loadJson(RECENT_KEY, {})
  /** Files dropped/opened outside the dialog, consumed by the next directory dialog. */
  let pendingDirectory: string | null = null

  const dispatchMenuAction = (action: MenuAction): void => {
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
        // Browsers can't hand out a directory path: let the user pick the
        // client files (Tibia.dat + Tibia.spr, optionally .otfi/.otb/.xml).
        const files = await pickFiles('.dat,.spr,.otfi,.otb,.xml', true)
        if (files.length === 0) return { canceled: true, directoryPath: null }
        vfs.clear()
        vfs.addAll(files)
        return { canceled: false, directoryPath: WEB_ROOT }
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
      openFiles(files) {
        if (files.length === 0) return
        vfs.clear()
        vfs.addAll(files)
        pendingDirectory = WEB_ROOT
        dispatchMenuAction(MENU_FILE_OPEN as MenuAction)
      },
      dispatchMenuAction
    }
  }

  return api
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
  return api
}
