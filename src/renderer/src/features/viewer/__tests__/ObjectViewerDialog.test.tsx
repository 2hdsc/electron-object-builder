import React, { act } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ObjectViewerDialog } from '../ObjectViewerDialog'
import { resetAppStore, resetEditorStore, useEditorStore } from '../../../stores'
import { useAnimationStore } from '../../../stores/use-animation-store'
import { ThingCategory, createThingType, createFrameGroup, FrameGroupType } from '../../../types'
import type { ThingData } from '../../../types'

function makeThingData(id: number): ThingData {
  const thing = createThingType()
  thing.id = id
  thing.category = ThingCategory.EFFECT
  const fg = createFrameGroup()
  fg.frames = 3
  fg.spriteIndex = [1, 2, 3]
  thing.frameGroups = [fg]
  return {
    obdVersion: 0,
    clientVersion: 860,
    thing,
    sprites: new Map([[FrameGroupType.DEFAULT, []]]),
    xmlAttributes: null
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  resetAppStore()
  resetEditorStore()
  useAnimationStore.getState().clearFrameGroup()
})

describe('ObjectViewerDialog', () => {
  it('does not clear the shared animation store while closed', () => {
    render(<ObjectViewerDialog open={false} onClose={() => {}} />)

    // Simulates the Preview panel starting an animation for the edited thing
    const data = makeThingData(1)
    act(() => {
      useEditorStore.getState().setEditingThingData(data)
      useAnimationStore.getState().setFrameGroup(data.thing.frameGroups[0]!, FrameGroupType.DEFAULT)
      useAnimationStore.getState().play()
    })

    expect(useAnimationStore.getState().frameGroup).not.toBeNull()
    expect(useAnimationStore.getState().isPlaying).toBe(true)
  })

  it('clears the animation store when the dialog closes', () => {
    act(() => useEditorStore.getState().setEditingThingData(makeThingData(2)))
    const { rerender } = render(<ObjectViewerDialog open={true} onClose={() => {}} />)
    expect(useAnimationStore.getState().frameGroup).not.toBeNull()

    rerender(<ObjectViewerDialog open={false} onClose={() => {}} />)
    expect(useAnimationStore.getState().frameGroup).toBeNull()
  })
})
