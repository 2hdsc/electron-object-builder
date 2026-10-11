import { describe, it, expect, vi } from 'vitest'
import { createWebApi, filterClientFiles, pickDirectory, WEB_ROOT } from '../web-api'
import { MENU_FILE_OPEN } from '../../../../shared/menu-actions'

const file = (name: string): File => new File([new Uint8Array([1])], name)

describe('web folder / file picking', () => {
  it('filterClientFiles keeps only client and server-item files', () => {
    const names = filterClientFiles([
      file('Tibia.dat'),
      file('Tibia.spr'),
      file('Tibia.pic'),
      file('items.otb'),
      file('notes.txt')
    ]).map((f) => f.name)
    expect(names).toEqual(['Tibia.dat', 'Tibia.spr', 'items.otb'])
  })

  it('pickDirectory uses showDirectoryPicker when available (top-level files only)', async () => {
    const entries = [
      { kind: 'file', name: 'Tibia.dat', getFile: async () => file('Tibia.dat') },
      { kind: 'directory', name: 'sub' },
      { kind: 'file', name: 'Tibia.spr', getFile: async () => file('Tibia.spr') }
    ]
    const win = {
      showDirectoryPicker: vi.fn(async () => ({
        name: '860',
        async *values() {
          yield* entries
        }
      }))
    } as unknown as Window
    const picked = await pickDirectory(win)
    expect(picked?.name).toBe('860')
    expect(picked?.files.map((f) => f.name)).toEqual(['Tibia.dat', 'Tibia.spr'])
  })

  it('pickDirectory returns null when the picker is canceled', async () => {
    const win = {
      showDirectoryPicker: vi.fn(async () => {
        throw new DOMException('canceled', 'AbortError')
      })
    } as unknown as Window
    expect(await pickDirectory(win)).toBeNull()
  })

  it('showDirectoryDialog loads the picked folder into a virtual dir named after it', async () => {
    const original = (window as { showDirectoryPicker?: unknown }).showDirectoryPicker
    ;(window as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => ({
      name: '860',
      async *values() {
        yield { kind: 'file', name: 'Tibia.dat', getFile: async () => file('Tibia.dat') }
        yield { kind: 'file', name: 'Tibia.spr', getFile: async () => file('Tibia.spr') }
        yield { kind: 'file', name: 'Tibia.pic', getFile: async () => file('Tibia.pic') }
      }
    })
    try {
      const api = createWebApi()
      const res = await api.file.showDirectoryDialog()
      expect(res).toEqual({ canceled: false, directoryPath: `${WEB_ROOT}/860` })
      expect(await api.project.discoverClientFiles(`${WEB_ROOT}/860`)).toEqual({
        datFile: '/web/860/Tibia.dat',
        sprFile: '/web/860/Tibia.spr',
        otfiFile: null
      })
    } finally {
      ;(window as { showDirectoryPicker?: unknown }).showDirectoryPicker = original
    }
  })

  it('openFiles notifies an open dialog directly instead of re-dispatching the menu action', () => {
    const api = createWebApi()
    const onAction = vi.fn()
    api.menu.onAction(onAction)
    const ready = vi.fn()
    const off = api.web.onFilesReady(ready)

    api.web.openFiles([file('Tibia.dat'), file('Tibia.spr')])
    expect(ready).toHaveBeenCalledWith(WEB_ROOT)
    expect(onAction).not.toHaveBeenCalled()
    expect(api.web.consumePendingDirectory()).toBe(WEB_ROOT)
    expect(api.web.consumePendingDirectory()).toBeNull()

    off()
    api.web.openFiles([file('Tibia.dat'), file('Tibia.spr')])
    expect(onAction).toHaveBeenCalledWith(MENU_FILE_OPEN)
  })
})
