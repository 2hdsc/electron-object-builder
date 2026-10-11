/**
 * Desktop-style menu bar for the web build (Electron uses the native menu).
 * Mirrors the structure of src/main/services/menu-service.ts and dispatches
 * the same MenuAction ids, plus a File > Recent submenu backed by IndexedDB.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MENU_FILE_NEW,
  MENU_FILE_OPEN,
  MENU_FILE_COMPILE,
  MENU_FILE_COMPILE_AS,
  MENU_FILE_CLOSE,
  MENU_FILE_MERGE,
  MENU_FILE_PREFERENCES,
  MENU_VIEW_SHOW_PREVIEW,
  MENU_VIEW_SHOW_OBJECTS,
  MENU_VIEW_SHOW_SPRITES,
  MENU_TOOLS_FIND,
  MENU_TOOLS_LOOK_TYPE_GENERATOR,
  MENU_TOOLS_OBJECT_VIEWER,
  MENU_TOOLS_SLICER,
  MENU_TOOLS_ANIMATION_EDITOR,
  MENU_TOOLS_SPRITES_OPTIMIZER,
  MENU_TOOLS_FRAME_DURATIONS_OPTIMIZER,
  MENU_TOOLS_FRAME_GROUPS_CONVERTER,
  MENU_WINDOW_LOG,
  MENU_WINDOW_VERSIONS,
  MENU_HELP_ABOUT
} from '../../../shared/menu-actions'
import type { MenuAction } from '../../../shared/menu-actions'
import { useAppStore } from '../stores'
import type { WebApi } from '../platform/web-api'
import type { RecentEntry } from '../platform/web-recents'

type Item =
  | { type: 'action'; label: string; action: MenuAction; shortcut?: string; needsClient?: boolean }
  | { type: 'recent' }
  | { type: 'separator' }

interface Menu {
  id: string
  label: string
  items: Item[]
}

const sep: Item = { type: 'separator' }

export function buildWebMenus(t: (key: string, fallback: string) => string): Menu[] {
  const a = (
    label: string,
    action: MenuAction,
    extra: { shortcut?: string; needsClient?: boolean } = {}
  ): Item => ({ type: 'action', label, action, ...extra })
  return [
    {
      id: 'file',
      label: t('menu.file', 'File'),
      items: [
        a(t('menu.new', 'New'), MENU_FILE_NEW, { shortcut: '⌘N' }),
        a(t('menu.open', 'Open'), MENU_FILE_OPEN, { shortcut: '⌘O' }),
        { type: 'recent' },
        sep,
        a(t('menu.compile', 'Compile'), MENU_FILE_COMPILE, { needsClient: true }),
        a(t('menu.compileAs', 'Compile As...'), MENU_FILE_COMPILE_AS, { needsClient: true }),
        a(t('menu.close', 'Close'), MENU_FILE_CLOSE, { needsClient: true }),
        a(t('menu.merge', 'Merge...'), MENU_FILE_MERGE, { needsClient: true }),
        sep,
        a(t('menu.preferences', 'Preferences'), MENU_FILE_PREFERENCES)
      ]
    },
    {
      id: 'view',
      label: t('menu.view', 'View'),
      items: [
        a(t('menu.showPreviewPanel', 'Show Preview Panel'), MENU_VIEW_SHOW_PREVIEW, {
          shortcut: 'F2'
        }),
        a(t('menu.showObjectsPanel', 'Show Objects Panel'), MENU_VIEW_SHOW_OBJECTS, {
          shortcut: 'F3'
        }),
        a(t('menu.showSpritesPanel', 'Show Sprites Panel'), MENU_VIEW_SHOW_SPRITES, {
          shortcut: 'F4'
        })
      ]
    },
    {
      id: 'tools',
      label: t('menu.tools', 'Tools'),
      items: [
        a('Find', MENU_TOOLS_FIND, { needsClient: true }),
        a(t('menu.toolsLookTypeGenerator', 'LookType Generator'), MENU_TOOLS_LOOK_TYPE_GENERATOR),
        a('Object Viewer', MENU_TOOLS_OBJECT_VIEWER),
        a('Slicer', MENU_TOOLS_SLICER),
        a('Animation Editor', MENU_TOOLS_ANIMATION_EDITOR),
        sep,
        a('Sprites Optimizer', MENU_TOOLS_SPRITES_OPTIMIZER, { needsClient: true }),
        a('Frame Durations Optimizer', MENU_TOOLS_FRAME_DURATIONS_OPTIMIZER, { needsClient: true }),
        a('Frame Groups Converter', MENU_TOOLS_FRAME_GROUPS_CONVERTER, { needsClient: true })
      ]
    },
    {
      id: 'window',
      label: t('menu.window', 'Window'),
      items: [
        a(t('menu.logWindow', 'Log Window'), MENU_WINDOW_LOG),
        a(t('menu.versions', 'Versions'), MENU_WINDOW_VERSIONS)
      ]
    },
    {
      id: 'help',
      label: t('menu.help', 'Help'),
      items: [a(`${t('menu.about', 'About')} Object Builder`, MENU_HELP_ABOUT)]
    }
  ]
}

function getWeb(): WebApi['web'] | undefined {
  return (window.api as Partial<WebApi> | undefined)?.web
}

interface WebMenuBarProps {
  onAction: (action: MenuAction) => void
}

export function WebMenuBar({ onAction }: WebMenuBarProps): React.JSX.Element {
  const { t } = useTranslation()
  const tr = useCallback((key: string, fallback: string) => t(key, { defaultValue: fallback }), [t])
  const clientLoaded = useAppStore((s) => s.clientInfo?.loaded ?? false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [recentOpen, setRecentOpen] = useState(false)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const refreshRecents = useCallback(() => {
    const web = getWeb()
    if (web) void web.listRecents().then(setRecents)
  }, [])

  useEffect(() => {
    refreshRecents()
    return getWeb()?.onRecentsChanged(refreshRecents)
  }, [refreshRecents])

  const close = useCallback((): void => {
    setOpenMenu(null)
    setRecentOpen(false)
  }, [])

  // Close on outside click / Escape
  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openMenu, close])

  const runAction = (action: MenuAction): void => {
    close()
    onAction(action)
  }

  const reopen = async (entry: RecentEntry): Promise<void> => {
    close()
    const web = getWeb()
    if (!web) return
    if (entry.source.kind === 'files' && !entry.source.handles?.length) {
      setNotice(
        tr(
          'menu.recentReselect',
          'Select {{files}} again (the browser could not keep access to them).'
        ).replace('{{files}}', entry.label)
      )
    }
    const result = await web.reopenRecent(entry)
    if (result === 'opened' || result === 'canceled') setNotice(null)
    else if (result === 'permission-denied')
      setNotice(
        tr('menu.recentDenied', 'Permission denied. Use File > Open to pick the folder again.')
      )
    else setNotice(tr('menu.recentFailed', 'Could not reopen this entry. Use File > Open.'))
  }

  const menus = buildWebMenus(tr)

  return (
    <div
      ref={barRef}
      className="relative flex h-7 shrink-0 select-none items-center gap-0.5 border-b border-border bg-bg-secondary px-2 text-xs text-text-primary"
      data-testid="web-menubar"
      role="menubar"
    >
      {menus.map((menu) => (
        <div key={menu.id} className="relative">
          <button
            type="button"
            role="menuitem"
            data-testid={`web-menu-${menu.id}`}
            className={`rounded px-2.5 py-1 ${openMenu === menu.id ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`}
            onClick={() => {
              setRecentOpen(false)
              setOpenMenu(openMenu === menu.id ? null : menu.id)
            }}
            onMouseEnter={() => {
              if (openMenu && openMenu !== menu.id) {
                setRecentOpen(false)
                setOpenMenu(menu.id)
              }
            }}
          >
            {menu.label}
          </button>

          {openMenu === menu.id && (
            <div
              role="menu"
              className="absolute left-0 top-full z-50 mt-0.5 min-w-[220px] rounded-md border border-border bg-bg-tertiary py-1 shadow-lg"
            >
              {menu.items.map((item, i) => {
                if (item.type === 'separator')
                  return <div key={i} className="my-1 border-t border-border" />
                if (item.type === 'recent')
                  return (
                    <div
                      key={i}
                      className="relative"
                      onMouseEnter={() => {
                        refreshRecents()
                        setRecentOpen(true)
                      }}
                      onMouseLeave={() => setRecentOpen(false)}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="web-menu-recent"
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-bg-hover"
                        onClick={() => {
                          refreshRecents()
                          setRecentOpen((v) => !v)
                        }}
                      >
                        <span>{tr('menu.recent', 'Open Recent')}</span>
                        <span className="text-text-secondary">▸</span>
                      </button>
                      {recentOpen && (
                        <div
                          role="menu"
                          data-testid="web-menu-recent-list"
                          className="absolute left-full top-0 z-50 -ml-0.5 min-w-[280px] rounded-md border border-border bg-bg-tertiary py-1 shadow-lg"
                        >
                          {recents.length === 0 && (
                            <div className="px-3 py-1.5 text-text-secondary">
                              {tr('menu.noRecent', 'No recent files')}
                            </div>
                          )}
                          {recents.map((entry) => (
                            <button
                              key={entry.id}
                              type="button"
                              role="menuitem"
                              data-testid="web-menu-recent-item"
                              className="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left hover:bg-bg-hover"
                              onClick={() => void reopen(entry)}
                              title={entry.source.kind}
                            >
                              <span className="truncate">{entry.label}</span>
                              <span className="shrink-0 text-text-secondary">
                                {entry.detail ? `v${entry.detail}` : ''}
                                {entry.source.kind === 'preload' ? ' · URL' : ''}
                                {entry.source.kind === 'directory' ? ' · folder' : ''}
                              </span>
                            </button>
                          ))}
                          {recents.length > 0 && (
                            <>
                              <div className="my-1 border-t border-border" />
                              <button
                                type="button"
                                role="menuitem"
                                data-testid="web-menu-recent-clear"
                                className="w-full px-3 py-1.5 text-left hover:bg-bg-hover"
                                onClick={() => {
                                  close()
                                  void getWeb()?.clearRecents()
                                }}
                              >
                                {tr('menu.clearRecent', 'Clear Recent')}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                const disabled = item.needsClient && !clientLoaded
                return (
                  <button
                    key={i}
                    type="button"
                    role="menuitem"
                    disabled={disabled}
                    data-testid={`web-menu-item-${item.action}`}
                    className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left hover:bg-bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                    onClick={() => runAction(item.action)}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="text-text-secondary">{item.shortcut}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ))}

      {notice && (
        <div
          className="ml-auto flex items-center gap-2 text-text-secondary"
          data-testid="web-menu-notice"
        >
          <span>{notice}</span>
          <button type="button" className="hover:text-text-primary" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
