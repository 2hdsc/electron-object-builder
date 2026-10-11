import { describe, it, expect, vi } from 'vitest'
import { createWebApi, preloadFromQuery, VirtualFileSystem, WEB_ROOT } from '../web-api'
import { MENU_FILE_OPEN } from '../../../../shared/menu-actions'

function file(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name)
}

describe('VirtualFileSystem', () => {
  it('lists files by directory and extension', () => {
    const vfs = new VirtualFileSystem()
    vfs.addAll([file('Tibia.dat', [1]), file('Tibia.spr', [2]), file('Tibia.otfi', [3])])
    expect(vfs.list(WEB_ROOT, ['dat'])).toEqual(['/web/Tibia.dat'])
    expect(vfs.list(WEB_ROOT, ['.SPR'])).toEqual(['/web/Tibia.spr'])
    expect(vfs.list(WEB_ROOT)).toHaveLength(3)
    expect(vfs.list('/other')).toEqual([])
  })
})

describe('createWebApi', () => {
  it('discovers client files and loads buffers from the virtual FS', async () => {
    const api = createWebApi()
    api.web.vfs.addAll([
      file('Tibia.dat', [1, 2, 3]),
      file('Tibia.spr', [4, 5]),
      file('Tibia.otfi', [...new TextEncoder().encode('DatSpr\n')])
    ])

    const discovery = await api.project.discoverClientFiles(WEB_ROOT)
    expect(discovery).toEqual({
      datFile: '/web/Tibia.dat',
      sprFile: '/web/Tibia.spr',
      otfiFile: '/web/Tibia.otfi'
    })

    const result = await api.project.load({
      datFilePath: discovery.datFile!,
      sprFilePath: discovery.sprFile!,
      versionValue: 860,
      datSignature: 0,
      sprSignature: 0,
      features: {
        extended: false,
        transparency: false,
        improvedAnimations: false,
        frameGroups: false,
        metadataController: 'default',
        attributeServer: null
      }
    })
    expect(Array.from(new Uint8Array(result.datBuffer))).toEqual([1, 2, 3])
    expect(Array.from(new Uint8Array(result.sprBuffer))).toEqual([4, 5])
    expect(result.otfiContent).toBe('DatSpr\n')
    expect(result.otbBuffer).toBeNull()
    expect(await api.project.isLoaded()).toBe(true)
  })

  it('openFiles registers files, opens the dialog and serves them to the next directory dialog', async () => {
    const api = createWebApi()
    const onAction = vi.fn()
    api.menu.onAction(onAction)

    api.web.openFiles([file('Tibia.dat', [1]), file('Tibia.spr', [2])])
    expect(onAction).toHaveBeenCalledWith(MENU_FILE_OPEN)

    const dir = await api.file.showDirectoryDialog()
    expect(dir).toEqual({ canceled: false, directoryPath: WEB_ROOT })
    expect(await api.file.exists('/web/Tibia.dat')).toBe(true)
    expect(await api.file.findInDirectory(WEB_ROOT, 'tibia.SPR')).toBe('/web/Tibia.spr')
  })

  it('persists settings in localStorage', async () => {
    const api = createWebApi()
    await api.settings.set('deleteAfterPaste', true)
    expect(await api.settings.get('deleteAfterPaste')).toBe(true)
    expect(await createWebApi().settings.get('deleteAfterPaste')).toBe(true)
    await api.settings.reset()
  })
})

describe('preloadFromQuery', () => {
  const loc = (search: string) => ({
    search,
    href: `https://example.test/ob/${search}`,
    origin: 'https://example.test'
  })

  it('fetches same-origin dat/spr and queues the open dialog until the app subscribes', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new Uint8Array([7])))
    const api = createWebApi()
    const ok = await preloadFromQuery(api, loc('?dat=nto/Tibia.dat&spr=nto/Tibia.spr'))
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(api.web.vfs.list(WEB_ROOT)).toEqual(['/web/Tibia.dat', '/web/Tibia.spr'])

    const onAction = vi.fn()
    api.menu.onAction(onAction)
    await new Promise((r) => setTimeout(r, 0))
    expect(onAction).toHaveBeenCalledWith(MENU_FILE_OPEN)
    fetchMock.mockRestore()
  })

  it('refuses cross-origin URLs and ignores incomplete params', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const api = createWebApi()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await preloadFromQuery(api, loc('?dat=https://evil.test/a.dat&spr=b.spr'))).toBe(false)
    expect(await preloadFromQuery(api, loc('?dat=a.dat'))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })
})
