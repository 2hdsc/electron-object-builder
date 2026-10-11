import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, it, expect, vi } from 'vitest'
import { RecentsStore, MAX_RECENTS, recentLabel, ensureReadPermission } from '../web-recents'
import { createWebApi, WEB_ROOT } from '../web-api'

const file = (name: string): File => new File([new Uint8Array([1])], name)
const store = (): RecentsStore => new RecentsStore(new IDBFactory())

describe('RecentsStore (IndexedDB)', () => {
  it('adds, dedupes (moves to top) and lists newest first', async () => {
    const s = store()
    await s.add(
      { kind: 'preload', name: 'a', search: '?dat=nto860/Tibia.dat&spr=nto860/Tibia.spr' },
      '8.60',
      1
    )
    await s.add({ kind: 'files', name: 'f', fileNames: ['Tibia.dat', 'Tibia.spr'] }, '8.60', 2)
    await s.add(
      { kind: 'preload', name: 'a', search: '?dat=nto860/Tibia.dat&spr=nto860/Tibia.spr' },
      '8.60',
      3
    )
    const list = await s.list()
    expect(list).toHaveLength(2)
    expect(list[0].source.kind).toBe('preload')
    expect(list[0].label).toBe('nto860')
    expect(list[1].label).toBe('Tibia.dat + Tibia.spr')
  })

  it(`keeps at most ${MAX_RECENTS} entries`, async () => {
    const s = store()
    for (let i = 0; i < MAX_RECENTS + 3; i++) {
      await s.add(
        { kind: 'preload', name: String(i), search: `?dat=${i}.dat&spr=${i}.spr` },
        undefined,
        i
      )
    }
    const list = await s.list()
    expect(list).toHaveLength(MAX_RECENTS)
    expect(list[0].openedAt).toBe(MAX_RECENTS + 2)
  })

  it('removes and clears', async () => {
    const s = store()
    const e = await s.add({ kind: 'files', name: 'f', fileNames: ['x.dat', 'x.spr'] })
    await s.remove(e.id)
    expect(await s.list()).toEqual([])
    await s.add({ kind: 'files', name: 'f', fileNames: ['x.dat', 'x.spr'] })
    await s.clear()
    expect(await s.list()).toEqual([])
  })

  it('labels directories by name', () => {
    expect(
      recentLabel({
        kind: 'directory',
        name: '860',
        handle: { name: '860', values: async function* () {} }
      })
    ).toBe('860')
  })
})

describe('ensureReadPermission', () => {
  it('returns true when already granted and requests otherwise', async () => {
    expect(await ensureReadPermission({ name: 'x', queryPermission: async () => 'granted' })).toBe(
      true
    )
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    expect(
      await ensureReadPermission({
        name: 'x',
        queryPermission: async () => 'prompt',
        requestPermission
      })
    ).toBe(true)
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' })
    expect(
      await ensureReadPermission({
        name: 'x',
        queryPermission: async () => 'prompt',
        requestPermission: async () => 'denied'
      })
    ).toBe(false)
  })
})

describe('web api recents', () => {
  const loadParams = (dir = WEB_ROOT) => ({
    datFilePath: `${dir}/Tibia.dat`,
    sprFilePath: `${dir}/Tibia.spr`,
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

  it('records the source as recent when a project is loaded', async () => {
    const api = createWebApi(undefined, store())
    const changed = vi.fn()
    api.web.onRecentsChanged(changed)
    api.web.openFiles([file('Tibia.dat'), file('Tibia.spr')], {
      kind: 'preload',
      name: 'p',
      search: '?dat=nto860/Tibia.dat&spr=nto860/Tibia.spr'
    })
    await api.project.load(loadParams())
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    const list = await api.web.listRecents()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'nto860', detail: '8.60' })
  })

  it('reopens a directory entry after re-requesting permission and auto-confirms', async () => {
    const api = createWebApi(undefined, store())
    const ready = vi.fn()
    api.web.onFilesReady(ready)
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    const handle = {
      name: '860',
      queryPermission: async () => 'prompt' as PermissionState,
      requestPermission,
      async *values() {
        yield { kind: 'file', name: 'Tibia.dat', getFile: async () => file('Tibia.dat') }
        yield { kind: 'file', name: 'Tibia.spr', getFile: async () => file('Tibia.spr') }
        yield { kind: 'file', name: 'Tibia.pic', getFile: async () => file('Tibia.pic') }
      }
    }
    const result = await api.web.reopenRecent({
      id: 'directory:860',
      label: '860',
      openedAt: 1,
      source: { kind: 'directory', name: '860', handle }
    })
    expect(result).toBe('opened')
    expect(requestPermission).toHaveBeenCalled()
    expect(ready).toHaveBeenCalledWith('/web/860')
    expect(api.web.vfs.list('/web/860')).toEqual(['/web/860/Tibia.dat', '/web/860/Tibia.spr'])
    expect(api.web.consumePendingDirectory()).toBe('/web/860')
    expect(api.web.consumeAutoConfirm()).toBe(true)
  })

  it('reports permission-denied for a directory the user refuses', async () => {
    const api = createWebApi(undefined, store())
    const handle = {
      name: '860',
      queryPermission: async () => 'prompt' as PermissionState,
      requestPermission: async () => 'denied' as PermissionState,
      async *values() {}
    }
    expect(
      await api.web.reopenRecent({
        id: 'd',
        label: '860',
        openedAt: 1,
        source: { kind: 'directory', name: '860', handle }
      })
    ).toBe('permission-denied')
  })

  it('reopens a preload entry by fetching the stored URL params again', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new Uint8Array([7])))
    const api = createWebApi(undefined, store())
    const result = await api.web.reopenRecent({
      id: 'p',
      label: 'nto860',
      openedAt: 1,
      source: { kind: 'preload', name: 'p', search: '?dat=nto860/Tibia.dat&spr=nto860/Tibia.spr' }
    })
    expect(result).toBe('opened')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(api.web.vfs.list(WEB_ROOT)).toEqual(['/web/Tibia.dat', '/web/Tibia.spr'])
    expect(api.web.consumeAutoConfirm()).toBe(true)
    fetchMock.mockRestore()
  })
})
