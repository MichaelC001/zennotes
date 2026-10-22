/** A rectangle in Electron's screen coordinates (DIPs, all displays share one space). */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** The part of a display Electron reports that windows may use. */
export interface DisplayArea {
  id: number
  workArea: ScreenRect
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

const contains = (area: ScreenRect, rect: ScreenRect): boolean =>
  rect.x >= area.x &&
  rect.y >= area.y &&
  rect.x + rect.width <= area.x + area.width &&
  rect.y + rect.height <= area.y + area.height

/**
 * Where the Quick capture panel opens when the hotkey shows it again. The
 * panel is created once and hidden between captures, so it kept the bounds of
 * its first show and came back on that display even with the pointer and the
 * focused window on another one (#976); as a macOS panel floating above other
 * windows, tiling window managers leave it alone, so nothing outside the app
 * could move it either.
 *
 * On the display it is already on, it stays exactly where the user left it
 * (null). Back on a display it has been on, it returns to where it last sat
 * there, as long as that still fits the display's work area. On a display it
 * has not been on, it takes the same place there: its center keeps its
 * relative position in the work area, so a centered panel opens centered and
 * one dragged to a corner opens in that corner, shrunk to fit a smaller work
 * area and kept inside it. That mapping rounds, so without the remembered
 * spot each trip there and back could move the panel by a pixel.
 */
export function quickCaptureBoundsOnDisplay(input: {
  bounds: ScreenRect
  /** The display the panel is on now. */
  from: DisplayArea
  /** The display under the pointer. */
  to: DisplayArea
  /** Where the panel last sat on `to`, if it has been there. */
  remembered?: ScreenRect
}): ScreenRect | null {
  const { bounds, from, to, remembered } = input
  if (from.id === to.id) return null
  const source = from.workArea
  const area = to.workArea
  if (remembered && contains(area, remembered)) return { ...remembered }
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const fx = source.width > 0 ? clamp((bounds.x + bounds.width / 2 - source.x) / source.width, 0, 1) : 0.5
  const fy = source.height > 0 ? clamp((bounds.y + bounds.height / 2 - source.y) / source.height, 0, 1) : 0.5
  return {
    x: clamp(Math.round(area.x + fx * area.width - width / 2), area.x, area.x + area.width - width),
    y: clamp(Math.round(area.y + fy * area.height - height / 2), area.y, area.y + area.height - height),
    width,
    height
  }
}
