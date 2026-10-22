import { describe, expect, it } from 'vitest'
import { quickCaptureBoundsOnDisplay, type DisplayArea } from './quick-capture-placement'

// Work areas of a two-display Mac like the one in #976: a main display with
// the Dock below, and a smaller built-in display to its left, lower down.
const main: DisplayArea = { id: 1, workArea: { x: 0, y: 30, width: 2560, height: 1356 } }
const side: DisplayArea = { id: 2, workArea: { x: -1728, y: 206, width: 1728, height: 1085 } }

describe('the Quick capture panel opens on the display under the pointer (#976)', () => {
  it('stays exactly where it is on its own display', () => {
    const bounds = { x: 140, y: 90, width: 620, height: 480 }
    expect(quickCaptureBoundsOnDisplay({ bounds, from: main, to: main })).toBeNull()
  })

  it('opens centered on the other display when it was centered', () => {
    const bounds = { x: 970, y: 468, width: 620, height: 480 }
    expect(quickCaptureBoundsOnDisplay({ bounds, from: main, to: side })).toEqual({
      x: -1728 + (1728 - 620) / 2,
      y: Math.round(206 + (1085 - 480) / 2),
      width: 620,
      height: 480
    })
  })

  it('keeps a corner the user dragged it to', () => {
    // Top right of the main display, flush with its edges.
    const bounds = { x: 2560 - 620, y: 30, width: 620, height: 480 }
    expect(quickCaptureBoundsOnDisplay({ bounds, from: main, to: side })).toEqual({
      x: -620,
      y: 206,
      width: 620,
      height: 480
    })
  })

  it('shrinks to fit a smaller work area and stays inside it', () => {
    const small: DisplayArea = { id: 3, workArea: { x: 2560, y: 0, width: 500, height: 400 } }
    const bounds = { x: 200, y: 200, width: 620, height: 480 }
    expect(quickCaptureBoundsOnDisplay({ bounds, from: main, to: small })).toEqual({
      x: 2560,
      y: 0,
      width: 500,
      height: 400
    })
  })

  it('returns exactly to where it last sat on a display', () => {
    const bounds = { x: 1700, y: 90, width: 700, height: 520 }
    const there = quickCaptureBoundsOnDisplay({ bounds, from: main, to: side })!
    expect(
      quickCaptureBoundsOnDisplay({ bounds: there, from: side, to: main, remembered: bounds })
    ).toEqual(bounds)
  })

  it('maps afresh when the remembered spot no longer fits the display', () => {
    // The display got smaller since, so the old spot hangs off its edge.
    const remembered = { x: 2200, y: 1200, width: 620, height: 480 }
    const bounds = { x: -1174, y: 509, width: 620, height: 480 }
    const next = quickCaptureBoundsOnDisplay({ bounds, from: side, to: main, remembered })!
    expect(next).not.toEqual(remembered)
    expect(next.x + next.width).toBeLessThanOrEqual(2560)
    expect(next.y + next.height).toBeLessThanOrEqual(30 + 1356)
  })

  it('lands fully on the new display when it hung off the edge of the old one', () => {
    const bounds = { x: 2400, y: 1300, width: 620, height: 480 }
    const next = quickCaptureBoundsOnDisplay({ bounds, from: main, to: side })!
    expect(next.x + next.width).toBeLessThanOrEqual(0)
    expect(next.y + next.height).toBeLessThanOrEqual(206 + 1085)
    expect(next.x).toBeGreaterThanOrEqual(-1728)
    expect(next.y).toBeGreaterThanOrEqual(206)
  })
})
