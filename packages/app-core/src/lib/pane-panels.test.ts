import { describe, expect, it } from 'vitest'
import { CALENDAR_PANEL_CLOSED } from './calendar-panel-auto'
import {
  PANE_PANELS_CLOSED,
  panePanelsForPath,
  panePanelsWithPath,
  withCalendar,
  type PanePanelsState
} from './pane-panels'

const outlineOpen: PanePanelsState = { ...PANE_PANELS_CLOSED, outline: true }

describe('per-note panels (#794)', () => {
  it('reads a note the pane has not seen yet as all closed', () => {
    expect(panePanelsForPath({}, 'inbox/A.md')).toEqual(PANE_PANELS_CLOSED)
    expect(panePanelsForPath({ 'inbox/A.md': outlineOpen }, 'inbox/B.md')).toEqual(
      PANE_PANELS_CLOSED
    )
    expect(panePanelsForPath({ 'inbox/A.md': outlineOpen }, null)).toEqual(PANE_PANELS_CLOSED)
  })

  it('remembers each note separately', () => {
    const map = panePanelsWithPath({}, 'inbox/A.md', outlineOpen)
    expect(panePanelsForPath(map, 'inbox/A.md').outline).toBe(true)
    expect(panePanelsForPath(map, 'inbox/B.md').outline).toBe(false)
  })

  it('returns the same map when nothing changed, so the store does not notify', () => {
    const map = { 'inbox/A.md': outlineOpen }
    expect(panePanelsWithPath(map, 'inbox/A.md', { ...outlineOpen })).toBe(map)
    expect(panePanelsWithPath(map, null, PANE_PANELS_CLOSED)).toBe(map)
    expect(panePanelsWithPath(map, 'inbox/B.md', PANE_PANELS_CLOSED)).toBe(map)
  })

  it('drops a note whose panels are all closed instead of storing the default', () => {
    const map = panePanelsWithPath({ 'inbox/A.md': outlineOpen }, 'inbox/A.md', PANE_PANELS_CLOSED)
    expect(map).toEqual({})
  })

  // Closed-by-the-user has to survive as an entry, or a daily note's calendar
  // would auto-open again every time you came back to it.
  it('keeps a note whose only memory is a calendar the user put away', () => {
    const open = withCalendar(PANE_PANELS_CLOSED, { open: true, auto: true }, true)
    const dismissed = withCalendar(open, CALENDAR_PANEL_CLOSED, true)
    expect(dismissed.calendarDismissed).toBe(true)
    expect(panePanelsWithPath({}, 'daily/today.md', dismissed)).toEqual({
      'daily/today.md': dismissed
    })
  })

  it('forgets the dismissal as soon as the calendar is opened again', () => {
    const dismissed = { ...PANE_PANELS_CLOSED, calendarDismissed: true }
    expect(withCalendar(dismissed, { open: true, auto: false }, true).calendarDismissed).toBe(false)
  })

  it('never records a dismissal for a sticky pane, whose auto-open keeps firing (#502)', () => {
    const open = withCalendar(PANE_PANELS_CLOSED, { open: true, auto: true }, false)
    expect(withCalendar(open, CALENDAR_PANEL_CLOSED, false).calendarDismissed).toBe(false)
  })
})
