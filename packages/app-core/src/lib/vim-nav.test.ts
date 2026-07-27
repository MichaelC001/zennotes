// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { TASKS_TAB_PATH } from '@shared/tasks'
import { databaseTabPath } from '@shared/databases'

const cmMock = vi.hoisted(() => ({ vim: undefined as unknown }))
vi.mock('@replit/codemirror-vim', () => ({
  getCM: () => ({ state: { vim: cmMock.vim } })
}))

import {
  getVisiblePanels,
  getVisiblePanelsNow,
  hintTargetOpensNote,
  isVimAwaitingArgument,
  resolveNextPanel,
  shouldYieldToHomeNav,
  type Panel,
  type PanelVisibility
} from './vim-nav'

function el(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html.trim()
  return container.firstElementChild as HTMLElement
}

describe('hintTargetOpensNote (#100 — hint into a note lands in the editor)', () => {
  it('is true for a sidebar note row', () => {
    expect(hintTargetOpensNote(el('<button data-sidebar-path="inbox/Note.md">Note</button>'))).toBe(
      true
    )
  })

  it('is true for a note tab (path carried on an ancestor)', () => {
    const tab = el('<div data-tab-path="inbox/Note.md"><button>close</button></div>')
    expect(hintTargetOpensNote(tab.querySelector('button'))).toBe(true)
  })

  it('is false for the Tasks tab (a virtual tab focuses itself)', () => {
    const tab = el(`<div data-tab-path="${TASKS_TAB_PATH}"><button>x</button></div>`)
    expect(hintTargetOpensNote(tab.querySelector('button'))).toBe(false)
  })

  it('is false for a database tab', () => {
    const tab = el(`<div data-tab-path="${databaseTabPath('Projects.csv')}"><button>x</button></div>`)
    expect(hintTargetOpensNote(tab.querySelector('button'))).toBe(false)
  })

  it('is false for a folder row (no data-sidebar-path)', () => {
    expect(
      hintTargetOpensNote(
        el('<button data-sidebar-type="folder" data-sidebar-key="Projects">Projects</button>')
      )
    ).toBe(false)
  })

  it('is false for a plain button and for null', () => {
    expect(hintTargetOpensNote(el('<button>Settings</button>'))).toBe(false)
    expect(hintTargetOpensNote(null)).toBe(false)
  })
})

describe('shouldYieldToHomeNav (#273 — Space leader must work on the home view)', () => {
  const homeTarget = (): HTMLElement => {
    const home = el('<div data-home-nav><button data-home-item>Recent</button></div>')
    return home.querySelector('button') as HTMLElement
  }

  it('yields for a non-leader key (home view owns j/k/arrows/Enter)', () => {
    expect(shouldYieldToHomeNav(homeTarget(), false, false)).toBe(true)
  })

  it('does NOT yield for the leader key — it falls through to VimNav', () => {
    expect(shouldYieldToHomeNav(homeTarget(), true, false)).toBe(false)
  })

  it('does NOT yield while a leader sequence is pending', () => {
    expect(shouldYieldToHomeNav(homeTarget(), false, true)).toBe(false)
  })

  it('is false outside the home view, so VimNav handles keys normally', () => {
    expect(shouldYieldToHomeNav(el('<button>Settings</button>'), false, false)).toBe(false)
    expect(shouldYieldToHomeNav(null, false, false)).toBe(false)
  })
})

describe('isVimAwaitingArgument (#147 — Space is the Vim arg, not the leader)', () => {
  const view = {} as unknown as EditorView // getCM is mocked, so the view is unused

  it('is true while a partial command is buffered (f/t/r, operators, counts)', () => {
    cmMock.vim = { inputState: { keyBuffer: ['f'] } }
    expect(isVimAwaitingArgument(view)).toBe(true)
  })

  it('is true when a literal next character is expected (e.g. r)', () => {
    cmMock.vim = { expectLiteralNext: true, inputState: { keyBuffer: [] } }
    expect(isVimAwaitingArgument(view)).toBe(true)
  })

  it('is false when Vim is at rest', () => {
    cmMock.vim = { expectLiteralNext: false, inputState: { keyBuffer: [] } }
    expect(isVimAwaitingArgument(view)).toBe(false)
  })

  it('is false with no vim state, and for a null view', () => {
    cmMock.vim = null
    expect(isVimAwaitingArgument(view)).toBe(false)
    expect(isVimAwaitingArgument(null)).toBe(false)
  })
})

describe('getVisiblePanels — the focus cycle (#285, #477)', () => {
  const visibility = (over: Partial<PanelVisibility> = {}): PanelVisibility => ({
    sidebarOpen: true,
    noteListOpen: true,
    unifiedSidebar: false,
    connectionsOpen: false,
    commentsOpen: false,
    outlineOpen: false,
    calendarOpen: false,
    tasksViewOpen: false,
    ...over
  })

  it('appends the calendar last (after connections/comments) when open', () => {
    expect(getVisiblePanels(visibility({ calendarOpen: true }))).toEqual([
      'sidebar',
      'notelist',
      'editor',
      'calendar'
    ])
    expect(
      getVisiblePanels(visibility({ connectionsOpen: true, commentsOpen: true, calendarOpen: true }))
    ).toEqual(['sidebar', 'notelist', 'editor', 'connections', 'comments', 'calendar'])
  })

  it('omits the calendar when it is closed', () => {
    expect(getVisiblePanels(visibility())).not.toContain('calendar')
    expect(getVisiblePanels(visibility({ calendarOpen: false }))).not.toContain('calendar')
  })

  it('slots the outline between comments and calendar, matching how they render (#477)', () => {
    expect(
      getVisiblePanels(
        visibility({
          connectionsOpen: true,
          commentsOpen: true,
          outlineOpen: true,
          calendarOpen: true
        })
      )
    ).toEqual([
      'sidebar',
      'notelist',
      'editor',
      'connections',
      'comments',
      'outline',
      'calendar'
    ])
    expect(getVisiblePanels(visibility())).not.toContain('outline')
  })

  it('resolveNextPanel reaches the calendar from the editor and stays at the edge', () => {
    const panels = getVisiblePanels(visibility({ calendarOpen: true }))
    expect(resolveNextPanel('editor', 'right', panels)).toBe('calendar')
    // Calendar is the right-most panel, so going further right is a no-op.
    expect(resolveNextPanel('calendar', 'right', panels)).toBe('calendar')
    expect(resolveNextPanel('calendar', 'left', panels)).toBe('editor')
  })

  it('reads the open side panels off the DOM so both navigations see the same list (#477)', () => {
    document.body.innerHTML = `
      <div data-connections-panel></div>
      <div data-outline-panel></div>
      <div data-calendar-panel></div>
    `
    expect(
      getVisiblePanelsNow({
        sidebarOpen: true,
        noteListOpen: false,
        unifiedSidebar: false,
        tasksViewOpen: false
      })
    ).toEqual(['sidebar', 'editor', 'connections', 'outline', 'calendar'])
    document.body.innerHTML = ''
  })

  it('walks every open panel in order, so no panel is a dead end (#477)', () => {
    const panels = getVisiblePanels(
      visibility({ connectionsOpen: true, commentsOpen: true, outlineOpen: true, calendarOpen: true })
    )
    const walk: Panel[] = ['editor']
    for (let i = 0; i < 4; i++) {
      const next = resolveNextPanel(walk[walk.length - 1], 'right', panels)
      if (!next) break
      walk.push(next)
    }
    expect(walk).toEqual(['editor', 'connections', 'comments', 'outline', 'calendar'])
    // …and back again.
    expect(resolveNextPanel('outline', 'left', panels)).toBe('comments')
    expect(resolveNextPanel('connections', 'left', panels)).toBe('editor')
  })
})
