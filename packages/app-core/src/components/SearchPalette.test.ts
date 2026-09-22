// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { useToastStore } from '../lib/toast'
import { SearchPalette } from './SearchPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const confirmApp = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../lib/confirm-requests', () => ({ confirmApp }))
// Closing the palette hands focus back to the editor with a few timed retries;
// there is no editor here and the retries would outlive the jsdom window.
const focusEditorNormalMode = vi.hoisted(() => vi.fn())
vi.mock('../lib/editor-focus', () => ({ focusEditorNormalMode }))

function note(title: string): NoteMeta {
  return {
    path: `inbox/${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

describe('SearchPalette: Ctrl+D moves the highlighted note to Trash', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined
  let moveToTrash: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    confirmApp.mockClear()
    confirmApp.mockResolvedValue(true)

    const notes = [note('Alpha'), note('Beta'), note('Gamma')]
    moveToTrash = vi.fn(async (path: string) => ({
      ...notes.find((n) => n.path === path)!,
      path: path.replace('inbox/', 'trash/'),
      folder: 'trash' as const
    }))
    ;(window as unknown as { zen: unknown }).zen = { moveToTrash }
    useStore.setState({
      notes,
      selectedPath: null,
      noteContents: {},
      noteDirty: {},
      searchOpen: true,
      // The real refresh re-lists the vault through the bridge; here the
      // listing just forgets whatever was trashed.
      refreshNotes: async () => {
        const trashed = new Set(moveToTrash.mock.calls.map((call) => call[0] as string))
        useStore.setState({ notes: notes.filter((n) => !trashed.has(n.path)) })
      }
    })
    useToastStore.setState({ toasts: [] })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    delete (window as unknown as { zen?: unknown }).zen
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  const input = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>('input[placeholder^="Search notes"]')
    if (!el) throw new Error('search input not rendered')
    return el
  }
  const rows = (): string[] =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-search-idx]')].map(
      (row) => row.textContent?.replace(/inbox$/i, '').trim() ?? ''
    )
  const ctrlD = async (): Promise<void> => {
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('trashes the highlighted note, keeps the palette open, and drops the row', async () => {
    act(() => root.render(createElement(SearchPalette)))
    expect(rows()).toEqual(['Alpha', 'Beta', 'Gamma'])

    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    await ctrlD()

    expect(confirmApp).toHaveBeenCalledTimes(1)
    expect(moveToTrash).toHaveBeenCalledWith('inbox/Beta.md')
    expect(useStore.getState().searchOpen).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(rows()).toEqual(['Alpha', 'Gamma'])
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Moved "Beta" to Trash'
    )
    // The highlight stays on the row that took Beta's place.
    expect(document.querySelector('[data-search-idx="1"]')?.className).toContain('bg-paper-200')
  })

  it('does nothing when the confirmation is declined', async () => {
    confirmApp.mockResolvedValue(false)
    act(() => root.render(createElement(SearchPalette)))
    await ctrlD()
    expect(moveToTrash).not.toHaveBeenCalled()
    expect(rows()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('clamps the highlight when the last row is trashed', async () => {
    act(() => root.render(createElement(SearchPalette)))
    for (let i = 0; i < 2; i++) {
      act(() => {
        input().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        )
      })
    }
    await ctrlD()
    expect(moveToTrash).toHaveBeenCalledWith('inbox/Gamma.md')
    expect(rows()).toEqual(['Alpha', 'Beta'])
    expect(document.querySelector('[data-search-idx="1"]')?.className).toContain('bg-paper-200')
  })
})

// #826: a search that finds no note with the typed name offers to create it,
// Obsidian-style: a create row after the results, and Shift+Enter from anywhere.
describe('SearchPalette: Shift+Enter creates the note the search names', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined
  let createAndOpen: ReturnType<typeof vi.fn>
  let selectNote: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })

    createAndOpen = vi.fn(async () => {})
    selectNote = vi.fn(async () => {})
    focusEditorNormalMode.mockClear()
    useStore.setState({
      notes: [note('Alpha'), note('Beta'), { ...note('Roadmap'), path: 'inbox/projects/Roadmap.md' }],
      selectedPath: null,
      noteContents: {},
      noteDirty: {},
      searchOpen: true,
      createAndOpen: createAndOpen as unknown as ReturnType<typeof useStore.getState>['createAndOpen'],
      selectNote: selectNote as unknown as ReturnType<typeof useStore.getState>['selectNote']
    })
    act(() => root.render(createElement(SearchPalette)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  const input = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>('input[placeholder^="Search notes"]')
    if (!el) throw new Error('search input not rendered')
    return el
  }
  const type = (text: string): void => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input(), text)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const key = async (key: string, init: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  const createRow = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-search-create]')
  const highlighted = (): string | null =>
    document.querySelector<HTMLElement>('[data-search-idx].bg-paper-200')?.dataset.searchIdx ?? null

  it('shows a create row for a name no note has, and Shift+Enter creates it in Inbox', async () => {
    type('Meeting notes')
    expect(createRow()?.textContent).toBe('Create "Meeting notes"inbox')
    expect(document.body.textContent).not.toContain('No matches.')

    await key('Enter', { shiftKey: true })

    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Meeting notes' })
    expect(selectNote).not.toHaveBeenCalled()
    expect(useStore.getState().searchOpen).toBe(false)
    // The name is settled, so the new note opens with the editor focused
    // (like `:e name`), not with the title field waiting for one.
    expect(focusEditorNormalMode).toHaveBeenCalledTimes(1)
  })

  it('appends the row after fuzzy matches and Enter on it creates, arrows reaching it', async () => {
    type('Alph')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-search-idx]')]
    expect(rows.map((r) => r.dataset.searchIdx)).toEqual(['0', '1'])
    expect(rows[0].textContent).toBe('Alphainbox')
    expect(rows[1].hasAttribute('data-search-create')).toBe(true)
    expect(highlighted()).toBe('0')

    await key('ArrowDown')
    expect(highlighted()).toBe('1')
    // The create row is the last stop.
    await key('ArrowDown')
    expect(highlighted()).toBe('1')

    await key('Enter')
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Alph' })
    expect(selectNote).not.toHaveBeenCalled()
  })

  it('plain Enter on a match still opens it, never creates', async () => {
    type('Alph')
    await key('Enter')
    expect(selectNote).toHaveBeenCalledWith('inbox/Alpha.md')
    expect(createAndOpen).not.toHaveBeenCalled()
  })

  it('a typed path nests the note and the row shows the destination', async () => {
    type('projects/ideas/Q4 plan')
    expect(createRow()?.textContent).toBe('Create "Q4 plan"inbox/projects/ideas')

    await key('Enter', { shiftKey: true })
    expect(createAndOpen).toHaveBeenCalledWith('inbox', 'projects/ideas', { title: 'Q4 plan' })
  })

  it('hides the row when a note already has that exact name, and Shift+Enter opens it', async () => {
    type('roadmap')
    expect(createRow()).toBeNull()

    await key('Enter', { shiftKey: true })
    expect(selectNote).toHaveBeenCalledWith('inbox/projects/Roadmap.md')
    expect(createAndOpen).not.toHaveBeenCalled()
    expect(useStore.getState().searchOpen).toBe(false)
  })

  it('offers nothing for an empty or tag-only query, or a name that cannot be a file', async () => {
    expect(createRow()).toBeNull()
    await key('Enter', { shiftKey: true })
    expect(createAndOpen).not.toHaveBeenCalled()
    expect(useStore.getState().searchOpen).toBe(true)

    type('#ops')
    expect(createRow()).toBeNull()
    await key('Enter', { shiftKey: true })
    expect(createAndOpen).not.toHaveBeenCalled()

    type('why?')
    expect(createRow()).toBeNull()
    expect(document.body.textContent).toContain('No matches.')
    await key('Enter', { shiftKey: true })
    expect(createAndOpen).not.toHaveBeenCalled()
    expect(useStore.getState().searchOpen).toBe(true)
  })

  it('tags in the query filter the results but never name the note', async () => {
    type('#ops Runbook')
    expect(createRow()?.textContent).toBe('Create "Runbook"inbox')
    await key('Enter', { shiftKey: true })
    expect(createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Runbook' })
  })
})
