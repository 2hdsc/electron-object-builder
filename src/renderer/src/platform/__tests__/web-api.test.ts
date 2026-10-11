import { describe, it, expect, vi } from 'vitest'
import { createWebApi, VirtualFileSystem, WEB_ROOT } from '../web-api'
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
