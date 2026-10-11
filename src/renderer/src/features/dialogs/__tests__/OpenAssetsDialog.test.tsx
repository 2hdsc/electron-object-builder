import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { OpenAssetsDialog } from '../OpenAssetsDialog'
import { createWebApi, type WebApi } from '../../../platform/web-api'

/** Minimal 8.60 v2 headers: DAT sig + 4 counts, SPR sig + u16 count */
function datFile(): File {
  const b = new DataView(new ArrayBuffer(12))
  b.setUint32(0, 0x4c2c7993, true)
  b.setUint16(4, 10842, true)
  b.setUint16(6, 1089, true)
  b.setUint16(8, 354, true)
  b.setUint16(10, 61, true)
  return new File([b.buffer], 'Tibia.dat')
}
function sprFile(): File {
  const b = new DataView(new ArrayBuffer(6))
  b.setUint32(0, 0x4c220594, true)
  b.setUint16(4, 58384, true)
  return new File([b.buffer], 'Tibia.spr')
}

let api: WebApi
const original = window.api

beforeEach(() => {
  api = createWebApi()
  ;(window as unknown as { api: WebApi }).api = api
})
afterEach(() => {
  ;(window as unknown as { api: unknown }).api = original
})

const renderDialog = (): void => {
  render(<OpenAssetsDialog open onClose={vi.fn()} onConfirm={vi.fn()} />)
}

describe('OpenAssetsDialog (web build)', () => {
  it('auto-fills with files preloaded/dropped before the dialog opened', async () => {
    api.web.vfs.addAll([datFile(), sprFile()])
    // simulate preload having finished: files pending
    api.web.openFiles([datFile(), sprFile()])
    renderDialog()
    await waitFor(() => expect(screen.getByText('8.60 v2')).toBeInTheDocument())
    expect(screen.getByText('58384')).toBeInTheDocument()
  })

  it('auto-fills when files arrive while the dialog is already open', async () => {
    renderDialog()
    act(() => api.web.openFiles([datFile(), sprFile()]))
    await waitFor(() => expect(screen.getByText('8.60 v2')).toBeInTheDocument())
  })

  it('explains that both files are needed when only one was selected', async () => {
    renderDialog()
    act(() => api.web.openFiles([datFile()]))
    await waitFor(() =>
      expect(screen.getByText(/Only Tibia\.dat was found\. Select both/)).toBeInTheDocument()
    )
  })

  it('shows the "Select files" button only in the web build', () => {
    renderDialog()
    expect(screen.getByTestId('select-client-files')).toBeInTheDocument()
  })
})
