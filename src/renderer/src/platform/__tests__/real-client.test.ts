/**
 * Integration test against a real client (e.g. NTO 8.60).
 *
 * Skipped unless OB_CLIENT_DIR points to a folder with Tibia.dat + Tibia.spr:
 *   OB_CLIENT_DIR=~/development/2hdsc/otclientv8/data/things/860 npx vitest run real-client
 *
 * Loads the files through the web API (File API path used by the browser build),
 * checks object/sprite counts against the file headers and does a
 * read -> write -> read round-trip of both DAT and SPR. Files are only read.
 */
/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createWebApi, WEB_ROOT } from '../web-api'
import { readDat, writeDat } from '../../services/dat'
import { readSpr, writeSpr, SpriteAccessor } from '../../services/spr'
import { createClientFeatures, ThingCategory } from '../../types'
import { findVersionBySignatures } from '../../data/versions'

const dir = process.env.OB_CLIENT_DIR
const enabled = !!dir && existsSync(join(dir, 'Tibia.dat')) && existsSync(join(dir, 'Tibia.spr'))

function toFile(path: string, name: string): File {
  const buf = readFileSync(path)
  return new File([new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)], name)
}

describe.skipIf(!enabled)('real client files (OB_CLIENT_DIR)', () => {
  it('loads via web API, matches header counts and round-trips DAT/SPR', async () => {
    const api = createWebApi()
    api.web.vfs.addAll([
      toFile(join(dir!, 'Tibia.dat'), 'Tibia.dat'),
      toFile(join(dir!, 'Tibia.spr'), 'Tibia.spr')
    ])
    const discovery = await api.project.discoverClientFiles(WEB_ROOT)
    const datHeader = new DataView(await api.file.readBinary(discovery.datFile!))
    const sprHeader = new DataView(await api.file.readBinary(discovery.sprFile!))
    const version = findVersionBySignatures(
      datHeader.getUint32(0, true),
      sprHeader.getUint32(0, true)
    )
    expect(version, 'client version detected by signatures').toBeDefined()

    const features = createClientFeatures()
    features.extended = version!.value >= 960
    const loaded = await api.project.load({
      datFilePath: discovery.datFile!,
      sprFilePath: discovery.sprFile!,
      versionValue: version!.value,
      datSignature: version!.datSignature,
      sprSignature: version!.sprSignature,
      features: { ...features, metadataController: 'default', attributeServer: null }
    })

    const dur = (_c: ThingCategory): number => 500
    const dat = readDat(loaded.datBuffer, version!.value, features, dur)
    expect(dat.items.length).toBe(dat.maxItemId - 100 + 1)
    expect(dat.outfits.length).toBe(dat.maxOutfitId)
    expect(dat.effects.length).toBe(dat.maxEffectId)
    expect(dat.missiles.length).toBe(dat.maxMissileId)

    const accessor = new SpriteAccessor(loaded.sprBuffer, features.extended)
    const spr = readSpr(loaded.sprBuffer, features.extended)
    expect(accessor.spriteCount).toBe(spr.spriteCount)

    // every sprite referenced by the DAT must exist in the SPR range
    let maxRef = 0
    for (const list of [dat.items, dat.outfits, dat.effects, dat.missiles]) {
      for (const t of list) {
        for (const fg of Object.values(t.frameGroups ?? {})) {
          for (const s of fg?.spriteIndex ?? []) if (s > maxRef) maxRef = s
        }
      }
    }
    expect(maxRef).toBeLessThanOrEqual(spr.spriteCount)

    // DAT round-trip: read -> write -> read yields the same things
    const datBytes = writeDat(dat, version!.value, features)
    const dat2 = readDat(datBytes, version!.value, features, dur)
    expect(dat2.items.length).toBe(dat.items.length)
    expect(dat2.outfits.length).toBe(dat.outfits.length)
    // Items must survive unchanged. For outfits/effects/missiles the writer
    // intentionally drops item-only flags (e.g. pickupable on an outfit), so we
    // only count those and require the writer to be stable after one pass.
    expect(JSON.stringify(dat2.items)).toBe(JSON.stringify(dat.items))
    let normalizedThings = 0
    for (const key of ['outfits', 'effects', 'missiles'] as const) {
      dat[key].forEach((t, i) => {
        const a = dat2[key][i]
        expect(JSON.stringify(a.frameGroups)).toBe(JSON.stringify(t.frameGroups))
        if (JSON.stringify(a) !== JSON.stringify(t)) normalizedThings++
      })
    }
    const datBytes2 = writeDat(dat2, version!.value, features)
    expect(Buffer.from(datBytes2).equals(Buffer.from(datBytes))).toBe(true)

    // SPR round-trip: read -> write -> read yields identical sprite data
    const sprBytes = writeSpr(spr, features.extended)
    const spr2 = readSpr(sprBytes, features.extended)
    expect(spr2.spriteCount).toBe(spr.spriteCount)
    expect(spr2.sprites.size).toBe(spr.sprites.size)
    const mismatched: number[] = []
    for (const [id, data] of spr.sprites) {
      const other = spr2.sprites.get(id)
      if (!other || !Buffer.from(other).equals(Buffer.from(data))) mismatched.push(id)
    }
    expect(mismatched).toEqual([])

    console.info(
      `[real-client] v${version!.valueStr}: items=${dat.items.length} (max id ${dat.maxItemId}), ` +
        `outfits=${dat.outfits.length}, effects=${dat.effects.length}, missiles=${dat.missiles.length}, ` +
        `sprites=${spr.spriteCount} (non-empty ${spr.sprites.size}), maxSpriteRef=${maxRef}, ` +
        `nonItemFlagsNormalized=${normalizedThings}, datByteIdentical=${Buffer.from(datBytes).equals(Buffer.from(loaded.datBuffer))}`
    )
  }, 120_000)
})
