// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { getCM, Vim, vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it } from 'vitest'
import { registerDisplayLineMotion } from './cm-vim-display-line'
import { vimAwareDefaultKeymap, vimAwareMarkdownKeymap } from './cm-vim-default-keymap'
import { vimVisualHighlightExtension } from './cm-vim-visual-highlight'
import { vimClipboardPasteExtension } from './cm-vim-clipboard'

const views: EditorView[] = []

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
})

function mount(doc: string, anchor = 0): EditorView {
  registerDisplayLineMotion(() => 'logical')
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        vim(),
        vimVisualHighlightExtension,
        vimClipboardPasteExtension,
        markdown({ base: markdownLanguage, addKeymap: false }),
        vimAwareMarkdownKeymap,
        keymap.of(vimAwareDefaultKeymap(true))
      ]
    })
  })
  views.push(view)
  return view
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
  )
}

function selectFirstColumn(view: EditorView): void {
  press(view, 'v', { ctrlKey: true })
  press(view, 'j')
  press(view, 'j')
  expect(getCM(view)?.state.vim?.visualBlock).toBe(true)
}

function insertText(view: EditorView, text: string): void {
  expect(getCM(view)?.state.vim?.insertMode).toBe(true)
  // jsdom does not type into contenteditable. Apply the ordinary CM6 text
  // input transaction so the real Vim adapter observes the insertion.
  view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.type' })
  press(view, 'Escape')
}

describe('Vim visual-block editing (#792)', () => {
  it('prefixes every selected row with I, typed text, and Escape', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'I')
    insertText(view, '- ')

    expect(view.state.doc.toString()).toBe('- one\n- two\n- three')
    expect(getCM(view)?.state.vim?.insertMode).toBe(false)
  })

  it('appends at the selected block edge with A instead of the logical line end', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'A')
    insertText(view, '!')

    expect(view.state.doc.toString()).toBe('o!ne\nt!wo\nt!hree')
  })

  it('prefixes every row when the block was selected from bottom to top', () => {
    const view = mount('one\ntwo\nthree', 8)
    press(view, 'v', { ctrlKey: true })
    press(view, 'k')
    press(view, 'k')

    press(view, 'I')
    insertText(view, '- ')

    expect(view.state.doc.toString()).toBe('- one\n- two\n- three')
  })

  it('deletes the selected columns on every row without joining the lines', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'd')

    expect(view.state.doc.toString()).toBe('ne\nwo\nhree')
  })

  it('changes the selected column on every row and returns to normal mode', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, 'c')
    insertText(view, 'X')

    expect(view.state.doc.toString()).toBe('Xne\nXwo\nXhree')
    expect(getCM(view)?.state.vim?.insertMode).toBe(false)
  })

  it('yanks the whole rectangle into a blockwise register without editing the note', () => {
    const view = mount('one\ntwo\nthree')
    selectFirstColumn(view)

    press(view, '"')
    press(view, 'a')
    press(view, 'y')

    const register = Vim.getRegisterController().getRegister('a')
    expect(register.toString()).toBe('o\nt\nt')
    expect(register.blockwise).toBe(true)
    expect(view.state.doc.toString()).toBe('one\ntwo\nthree')
  })

  it('pastes a yanked rectangle as one inserted column per destination row', () => {
    const view = mount('one\ntwo\nthree\n---\n...\n...')
    selectFirstColumn(view)
    for (const key of ['"', 'a', 'y', '3', 'j', '"', 'a', 'P']) press(view, key)

    expect(view.state.doc.toString()).toBe('one\ntwo\nthree\no---\nt...\nt...')
  })

  it('leaves shorter rows and their newlines intact when deleting a later column', () => {
    const view = mount('abcd\nx\nwxyz', 2)
    press(view, 'v', { ctrlKey: true })
    press(view, '2')
    press(view, 'j')

    press(view, 'd')

    expect(view.state.doc.toString()).toBe('abd\nx\nwxz')
  })
})

describe('Vim line-boundary insertion outside visual mode', () => {
  it.each([
    ['I', '  !one\ntwo'],
    ['A', '  one!\ntwo']
  ])('keeps normal-mode %s on the current logical line', (key, expected) => {
    const view = mount('  one\ntwo', 3)

    press(view, key)
    insertText(view, '!')

    expect(view.state.doc.toString()).toBe(expected)
  })
})
