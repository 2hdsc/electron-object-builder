import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WebMenuBar } from '../WebMenuBar'
import { createWebApi, type WebApi } from '../../platform/web-api'
import type { RecentEntry } from '../../platform/web-recents'
import { MENU_FILE_OPEN } from '../../../../shared/menu-actions'

const entry: RecentEntry = {
  id: 'preload:x',
  label: 'nto860',
  detail: '8.60',
  openedAt: 1,
  source: { kind: 'preload', name: 'x', search: '?dat=nto860/Tibia.dat&spr=nto860/Tibia.spr' }
}

let api: WebApi
const original = window.api
beforeEach(() => {
  api = createWebApi()
  api.web.listRecents = vi.fn(async () => [entry])
  ;(window as unknown as { api: WebApi }).api = api
})
afterEach(() => {
  ;(window as unknown as { api: unknown }).api = original
})

describe('WebMenuBar', () => {
  it('renders the menus and dispatches actions', () => {
    const onAction = vi.fn()
    render(<WebMenuBar onAction={onAction} />)
    fireEvent.click(screen.getByTestId('web-menu-file'))
    fireEvent.click(screen.getByTestId(`web-menu-item-${MENU_FILE_OPEN}`))
    expect(onAction).toHaveBeenCalledWith(MENU_FILE_OPEN)
    expect(screen.getByTestId('web-menu-view')).toBeInTheDocument()
    expect(screen.getByTestId('web-menu-help')).toBeInTheDocument()
  })

  it('lists recents and reopens the clicked entry', async () => {
    const reopen = vi.fn(async () => 'opened' as const)
    api.web.reopenRecent = reopen
    render(<WebMenuBar onAction={vi.fn()} />)
    fireEvent.click(screen.getByTestId('web-menu-file'))
    fireEvent.click(screen.getByTestId('web-menu-recent'))
    const item = await screen.findByTestId('web-menu-recent-item')
    expect(item).toHaveTextContent('nto860')
    expect(item).toHaveTextContent('v8.60')
    fireEvent.click(item)
    await waitFor(() => expect(reopen).toHaveBeenCalledWith(entry))
  })

  it('disables client-only actions when nothing is loaded', () => {
    render(<WebMenuBar onAction={vi.fn()} />)
    fireEvent.click(screen.getByTestId('web-menu-file'))
    expect(screen.getByTestId('web-menu-item-fileCompile')).toBeDisabled()
  })
})
