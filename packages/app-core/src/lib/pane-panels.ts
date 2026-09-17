import { CALENDAR_PANEL_CLOSED, type CalendarPanelState } from './calendar-panel-auto'

/**
 * Which right-hand panels an editor pane shows: Connections, Outline, Comments
 * and the Calendar (whose open carries the provenance bit from #502).
 *
 * Panels have always been sticky per pane, Obsidian-style: open the Outline
 * and it stays while you browse. With "Keep panels when switching notes" off,
 * a pane instead remembers one of these per note, the way it already remembers
 * each note's Edit / Split / Preview mode (#794). Like those modes the memory
 * is for the session only. It never belongs in the note, which is a plain
 * file; if it should outlive a restart, the workspace snapshot that already
 * restores tabs and layout is where it goes.
 */
export interface PanePanelsState {
  connections: boolean
  outline: boolean
  comments: boolean
  calendar: CalendarPanelState
  /**
   * The user closed the calendar on this note. Only written per note: there it
   * keeps the auto-open for daily and weekly notes from reopening a calendar
   * the note was told to forget. A sticky pane never sets it, so its auto-open
   * keeps firing on every arrival at a date note, as it always has (#502).
   */
  calendarDismissed: boolean
}

export type PanePanelsByPath = Record<string, PanePanelsState>

/** A note the pane has not seen yet starts with nothing open. */
export const PANE_PANELS_CLOSED: PanePanelsState = {
  connections: false,
  outline: false,
  comments: false,
  calendar: CALENDAR_PANEL_CLOSED,
  calendarDismissed: false
}

export function samePanePanels(a: PanePanelsState, b: PanePanelsState): boolean {
  return (
    a.connections === b.connections &&
    a.outline === b.outline &&
    a.comments === b.comments &&
    a.calendar.open === b.calendar.open &&
    a.calendar.auto === b.calendar.auto &&
    a.calendarDismissed === b.calendarDismissed
  )
}

export function panePanelsForPath(
  panelsByPath: PanePanelsByPath,
  path: string | null
): PanePanelsState {
  return path ? panelsByPath[path] ?? PANE_PANELS_CLOSED : PANE_PANELS_CLOSED
}

/**
 * The calendar after a write, with the per-note "dismissed" bit kept in step:
 * going from open to closed is the user (or Esc) putting it away on this note,
 * and any open clears that again.
 */
export function withCalendar(
  panels: PanePanelsState,
  calendar: CalendarPanelState,
  perNote: boolean
): PanePanelsState {
  const calendarDismissed = calendar.open
    ? false
    : perNote && panels.calendar.open
      ? true
      : panels.calendarDismissed
  return { ...panels, calendar, calendarDismissed }
}

/**
 * The map with `path` set to `panels`. A note whose panels are all closed is
 * dropped rather than stored, since closed is what an absent note reads as, so
 * the map only ever holds notes that differ from the default.
 */
export function panePanelsWithPath(
  panelsByPath: PanePanelsByPath,
  path: string | null,
  panels: PanePanelsState
): PanePanelsByPath {
  if (!path) return panelsByPath
  const current = panelsByPath[path]
  if (samePanePanels(panels, PANE_PANELS_CLOSED)) {
    if (!current) return panelsByPath
    const { [path]: _dropped, ...rest } = panelsByPath
    return rest
  }
  if (current && samePanePanels(current, panels)) return panelsByPath
  return { ...panelsByPath, [path]: panels }
}
