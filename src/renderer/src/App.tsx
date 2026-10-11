/**
 * Root application component.
 * Composes the main layout: Toolbar, SplitPane (3 resizable panels),
 * LogPanel (collapsible), and StatusBar.
 *
 * Handles menu action routing from both the native menu (via IPC)
 * and the toolbar buttons. Manages dialog open/close state.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  MENU_FILE_NEW,
  MENU_FILE_OPEN,
  MENU_FILE_COMPILE_AS,
  MENU_FILE_MERGE,
  MENU_FILE_PREFERENCES,
  MENU_WINDOW_LOG,
  MENU_VIEW_SHOW_PREVIEW,
  MENU_VIEW_SHOW_OBJECTS,
  MENU_VIEW_SHOW_SPRITES,
  MENU_HELP_ABOUT,
  MENU_TOOLS_FIND,
  MENU_TOOLS_ANIMATION_EDITOR,
  MENU_TOOLS_ASSET_STORE,
  MENU_TOOLS_OBJECT_VIEWER,
  MENU_TOOLS_SLICER,
  MENU_TOOLS_LOOK_TYPE_GENERATOR,
  MENU_TOOLS_SPRITES_OPTIMIZER,
  MENU_TOOLS_FRAME_DURATIONS_OPTIMIZER,
  MENU_TOOLS_FRAME_GROUPS_CONVERTER,
  type MenuAction
} from '../../shared/menu-actions'
import type { LoadProjectParams } from '../../shared/project-state'
import { useAppStore, useEditorStore, useSpriteStore, selectUI } from './stores'
import { FrameGroupType } from './types/animation'
import {
  ThingCategory,
  type ClientFeatures,
  type ClientInfo,
  createClientInfo,
  ClipboardAction
} from './types'
import type { ThingData } from './types/things'
import { getDefaultDuration } from './types/settings'
import { Toolbar } from './components/Toolbar'
import { WebMenuBar } from './components/WebMenuBar'
import { Modal, DialogButton } from './components/Modal'
import { SplitPane } from './components/SplitPane'
import { StatusBar } from './components/StatusBar'
import { LogPanel } from './components/LogPanel'
import { ThingListPanel, type ThingListAction } from './features/things'
import { ThingTypeEditor } from './features/editor'
import { SpritePanel } from './features/sprites'
import { PreviewPanel } from './features/preview'
import { AnimationEditorDialog } from './features/animation'
import { ObjectViewerDialog } from './features/viewer'
import { SlicerDialog } from './features/slicer'
import { AssetStoreDialog } from './features/store'
import { LookTypeGeneratorDialog } from './features/looktype'
import { SpritesOptimizerDialog, FrameDurationsOptimizerDialog } from './features/optimizer'
import { FrameGroupsConverterDialog } from './features/converter'
import {
  CreateAssetsDialog,
  OpenAssetsDialog,
  CompileAssetsDialog,
  MergeAssetsDialog,
  PreferencesDialog,
  AboutDialog,
  ErrorDialog,
  FindDialog,
  ExportDialog,
  ImportThingDialog,
  BulkEditDialog,
  type CreateAssetsResult,
  type OpenAssetsResult,
  type CompileAssetsResult,
  type MergeAssetsResult,
  type FindThingFilters,
  type FindSpriteFilters,
  type ExportDialogResult,
  type ImportThingResult,
  type BulkEditResult
} from './features/dialogs'
import type { ObjectBuilderSettings } from '../../shared/settings'
import { readOtb } from './services/otb'
import { readItemsXml } from './services/items-xml'
import { parseOtfi } from './services/otfi'
import { clearThumbnailCache } from './hooks/use-sprite-thumbnail'
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts'
import { workerService } from './workers/worker-service'
import { useTheme } from './providers/ThemeProvider'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'

// ---------------------------------------------------------------------------
// Dialog state type
// ---------------------------------------------------------------------------

type ActiveDialog =
  | 'create'
  | 'open'
  | 'compileAs'
  | 'merge'
  | 'preferences'
  | 'about'
  | 'error'
  | 'find'
  | 'export'
  | 'import'
  | 'bulkEdit'
  | 'animationEditor'
  | 'objectViewer'
  | 'slicer'
  | 'assetStore'
  | 'lookTypeGenerator'
  | 'spritesOptimizer'
  | 'frameDurationsOptimizer'
  | 'frameGroupsConverter'
  | 'confirmClose'
  | 'confirmThingSwitch'
  | 'recovery'
  | null

interface RecoveryInfo {
  datFilePath: string
  sprFilePath: string
  versionValue: number
  serverItemsPath: string | null
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const ui = useAppStore(selectUI)
  const setPanelWidth = useAppStore((s) => s.setPanelWidth)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const selectedThingId = useAppStore((s) => s.selectedThingId)
  const currentCategory = useAppStore((s) => s.currentCategory)
  const clientInfo = useAppStore((s) => s.clientInfo)
  const getThingById = useAppStore((s) => s.getThingById)
  const addLog = useAppStore((s) => s.addLog)
  const setEditingThingData = useEditorStore((s) => s.setEditingThingData)
  const { setTheme } = useTheme()
  const [logHeight, setLogHeight] = useState(150)
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null)
  const [errorMessages, setErrorMessages] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadingLabel, setLoadingLabel] = useState('')
  const pendingCloseRef = useRef(false)
  const [recoveryInfo, setRecoveryInfo] = useState<RecoveryInfo | null>(null)

  // Global keyboard shortcuts (undo/redo)
  useKeyboardShortcuts({ dialogOpen: activeDialog !== null })

  // -------------------------------------------------------------------------
  // Close confirmation: main process asks renderer before closing the window
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!window.api?.app?.onConfirmClose) return
    return window.api.app.onConfirmClose(() => {
      const { project } = useAppStore.getState()
      if (project.loaded && project.changed) {
        // Project has unsaved changes — show confirmation dialog
        pendingCloseRef.current = true
        setActiveDialog('confirmClose')
      } else {
        // No unsaved changes — close immediately
        window.api.app.closeConfirmed()
      }
    })
  }, [])

  // Check for recovery data from a previous crashed session on startup
  useEffect(() => {
    if (!window.api?.recovery?.getData) return
    window.api.recovery.getData().then((data) => {
      if (data) {
        setRecoveryInfo({
          datFilePath: data.datFilePath,
          sprFilePath: data.sprFilePath,
          versionValue: data.versionValue,
          serverItemsPath: data.serverItemsPath
        })
        setActiveDialog('recovery')
      }
    })
  }, [])

  // Bridge: write log entries to persistent file via IPC
  useEffect(() => {
    let lastLogCount = useAppStore.getState().logs.length
    const unsubscribe = useAppStore.subscribe((state) => {
      const logs = state.logs
      if (!window.api?.log || logs.length <= lastLogCount) {
        lastLogCount = logs.length
        return
      }
      // Write only new entries (appended at the end)
      for (let i = lastLogCount; i < logs.length; i++) {
        const entry = logs[i]
        window.api.log.write(entry.level, entry.message)
      }
      lastLogCount = logs.length
    })
    return unsubscribe
  }, [])

  // Ref for pending thing switch (used by auto-save confirmation dialog)
  const pendingThingSwitchRef = useRef<{ thingId: number; category: ThingCategory } | null>(null)

  // Helper to actually load a thing into the editor
  const loadThingIntoEditor = useCallback(
    (thingId: number, cat: ThingCategory) => {
      const ci = clientInfo ?? useAppStore.getState().clientInfo
      if (!ci) return

      const thing = getThingById(cat, thingId)
      if (!thing) return

      const thingData: ThingData = {
        obdVersion: 0,
        clientVersion: ci.clientVersion,
        thing,
        sprites: new Map([[FrameGroupType.DEFAULT, []]]),
        xmlAttributes: null
      }
      setEditingThingData(thingData)
    },
    [clientInfo, getThingById, setEditingThingData]
  )

  // Save current editing changes to app store (auto-save helper)
  const saveCurrentThingChanges = useCallback(() => {
    const editorState = useEditorStore.getState()
    if (editorState.editingThingData && editorState.editingChanged) {
      const { thing } = editorState.editingThingData
      useAppStore.getState().updateThing(currentCategory, thing.id, thing)
      editorState.setEditingChanged(false)
    }
  }, [currentCategory])

  // Start editing a thing (called on double-click, Edit button, or context menu Edit)
  // Handles auto-save or confirmation when switching objects with unsaved changes.
  const handleEditThing = useCallback(
    (thingId: number, category?: ThingCategory) => {
      const cat = category ?? currentCategory
      const editorState = useEditorStore.getState()

      // Check if switching away from a thing with unsaved changes
      if (editorState.editingThingData && editorState.editingChanged) {
        if (autosaveSettingRef.current) {
          // Auto-save: persist changes silently and switch
          saveCurrentThingChanges()
          loadThingIntoEditor(thingId, cat)
        } else {
          // Show confirmation dialog
          pendingThingSwitchRef.current = { thingId, category: cat }
          setActiveDialog('confirmThingSwitch')
        }
        return
      }

      loadThingIntoEditor(thingId, cat)
    },
    [currentCategory, saveCurrentThingChanges, loadThingIntoEditor]
  )

  // Ref to cache autosaveThingChanges setting
  const autosaveSettingRef = useRef(false)

  // Sync autosave setting on startup and when preferences change
  useEffect(() => {
    if (!window.api?.settings?.load) return
    window.api.settings.load().then((settings) => {
      autosaveSettingRef.current = settings.autosaveThingChanges
    })
  }, [])

  // Handle actions from ThingListPanel action bar (open corresponding dialogs)
  const handleThingListAction = useCallback((action: ThingListAction) => {
    switch (action) {
      case 'import':
        setActiveDialog('import')
        break
      case 'export':
        setActiveDialog('export')
        break
      case 'replace':
        setActiveDialog('import')
        break
      case 'find':
        setActiveDialog('find')
        break
    }
  }, [])

  // -------------------------------------------------------------------------
  // Dialog handlers
  // -------------------------------------------------------------------------

  const handleCreateConfirm = useCallback(
    async (result: CreateAssetsResult) => {
      addLog(
        'info',
        `Creating new project: v${result.version.valueStr}, ${result.spriteDimension.value}`
      )

      clearThumbnailCache()
      useAppStore.getState().setLocked(true)
      setIsLoading(true)
      setLoadingLabel('Creating project...')

      try {
        const features: ClientFeatures = {
          extended: result.extended,
          transparency: result.transparency,
          improvedAnimations: result.improvedAnimations,
          frameGroups: result.frameGroups,
          metadataController: 'default',
          attributeServer: null
        }

        // Create project on main process
        await window.api.project.create({
          datSignature: result.version.datSignature,
          sprSignature: result.version.sprSignature,
          versionValue: result.version.value,
          features: {
            extended: features.extended,
            transparency: features.transparency,
            improvedAnimations: features.improvedAnimations,
            frameGroups: features.frameGroups,
            metadataController: features.metadataController,
            attributeServer: features.attributeServer
          }
        })

        // Build empty ClientInfo
        const clientInfo: ClientInfo = {
          ...createClientInfo(),
          clientVersion: result.version.value,
          clientVersionStr: result.version.valueStr,
          datSignature: result.version.datSignature,
          sprSignature: result.version.sprSignature,
          minItemId: 100,
          maxItemId: 99,
          minOutfitId: 1,
          maxOutfitId: 0,
          minEffectId: 1,
          maxEffectId: 0,
          minMissileId: 1,
          maxMissileId: 0,
          minSpriteId: 1,
          maxSpriteId: 0,
          features,
          loaded: true,
          isTemporary: true,
          spriteSize: result.spriteDimension.size,
          spriteDataSize: result.spriteDimension.dataSize
        }

        // Populate stores with empty data
        const appState = useAppStore.getState()
        appState.setProjectLoaded({
          clientInfo,
          loaded: true,
          isTemporary: true,
          changed: false,
          fileName: '',
          datFilePath: null,
          sprFilePath: null
        })
        appState.setThings(ThingCategory.ITEM, [])
        appState.setThings(ThingCategory.OUTFIT, [])
        appState.setThings(ThingCategory.EFFECT, [])
        appState.setThings(ThingCategory.MISSILE, [])
        appState.setSpriteCount(0)
        useSpriteStore.getState().loadSprites(new Map())

        // Update native menu
        await window.api.menu.updateState({
          clientLoaded: true,
          clientIsTemporary: true,
          clientChanged: false
        })

        addLog('info', 'New project created successfully')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        addLog('error', `Failed to create project: ${message}`)
        setErrorMessages([message])
        setActiveDialog('error')
      } finally {
        useAppStore.getState().setLocked(false)
        setIsLoading(false)
        setLoadingLabel('')
      }
    },
    [addLog]
  )

  const handleOpenConfirm = useCallback(
    async (result: OpenAssetsResult) => {
      addLog('info', `Opening project: v${result.version.valueStr} from ${result.datFile}`)

      clearThumbnailCache()
      useAppStore.getState().setLocked(true)
      setIsLoading(true)
      setLoadingLabel('Loading files...')

      try {
        // Build features from dialog result
        const features: ClientFeatures = {
          extended: result.extended,
          transparency: result.transparency,
          improvedAnimations: result.improvedAnimations,
          frameGroups: result.frameGroups,
          metadataController: 'default',
          attributeServer: result.attributeServer ?? null
        }

        // Build IPC params
        const loadParams: LoadProjectParams = {
          datFilePath: result.datFile,
          sprFilePath: result.sprFile,
          versionValue: result.version.value,
          datSignature: result.version.datSignature,
          sprSignature: result.version.sprSignature,
          features: {
            extended: features.extended,
            transparency: features.transparency,
            improvedAnimations: features.improvedAnimations,
            frameGroups: features.frameGroups,
            metadataController: features.metadataController,
            attributeServer: features.attributeServer
          },
          serverItemsPath: result.serverItemsDirectory ?? null
        }

        // Load raw buffers from disk via main process
        const loadResult = await window.api.project.load(loadParams)

        // Load settings for default durations
        setLoadingLabel('Parsing metadata...')
        const settings = await window.api.settings.load()
        const defaultDurations: Record<string, number> = {
          item: getDefaultDuration(settings, ThingCategory.ITEM),
          outfit: getDefaultDuration(settings, ThingCategory.OUTFIT),
          effect: getDefaultDuration(settings, ThingCategory.EFFECT),
          missile: getDefaultDuration(settings, ThingCategory.MISSILE)
        }

        // Parse DAT (offloaded to Web Worker)
        const datResult = await workerService.readDat(
          loadResult.datBuffer,
          result.version.value,
          features,
          defaultDurations
        )
        addLog(
          'info',
          `DAT: ${datResult.items.length} items, ${datResult.outfits.length} outfits, ${datResult.effects.length} effects, ${datResult.missiles.length} missiles`
        )

        // Load sprites lazily via SpriteAccessor (no upfront extraction)
        setLoadingLabel('Indexing sprites...')
        useSpriteStore.getState().loadFromBuffer(loadResult.sprBuffer, features.extended)
        const sprAccessor = useSpriteStore.getState().spriteAccessor!
        addLog('info', `SPR: ${sprAccessor.spriteCount} sprites (lazy loading)`)

        // Parse OTB (optional)
        let otbResult: ReturnType<typeof readOtb> | null = null
        if (loadResult.otbBuffer) {
          setLoadingLabel('Parsing server items...')
          otbResult = readOtb(loadResult.otbBuffer)
          addLog(
            'info',
            `OTB: ${otbResult.items.count} items (v${otbResult.items.majorVersion}.${otbResult.items.minorVersion})`
          )
        }

        // Parse items.xml (optional, requires OTB)
        if (loadResult.xmlContent && otbResult) {
          readItemsXml(loadResult.xmlContent, otbResult.items)
          addLog('info', 'items.xml loaded')
        }

        // Parse OTFI (optional)
        let otfiData: ReturnType<typeof parseOtfi> | null = null
        if (loadResult.otfiContent) {
          otfiData = parseOtfi(loadResult.otfiContent)
          if (otfiData) {
            addLog('info', 'OTFI loaded')
          }
        }

        // Build ClientInfo
        setLoadingLabel('Populating stores...')
        const fileName =
          result.datFile
            .split('/')
            .pop()
            ?.replace(/\.dat$/i, '') ?? ''
        const clientInfo: ClientInfo = {
          ...createClientInfo(),
          clientVersion: result.version.value,
          clientVersionStr: result.version.valueStr,
          datSignature: datResult.signature,
          sprSignature: sprAccessor.signature,
          minItemId: 100,
          maxItemId: datResult.maxItemId,
          minOutfitId: 1,
          maxOutfitId: datResult.maxOutfitId,
          minEffectId: 1,
          maxEffectId: datResult.maxEffectId,
          minMissileId: 1,
          maxMissileId: datResult.maxMissileId,
          minSpriteId: 1,
          maxSpriteId: sprAccessor.spriteCount,
          features,
          loaded: true,
          isTemporary: false,
          otbLoaded: otbResult !== null,
          otbMajorVersion: otbResult?.items.majorVersion ?? 0,
          otbMinorVersion: otbResult?.items.minorVersion ?? 0,
          otbItemsCount: otbResult?.items.count ?? 0,
          spriteSize: result.spriteDimension.size,
          spriteDataSize: result.spriteDimension.dataSize,
          loadedFileName: fileName
        }

        // Populate stores
        const appState = useAppStore.getState()
        appState.setProjectLoaded({
          clientInfo,
          loaded: true,
          isTemporary: false,
          changed: false,
          fileName,
          datFilePath: result.datFile,
          sprFilePath: result.sprFile
        })
        appState.setThings(ThingCategory.ITEM, datResult.items)
        appState.setThings(ThingCategory.OUTFIT, datResult.outfits)
        appState.setThings(ThingCategory.EFFECT, datResult.effects)
        appState.setThings(ThingCategory.MISSILE, datResult.missiles)
        appState.setSpriteCount(sprAccessor.spriteCount)

        // Update native menu
        await window.api.menu.updateState({
          clientLoaded: true,
          clientIsTemporary: false,
          clientChanged: false,
          otbLoaded: otbResult !== null
        })

        addLog('info', `Project loaded: ${fileName} v${result.version.valueStr}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        addLog('error', `Failed to load project: ${message}`)
        setErrorMessages([message])
        setActiveDialog('error')
      } finally {
        useAppStore.getState().setLocked(false)
        setIsLoading(false)
        setLoadingLabel('')
      }
    },
    [addLog]
  )

  const handleCompileAsConfirm = useCallback(
    (result: CompileAssetsResult) => {
      addLog(
        'info',
        `Compiling as: ${result.filesName} v${result.version.valueStr} to ${result.directory}`
      )
      // TODO: Wire to actual project compilation logic in future steps
    },
    [addLog]
  )

  const handleMergeConfirm = useCallback(
    (result: MergeAssetsResult) => {
      addLog('info', `Merging: v${result.version.valueStr} from ${result.datFile}`)
      // TODO: Wire to actual merge logic in future steps
    },
    [addLog]
  )

  const handlePreferencesConfirm = useCallback(
    (settings: ObjectBuilderSettings) => {
      if (window.api?.settings) {
        window.api.settings.save(settings).then(() => {
          addLog('info', 'Preferences saved')
        })
      }
      // Sync clipboard action setting to editor store
      useEditorStore
        .getState()
        .setClipboardAction(settings.thingListClipboardAction as ClipboardAction)
      // Sync autosave setting
      autosaveSettingRef.current = settings.autosaveThingChanges
      // Sync theme setting
      setTheme(settings.theme)
      // Sync language setting
      if (settings.language && settings.language !== i18n.language) {
        i18n.changeLanguage(settings.language)
      }
    },
    [addLog, setTheme]
  )

  const handleFindThings = useCallback(
    (filters: FindThingFilters) => {
      addLog('info', `Searching things: category=${filters.category}, name="${filters.name}"`)
      // TODO: Wire to actual search logic in future steps
    },
    [addLog]
  )

  const handleFindSprites = useCallback(
    (filters: FindSpriteFilters) => {
      addLog(
        'info',
        `Searching sprites: unused=${filters.unusedSprites}, empty=${filters.emptySprites}`
      )
      // TODO: Wire to actual sprite search logic in future steps
    },
    [addLog]
  )

  const handleFindSelectThing = useCallback((id: number, category: ThingCategory) => {
    const { setCurrentCategory, selectThing } = useAppStore.getState()
    setCurrentCategory(category)
    selectThing(id)
    setActiveDialog(null)
  }, [])

  const handleExportConfirm = useCallback(
    (result: ExportDialogResult) => {
      addLog('info', `Exporting: ${result.fileName} as ${result.format} to ${result.directory}`)
      // TODO: Wire to actual export logic in future steps
    },
    [addLog]
  )

  const handleImportConfirm = useCallback(
    (result: ImportThingResult) => {
      addLog('info', `Importing: ${result.filePath} (${result.action})`)
      // TODO: Wire to actual import logic in future steps
    },
    [addLog]
  )

  const handleBulkEditConfirm = useCallback(
    (result: BulkEditResult) => {
      const { bulkEditIds, bulkEditCategory } = useEditorStore.getState()
      addLog(
        'info',
        `Bulk edit: ${result.properties.length} changes on ${bulkEditIds.length} ${bulkEditCategory ?? 'objects'}`
      )
      useEditorStore.getState().clearBulkEdit()
      // TODO: Wire to actual bulk update logic in future steps
    },
    [addLog]
  )

  const handleBulkEditClose = useCallback(() => {
    setActiveDialog(null)
    useEditorStore.getState().clearBulkEdit()
  }, [])

  // Close confirmation dialog handlers
  const handleCloseConfirmSave = useCallback(() => {
    // TODO: Wire to actual compile logic when available
    // For now, close without saving (same as "Don't Save")
    pendingCloseRef.current = false
    setActiveDialog(null)
    addLog('info', 'Closing with unsaved changes (compile not yet wired)')
    window.api?.app?.closeConfirmed()
  }, [addLog])

  const handleCloseConfirmDiscard = useCallback(() => {
    pendingCloseRef.current = false
    setActiveDialog(null)
    window.api?.app?.closeConfirmed()
  }, [])

  const handleCloseConfirmCancel = useCallback(() => {
    pendingCloseRef.current = false
    setActiveDialog(null)
  }, [])

  // Thing switch confirmation dialog handlers (when autosave is disabled)
  const handleThingSwitchSave = useCallback(() => {
    saveCurrentThingChanges()
    const pending = pendingThingSwitchRef.current
    pendingThingSwitchRef.current = null
    setActiveDialog(null)
    if (pending) {
      loadThingIntoEditor(pending.thingId, pending.category)
    }
  }, [saveCurrentThingChanges, loadThingIntoEditor])

  const handleThingSwitchDiscard = useCallback(() => {
    // Discard changes and switch
    useEditorStore.getState().setEditingChanged(false)
    const pending = pendingThingSwitchRef.current
    pendingThingSwitchRef.current = null
    setActiveDialog(null)
    if (pending) {
      loadThingIntoEditor(pending.thingId, pending.category)
    }
  }, [loadThingIntoEditor])

  const handleThingSwitchCancel = useCallback(() => {
    pendingThingSwitchRef.current = null
    setActiveDialog(null)
  }, [])

  // Recovery dialog handlers
  const handleRecoveryReopen = useCallback(() => {
    const info = recoveryInfo
    setRecoveryInfo(null)
    setActiveDialog(null)
    // Clear the recovery file since we're handling it
    window.api?.recovery?.clear()

    if (info) {
      // Open the project automatically by triggering the open dialog flow
      // We have the file paths, so open the Open dialog pre-seeded
      // For simplicity, just open the Open Assets dialog (user can adjust settings)
      addLog('info', `Recovering previous session: ${info.datFilePath}`)
      setActiveDialog('open')
    }
  }, [recoveryInfo, addLog])

  const handleRecoveryDismiss = useCallback(() => {
    setRecoveryInfo(null)
    setActiveDialog(null)
    window.api?.recovery?.clear()
  }, [])

  // Watch editor store editMode: when bulk edit is triggered from context menu, open dialog
  const editMode = useEditorStore((s) => s.editMode)
  const bulkEditIds = useEditorStore((s) => s.bulkEditIds)
  const bulkEditCategory = useEditorStore((s) => s.bulkEditCategory)

  useEffect(() => {
    if (editMode === 'bulk' && bulkEditIds.length > 0 && bulkEditCategory) {
      setActiveDialog('bulkEdit')
    }
  }, [editMode, bulkEditIds, bulkEditCategory])

  // Central action handler for menu and toolbar actions
  const handleAction = useCallback(
    (action: MenuAction) => {
      switch (action) {
        case MENU_FILE_NEW:
          setActiveDialog('create')
          break
        case MENU_FILE_OPEN:
          setActiveDialog('open')
          break
        case MENU_FILE_COMPILE_AS:
          setActiveDialog('compileAs')
          break
        case MENU_FILE_MERGE:
          setActiveDialog('merge')
          break
        case MENU_FILE_PREFERENCES:
          setActiveDialog('preferences')
          break
        case MENU_HELP_ABOUT:
          setActiveDialog('about')
          break
        case MENU_TOOLS_FIND:
          setActiveDialog('find')
          break
        case MENU_TOOLS_ANIMATION_EDITOR:
          setActiveDialog('animationEditor')
          break
        case MENU_TOOLS_OBJECT_VIEWER:
          setActiveDialog('objectViewer')
          break
        case MENU_TOOLS_SLICER:
          setActiveDialog('slicer')
          break
        case MENU_TOOLS_ASSET_STORE:
          setActiveDialog('assetStore')
          break
        case MENU_TOOLS_LOOK_TYPE_GENERATOR:
          setActiveDialog('lookTypeGenerator')
          break
        case MENU_TOOLS_SPRITES_OPTIMIZER:
          setActiveDialog('spritesOptimizer')
          break
        case MENU_TOOLS_FRAME_DURATIONS_OPTIMIZER:
          setActiveDialog('frameDurationsOptimizer')
          break
        case MENU_TOOLS_FRAME_GROUPS_CONVERTER:
          setActiveDialog('frameGroupsConverter')
          break
        case MENU_WINDOW_LOG:
          togglePanel('log')
          break
        case MENU_VIEW_SHOW_PREVIEW:
          togglePanel('preview')
          break
        case MENU_VIEW_SHOW_OBJECTS:
          togglePanel('things')
          break
        case MENU_VIEW_SHOW_SPRITES:
          togglePanel('sprites')
          break
        default:
          break
      }
    },
    [togglePanel]
  )

  // Listen for menu actions from the main process (native menu clicks)
  useEffect(() => {
    if (!window.api?.menu?.onAction) return
    return window.api.menu.onAction((action: string) => {
      handleAction(action as MenuAction)
    })
  }, [handleAction])

  // Load clipboard action and language from settings on startup
  useEffect(() => {
    if (!window.api?.settings?.load) return
    window.api.settings.load().then((settings) => {
      useEditorStore
        .getState()
        .setClipboardAction(settings.thingListClipboardAction as ClipboardAction)
      // Sync i18n language from persisted settings
      if (settings.language && settings.language !== i18n.language) {
        i18n.changeLanguage(settings.language)
      }
    })
  }, [])

  const closeDialog = useCallback(() => setActiveDialog(null), [])

  return (
    <div className="flex h-full flex-col">
      {'web' in (window.api ?? {}) && <WebMenuBar onAction={handleAction} />}
      <Toolbar onAction={handleAction} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Main content area with three resizable panels */}
        <div className="flex-1 overflow-hidden">
          <SplitPane
            farLeft={<PreviewPanel />}
            farLeftWidth={ui.previewContainerWidth}
            showFarLeft={ui.showPreviewPanel}
            onFarLeftWidthChange={(w) => setPanelWidth('preview', w)}
            left={<ThingListPanel onEditThing={handleEditThing} onAction={handleThingListAction} />}
            center={<ThingTypeEditor />}
            right={<SpritePanel />}
            leftWidth={ui.thingListContainerWidth}
            rightWidth={ui.spritesContainerWidth}
            leftMinWidth={190}
            leftMaxWidth={400}
            rightMinWidth={190}
            rightMaxWidth={400}
            showLeft={ui.showThingsPanel}
            showRight={ui.showSpritesPanel}
            onLeftWidthChange={(w) => setPanelWidth('thingList', w)}
            onRightWidthChange={(w) => setPanelWidth('sprites', w)}
          />
        </div>

        {/* Collapsible log panel */}
        {ui.showLogPanel && <LogPanel height={logHeight} onHeightChange={setLogHeight} />}
      </div>

      <StatusBar />

      {/* Project dialogs */}
      <CreateAssetsDialog
        open={activeDialog === 'create'}
        onClose={closeDialog}
        onConfirm={handleCreateConfirm}
      />

      <OpenAssetsDialog
        open={activeDialog === 'open'}
        onClose={closeDialog}
        onConfirm={handleOpenConfirm}
      />

      <CompileAssetsDialog
        open={activeDialog === 'compileAs'}
        onClose={closeDialog}
        onConfirm={handleCompileAsConfirm}
        currentVersion={
          clientInfo
            ? {
                value: clientInfo.clientVersion,
                valueStr: clientInfo.clientVersionStr,
                datSignature: clientInfo.datSignature,
                sprSignature: clientInfo.sprSignature,
                otbVersion: 0
              }
            : null
        }
        serverItemsLoaded={clientInfo?.otbLoaded ?? false}
      />

      <MergeAssetsDialog
        open={activeDialog === 'merge'}
        onClose={closeDialog}
        onConfirm={handleMergeConfirm}
      />

      <PreferencesDialog
        open={activeDialog === 'preferences'}
        onClose={closeDialog}
        onConfirm={handlePreferencesConfirm}
        otbLoaded={clientInfo?.otbLoaded ?? false}
      />

      <AboutDialog open={activeDialog === 'about'} onClose={closeDialog} />

      <ErrorDialog
        open={activeDialog === 'error'}
        onClose={() => {
          setActiveDialog(null)
          setErrorMessages([])
        }}
        messages={errorMessages}
      />

      <FindDialog
        open={activeDialog === 'find'}
        onClose={closeDialog}
        onFindThings={handleFindThings}
        onFindSprites={handleFindSprites}
        onSelectThing={handleFindSelectThing}
      />

      <ExportDialog
        open={activeDialog === 'export'}
        onClose={closeDialog}
        onConfirm={handleExportConfirm}
        enableObdFormat={true}
        currentVersion={
          clientInfo
            ? {
                value: clientInfo.clientVersion,
                valueStr: clientInfo.clientVersionStr,
                datSignature: clientInfo.datSignature,
                sprSignature: clientInfo.sprSignature,
                otbVersion: 0
              }
            : null
        }
      />

      <ImportThingDialog
        open={activeDialog === 'import'}
        onClose={closeDialog}
        onConfirm={handleImportConfirm}
        canReplace={selectedThingId !== null}
      />

      <BulkEditDialog
        open={activeDialog === 'bulkEdit'}
        onClose={handleBulkEditClose}
        onConfirm={handleBulkEditConfirm}
        selectedIds={bulkEditIds}
        category={bulkEditCategory ?? 'item'}
        otbLoaded={clientInfo?.otbLoaded ?? false}
      />

      <AnimationEditorDialog open={activeDialog === 'animationEditor'} onClose={closeDialog} />

      <ObjectViewerDialog open={activeDialog === 'objectViewer'} onClose={closeDialog} />

      <SlicerDialog open={activeDialog === 'slicer'} onClose={closeDialog} />

      <AssetStoreDialog open={activeDialog === 'assetStore'} onClose={closeDialog} />

      <LookTypeGeneratorDialog open={activeDialog === 'lookTypeGenerator'} onClose={closeDialog} />

      <SpritesOptimizerDialog open={activeDialog === 'spritesOptimizer'} onClose={closeDialog} />

      <FrameDurationsOptimizerDialog
        open={activeDialog === 'frameDurationsOptimizer'}
        onClose={closeDialog}
      />

      <FrameGroupsConverterDialog
        open={activeDialog === 'frameGroupsConverter'}
        onClose={closeDialog}
      />

      {/* Close confirmation dialog (unsaved changes) */}
      <Modal
        title={t('labels.confirm')}
        open={activeDialog === 'confirmClose'}
        onClose={handleCloseConfirmCancel}
        width={400}
        closeOnBackdrop={false}
        footer={
          <div className="flex justify-end gap-2">
            <DialogButton label={t('labels.cancel')} onClick={handleCloseConfirmCancel} />
            <DialogButton label={t('labels.no')} onClick={handleCloseConfirmDiscard} />
            <DialogButton label={t('labels.yes')} onClick={handleCloseConfirmSave} primary />
          </div>
        }
      >
        <p className="text-sm text-text-primary">{t('alert.wantToCompile')}</p>
      </Modal>

      {/* Thing switch confirmation dialog (unsaved changes to current object) */}
      <Modal
        title={t('labels.confirm')}
        open={activeDialog === 'confirmThingSwitch'}
        onClose={handleThingSwitchCancel}
        width={400}
        closeOnBackdrop={false}
        footer={
          <div className="flex justify-end gap-2">
            <DialogButton label={t('labels.cancel')} onClick={handleThingSwitchCancel} />
            <DialogButton label={t('labels.no')} onClick={handleThingSwitchDiscard} />
            <DialogButton label={t('labels.yes')} onClick={handleThingSwitchSave} primary />
          </div>
        }
      >
        <p className="text-sm text-text-primary">
          {t('alert.saveChanges', {
            0: currentCategory,
            1: `#${useEditorStore.getState().editingThingData?.thing.id ?? ''}`
          })}
        </p>
      </Modal>

      {/* Recovery dialog (previous session crashed) */}
      <Modal
        title={t('labels.confirm')}
        open={activeDialog === 'recovery'}
        onClose={handleRecoveryDismiss}
        width={440}
        closeOnBackdrop={false}
        footer={
          <div className="flex justify-end gap-2">
            <DialogButton label={t('labels.no')} onClick={handleRecoveryDismiss} />
            <DialogButton label={t('labels.yes')} onClick={handleRecoveryReopen} primary />
          </div>
        }
      >
        <div className="flex flex-col gap-2 text-sm text-text-primary">
          <p>{t('alert.recoveryDetected')}</p>
          {recoveryInfo && (
            <p className="text-text-secondary truncate">{recoveryInfo.datFilePath}</p>
          )}
        </div>
      </Modal>

      {/* Loading overlay */}
      {isLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex flex-col items-center gap-3 rounded-lg bg-bg-secondary p-6 shadow-xl border border-border">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-text-muted border-t-accent" />
            <span className="text-sm text-text-primary">{loadingLabel || 'Loading...'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
