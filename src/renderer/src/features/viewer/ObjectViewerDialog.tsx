/**
 * Object Viewer dialog — standalone tool for browsing and previewing OBD files
 * or the currently editing object, with direction rotation, animated preview,
 * and zoom controls.
 *
 * Ported from legacy AS3: objectview/ObjectViewer.mxml + ThingDataView direction controls.
 *
 * Features:
 * - View currently editing thing or open OBD files from disk
 * - Animated preview with SpriteRenderer
 * - 8-direction controls (N/S/E/W/NE/NW/SE/SW)
 * - Frame group selector (Idle/Walking for outfits)
 * - Playback controls (Play/Pause/Stop, First/Prev/Next/Last)
 * - Zoom slider (1x-5x) + mouse wheel
 * - Background color toggle + color picker
 * - OBD file list with navigation (Previous/Next)
 * - Status info (name, type, client version, OBD version)
 * - Keyboard shortcuts (Ctrl+O, Left/Right arrows)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../../components/Modal'
import {
  IconArrowNW,
  IconArrowN,
  IconArrowNE,
  IconArrowW,
  IconArrowE,
  IconArrowSW,
  IconArrowS,
  IconArrowSE,
  IconChevronLeft,
  IconChevronRight,
  IconFirst,
  IconPrevious,
  IconPlay,
  IconPause,
  IconStop,
  IconNext,
  IconLast,
  IconOpen
} from '../../components/Icons'
import { useEditorStore, selectEditingThingData } from '../../stores'
import { useAnimationStore } from '../../stores'
import { SpriteRenderer } from '../sprites'
import { ThingCategory } from '../../types/things'
import type { ThingData } from '../../types/things'
import { FrameGroupType as FGT } from '../../types/animation'
import type { FrameGroupType } from '../../types/animation'
import { Direction } from '../../types/geometry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObjectViewerDialogProps {
  open: boolean
  onClose: () => void
}

interface ObdFileEntry {
  name: string
  path: string
}

// ---------------------------------------------------------------------------
// Direction Pad
// ---------------------------------------------------------------------------

interface DirectionPadProps {
  direction: number
  onDirectionChange: (patternX: number) => void
  maxDirections: number
}

function DirectionPad({
  direction,
  onDirectionChange,
  maxDirections
}: DirectionPadProps): React.JSX.Element {
  const buttons: Array<{
    dir: number
    label: string
    icon: React.ReactNode
    row: number
    col: number
  }> = [
    { dir: Direction.NORTHWEST, label: 'NW', icon: <IconArrowNW size={12} />, row: 0, col: 0 },
    { dir: Direction.NORTH, label: 'N', icon: <IconArrowN size={12} />, row: 0, col: 1 },
    { dir: Direction.NORTHEAST, label: 'NE', icon: <IconArrowNE size={12} />, row: 0, col: 2 },
    { dir: Direction.WEST, label: 'W', icon: <IconArrowW size={12} />, row: 1, col: 0 },
    { dir: -1, label: '', icon: null, row: 1, col: 1 },
    { dir: Direction.EAST, label: 'E', icon: <IconArrowE size={12} />, row: 1, col: 2 },
    { dir: Direction.SOUTHWEST, label: 'SW', icon: <IconArrowSW size={12} />, row: 2, col: 0 },
    { dir: Direction.SOUTH, label: 'S', icon: <IconArrowS size={12} />, row: 2, col: 1 },
    { dir: Direction.SOUTHEAST, label: 'SE', icon: <IconArrowSE size={12} />, row: 2, col: 2 }
  ]

  // Map Direction enum to patternX index for outfits (4 cardinal)
  // N=0, E=1, S=2, W=3 — diagonal maps to closest cardinal
  const dirToPatternX = (dir: number): number => {
    switch (dir) {
      case Direction.NORTH:
      case Direction.NORTHWEST:
        return 0
      case Direction.EAST:
      case Direction.NORTHEAST:
        return 1
      case Direction.SOUTH:
      case Direction.SOUTHEAST:
        return 2
      case Direction.WEST:
      case Direction.SOUTHWEST:
        return 3
      default:
        return 0
    }
  }

  return (
    <div className="grid grid-cols-3 gap-0.5" style={{ width: 72, height: 72 }}>
      {buttons.map((btn) => {
        if (btn.dir === -1) {
          return <div key="center" className="h-6 w-6" />
        }

        const patternX = dirToPatternX(btn.dir)
        const isActive = direction === patternX
        const isAvailable = patternX < maxDirections

        return (
          <button
            key={btn.label}
            type="button"
            title={btn.label}
            className={`flex h-6 w-6 items-center justify-center rounded text-[10px] transition-colors ${
              isActive
                ? 'bg-accent text-white'
                : isAvailable
                  ? 'bg-bg-tertiary text-text-primary hover:bg-bg-hover'
                  : 'bg-bg-primary text-text-muted cursor-not-allowed'
            }`}
            onClick={() => isAvailable && onDirectionChange(patternX)}
            disabled={!isAvailable}
          >
            {btn.icon}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OBD File List
// ---------------------------------------------------------------------------

interface ObdFileListProps {
  files: ObdFileEntry[]
  selectedIndex: number
  onSelect: (index: number) => void
}

function ObdFileList({ files, selectedIndex, onSelect }: ObdFileListProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const el = listRef.current.children[selectedIndex] as HTMLElement
      if (el) {
        el.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex])

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-muted">
        No files loaded
      </div>
    )
  }

  return (
    <div ref={listRef} className="h-full overflow-y-auto">
      {files.map((file, index) => (
        <div
          key={file.path}
          className={`cursor-pointer truncate px-2 py-1 text-xs ${
            index === selectedIndex
              ? 'bg-accent text-white'
              : 'text-text-primary hover:bg-accent-subtle'
          }`}
          onClick={() => onSelect(index)}
        >
          {file.name}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ObjectViewerDialog
// ---------------------------------------------------------------------------

export function ObjectViewerDialog({
  open,
  onClose
}: ObjectViewerDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  // Source modes: 'editing' uses current editing thing, 'obd' browses OBD files
  const [sourceMode, setSourceMode] = useState<'editing' | 'obd'>('editing')

  // OBD file browser state
  const [obdFiles, setObdFiles] = useState<ObdFileEntry[]>([])
  const [obdSelectedIndex, setObdSelectedIndex] = useState(-1)
  const [obdThingData, setObdThingData] = useState<ThingData | null>(null)
  const [obdLoading, setObdLoading] = useState(false)
  const [obdError, setObdError] = useState<string | null>(null)

  // Viewer state
  const [patternX, setPatternX] = useState(2) // Default South for outfits
  const [frameGroupType, setFrameGroupType] = useState<FrameGroupType>(FGT.DEFAULT)
  const [zoom, setZoom] = useState(1.0)
  const [showBgColor, setShowBgColor] = useState(false)
  const [bgColor, setBgColor] = useState('#ff00ff')

  // Playback
  const isPlaying = useAnimationStore((s) => s.isPlaying)
  const currentFrame = useAnimationStore((s) => s.currentFrame)
  const animFrameRef = useRef<number>(0)

  // Get editing thing from store
  const editingThingData = useEditorStore(selectEditingThingData)

  // Active thing data based on source mode
  const thingData = sourceMode === 'editing' ? editingThingData : obdThingData

  // Derived info
  const thing = thingData?.thing
  const category = thing?.category
  const isOutfit = category === ThingCategory.OUTFIT
  const fg = useMemo(() => {
    if (!thing?.frameGroups) return null
    const idx = frameGroupType === FGT.WALKING ? 1 : 0
    return thing.frameGroups[idx] ?? thing.frameGroups[0] ?? null
  }, [thing, frameGroupType])

  const hasWalking = isOutfit && thing?.frameGroups && thing.frameGroups.length > 1
  const hasAnimation = fg !== null && fg !== undefined && fg.frames > 1
  const maxDirections = fg?.patternX ?? 1

  // Setup animation when thing changes
  useEffect(() => {
    if (!open) return

    if (!thingData || !fg) {
      useAnimationStore.getState().clearFrameGroup()
      return
    }

    useAnimationStore.getState().setFrameGroup(fg, frameGroupType)
    if (hasAnimation) {
      useAnimationStore.getState().play()
    }
  }, [open, thingData, fg, frameGroupType, hasAnimation])

  // Animation playback loop
  useEffect(() => {
    if (!isPlaying || !open) return

    const tick = (time: number): void => {
      useAnimationStore.getState().update(time)
      animFrameRef.current = requestAnimationFrame(tick)
    }
    animFrameRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animFrameRef.current)
    }
  }, [isPlaying, open])

  // Reset state when dialog opens
  const wasOpenRef = useRef(open)
  useEffect(() => {
    if (open) {
      setSourceMode('editing')
      setObdFiles([])
      setObdSelectedIndex(-1)
      setObdThingData(null)
      setObdError(null)
      setZoom(1.0)

      // Default direction: South for outfits, North for others
      if (editingThingData) {
        const isOutfitCategory = editingThingData.thing.category === ThingCategory.OUTFIT
        setPatternX(isOutfitCategory ? 2 : 0)

        // Default to WALKING if available
        const hasWalkingGroup =
          isOutfitCategory &&
          editingThingData.thing.frameGroups &&
          editingThingData.thing.frameGroups.length > 1
        setFrameGroupType(hasWalkingGroup ? FGT.WALKING : FGT.DEFAULT)
      } else {
        setPatternX(0)
        setFrameGroupType(FGT.DEFAULT)
      }
    } else if (wasOpenRef.current) {
      // Only reset the shared animation store when the dialog actually closes.
      // Clearing it while closed (e.g. on every editingThingData change) would
      // stop the Preview panel animation, which uses the same store.
      useAnimationStore.getState().clearFrameGroup()
      cancelAnimationFrame(animFrameRef.current)
    }
    wasOpenRef.current = open
  }, [open, editingThingData])

  // Load OBD file
  const loadObdFile = useCallback(async (filePath: string) => {
    setObdLoading(true)
    setObdError(null)
    setObdThingData(null)

    try {
      const buffer = await window.api.file.readBinary(filePath)
      const { workerService } = await import('../../workers/worker-service')
      const decoded = await workerService.decodeObd(new Uint8Array(buffer).buffer)
      setObdThingData(decoded)

      const isOutfitCategory = decoded.thing.category === ThingCategory.OUTFIT
      setPatternX(isOutfitCategory ? 2 : 0)

      const hasWalkingGroup =
        isOutfitCategory && decoded.thing.frameGroups && decoded.thing.frameGroups.length > 1
      setFrameGroupType(hasWalkingGroup ? FGT.WALKING : FGT.DEFAULT)
    } catch (err) {
      setObdError(err instanceof Error ? err.message : String(err))
    } finally {
      setObdLoading(false)
    }
  }, [])

  // Open OBD files dialog
  const handleOpenObdFiles = useCallback(async () => {
    try {
      const result = await window.api.file.showOpenDialog({
        filters: [{ name: 'Object Builder Data', extensions: ['obd'] }]
      })

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return

      const selectedPath = result.filePaths[0]

      // Get directory and list all OBD files
      const dirParts = selectedPath.split('/')
      dirParts.pop()
      const directory = dirParts.join('/')

      const allFiles = await window.api.file.list(directory, ['obd'])
      const entries: ObdFileEntry[] = allFiles.map((f) => ({
        name: f.split('/').pop() ?? f,
        path: f
      }))

      // Sort numerically by filename
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

      setObdFiles(entries)
      setSourceMode('obd')

      // Find and select the opened file
      const selectedIdx = entries.findIndex((e) => e.path === selectedPath)
      setObdSelectedIndex(selectedIdx >= 0 ? selectedIdx : 0)
      await loadObdFile(selectedPath)
    } catch (err) {
      setObdError(err instanceof Error ? err.message : String(err))
    }
  }, [loadObdFile])

  // OBD file navigation
  const handleObdSelect = useCallback(
    async (index: number) => {
      if (index < 0 || index >= obdFiles.length) return
      setObdSelectedIndex(index)
      await loadObdFile(obdFiles[index].path)
    },
    [obdFiles, loadObdFile]
  )

  const handlePrevious = useCallback(() => {
    if (obdSelectedIndex > 0) {
      handleObdSelect(obdSelectedIndex - 1)
    }
  }, [obdSelectedIndex, handleObdSelect])

  const handleNext = useCallback(() => {
    if (obdSelectedIndex < obdFiles.length - 1) {
      handleObdSelect(obdSelectedIndex + 1)
    }
  }, [obdSelectedIndex, obdFiles.length, handleObdSelect])

  // Playback controls
  const handlePlay = useCallback(() => {
    useAnimationStore.getState().play()
  }, [])

  const handlePause = useCallback(() => {
    useAnimationStore.getState().pause()
  }, [])

  const handleStop = useCallback(() => {
    useAnimationStore.getState().stop()
  }, [])

  const handleFirstFrame = useCallback(() => {
    useAnimationStore.getState().firstFrame()
  }, [])

  const handlePrevFrame = useCallback(() => {
    useAnimationStore.getState().prevFrame()
  }, [])

  const handleNextFrame = useCallback(() => {
    useAnimationStore.getState().nextFrame()
  }, [])

  const handleLastFrame = useCallback(() => {
    useAnimationStore.getState().lastFrame()
  }, [])

  // Zoom
  const handleZoomChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setZoom(parseFloat(e.target.value))
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'o') {
          e.preventDefault()
          handleOpenObdFiles()
        }
      } else if (sourceMode === 'obd' && obdFiles.length > 1) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          handlePrevious()
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          handleNext()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, sourceMode, obdFiles.length, handlePrevious, handleNext, handleOpenObdFiles])

  // Status text
  const statusText = useMemo(() => {
    if (!thingData) return ''

    const parts: string[] = []

    if (sourceMode === 'obd' && obdFiles[obdSelectedIndex]) {
      const fileName = obdFiles[obdSelectedIndex].name.replace(/\.obd$/i, '')
      parts.push(`Name: ${fileName}`)
    } else if (thing) {
      parts.push(`${thing.category} #${thing.id}`)
    }

    if (thing) {
      parts.push(`Type: ${thing.category}`)
    }

    if (thingData.clientVersion > 0) {
      parts.push(`Client: ${(thingData.clientVersion / 100).toFixed(2)}`)
    }

    if (thingData.obdVersion > 0) {
      parts.push(`OBD: ${(thingData.obdVersion / 100).toFixed(1)}`)
    }

    return parts.join(' | ')
  }, [thingData, thing, sourceMode, obdFiles, obdSelectedIndex])

  if (!open) return null

  return (
    <Modal
      title={t('labels.objectViewer')}
      open={open}
      onClose={onClose}
      width={800}
      closeOnBackdrop={false}
    >
      <div className="flex flex-col gap-3" style={{ minHeight: 450 }}>
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b border-border pb-2">
          {/* Source selector */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`rounded px-2 py-1 text-xs ${
                sourceMode === 'editing'
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-primary hover:bg-bg-hover'
              }`}
              onClick={() => setSourceMode('editing')}
              title="View current editing object"
            >
              Current
            </button>
            <button
              type="button"
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                sourceMode === 'obd'
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-primary hover:bg-bg-hover'
              }`}
              onClick={handleOpenObdFiles}
              title="Open OBD files (Ctrl+O)"
            >
              <IconOpen size={12} /> Open OBD...
            </button>
          </div>

          <div className="flex-1" />

          {/* Background color controls */}
          <label className="flex items-center gap-1 text-xs text-text-primary">
            <input
              type="checkbox"
              className="accent-accent"
              checked={showBgColor}
              onChange={(e) => setShowBgColor(e.target.checked)}
            />
            Background
          </label>
          <input
            type="color"
            className="h-5 w-5 cursor-pointer rounded border border-border"
            value={bgColor}
            onChange={(e) => setBgColor(e.target.value)}
            disabled={!showBgColor}
            title="Background color"
          />
        </div>

        {/* Main content */}
        <div className="flex flex-1 gap-3">
          {/* Left: OBD file list (only in OBD mode) */}
          {sourceMode === 'obd' && (
            <div className="flex w-48 flex-col rounded border border-border">
              <div className="border-b border-border px-2 py-1 text-xs font-semibold text-text-secondary">
                Files ({obdFiles.length})
              </div>
              <div className="flex-1 overflow-hidden">
                <ObdFileList
                  files={obdFiles}
                  selectedIndex={obdSelectedIndex}
                  onSelect={handleObdSelect}
                />
              </div>
              {/* Navigation buttons */}
              <div className="flex items-center justify-center gap-1 border-t border-border py-1">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-40"
                  onClick={handlePrevious}
                  disabled={obdSelectedIndex <= 0}
                  title="Previous (Left Arrow)"
                >
                  <IconChevronLeft size={12} /> Prev
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-40"
                  onClick={handleNext}
                  disabled={obdSelectedIndex >= obdFiles.length - 1}
                  title="Next (Right Arrow)"
                >
                  Next <IconChevronRight size={12} />
                </button>
              </div>
            </div>
          )}

          {/* Center: Preview area */}
          <div className="flex flex-1 flex-col items-center justify-center rounded border border-border p-4">
            {obdLoading ? (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-accent" />
                Loading...
              </div>
            ) : obdError ? (
              <div className="text-xs text-error">{obdError}</div>
            ) : !thingData ? (
              <div className="text-xs text-text-muted">
                {sourceMode === 'editing'
                  ? 'No object selected. Select an object from the list to preview.'
                  : 'Open an OBD file to preview.'}
              </div>
            ) : (
              <div
                style={{
                  backgroundColor: showBgColor ? bgColor : 'transparent',
                  padding: 8,
                  borderRadius: 4
                }}
              >
                <SpriteRenderer
                  thingData={thingData}
                  frameGroupType={frameGroupType}
                  frame={currentFrame}
                  patternX={patternX}
                  zoom={zoom}
                  minSize={96}
                  showCheckerboard={!showBgColor}
                  drawBlendLayer={!isOutfit}
                  className="rounded"
                  onZoomChange={setZoom}
                />
              </div>
            )}
          </div>

          {/* Right: Controls panel */}
          <div className="flex w-48 flex-col gap-3">
            {/* Direction pad */}
            <div className="rounded border border-border p-2">
              <div className="mb-1 text-xs font-semibold text-text-secondary">Direction</div>
              <div className="flex justify-center">
                <DirectionPad
                  direction={patternX}
                  onDirectionChange={setPatternX}
                  maxDirections={maxDirections}
                />
              </div>
            </div>

            {/* Frame group selector (outfits only) */}
            {hasWalking && (
              <div className="rounded border border-border p-2">
                <div className="mb-1 text-xs font-semibold text-text-secondary">Frame Group</div>
                <select
                  className="w-full rounded border border-border bg-bg-input px-2 py-1 text-xs text-text-primary"
                  value={frameGroupType}
                  onChange={(e) => setFrameGroupType(Number(e.target.value) as FrameGroupType)}
                >
                  <option value={FGT.DEFAULT}>{t('thingType.idle')}</option>
                  <option value={FGT.WALKING}>{t('thingType.walking')}</option>
                </select>
              </div>
            )}

            {/* Playback controls */}
            {hasAnimation && (
              <div className="rounded border border-border p-2">
                <div className="mb-1 text-xs font-semibold text-text-secondary">Playback</div>
                <div className="flex flex-wrap justify-center gap-0.5">
                  <button
                    type="button"
                    className="flex items-center justify-center rounded p-1 text-text-primary hover:bg-bg-hover"
                    onClick={handleFirstFrame}
                    title={t('labels.firstFrame')}
                  >
                    <IconFirst size={14} />
                  </button>
                  <button
                    type="button"
                    className="flex items-center justify-center rounded p-1 text-text-primary hover:bg-bg-hover"
                    onClick={handlePrevFrame}
                    title={t('labels.previousFrame')}
                  >
                    <IconPrevious size={14} />
                  </button>
                  {isPlaying ? (
                    <button
                      type="button"
                      className="flex items-center justify-center rounded bg-accent p-1 text-white hover:bg-accent-hover"
                      onClick={handlePause}
                      title={t('labels.pause')}
                    >
                      <IconPause size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="flex items-center justify-center rounded p-1 text-text-primary hover:bg-bg-hover"
                      onClick={handlePlay}
                      title={t('labels.play')}
                    >
                      <IconPlay size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex items-center justify-center rounded p-1 text-text-primary hover:bg-bg-hover"
                    onClick={handleStop}
                    title={t('labels.stop')}
                  >
                    <IconStop size={14} />
                  </button>
                  <button
                    type="button"
                    className="flex items-center justify-center rounded p-1 text-text-primary hover:bg-bg-hover"
                    onClick={handleNextFrame}
                    title={t('labels.nextFrame')}
                  >
                    <IconNext size={14} />
                  </button>
                  <button
                    type="button"
                    className="flex items-center justify-center rounded p-1 text-text-primary hover:bg-bg-hover"
                    onClick={handleLastFrame}
                    title={t('labels.lastFrame')}
                  >
                    <IconLast size={14} />
                  </button>
                </div>
                <div className="mt-1 text-center text-[10px] text-text-muted">
                  Frame {currentFrame + 1} / {fg?.frames ?? 0}
                </div>
              </div>
            )}

            {/* Zoom */}
            <div className="rounded border border-border p-2">
              <div className="mb-1 text-xs font-semibold text-text-secondary">
                {t('labels.zoom')}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  className="flex-1 accent-accent"
                  min="1.0"
                  max="5.0"
                  step="0.1"
                  value={zoom}
                  onChange={handleZoomChange}
                  disabled={!thingData}
                />
                <span className="w-9 text-right text-xs text-text-primary">{zoom.toFixed(1)}x</span>
              </div>
            </div>
          </div>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between border-t border-border pt-2">
          <span className="text-xs text-text-secondary">{statusText}</span>
          <span className="text-xs text-text-secondary">Zoom: {zoom.toFixed(1)}x</span>
        </div>
      </div>
    </Modal>
  )
}
