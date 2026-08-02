// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState, type EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { mermaidBlockLineRanges, mermaidRenderExtension } from './cm-mermaid-render'

// mermaid itself is never loaded here: the widget paints asynchronously and
// these tests are about WHICH blocks become widgets and where their lines are,
// which is decided before any rendering happens. Stubbing keeps the heaviest
// chunk in the app out of the test run entirely.
vi.mock('./mermaid-render', () => ({
  peekMermaidSvg: () => null,
  renderMermaidSvg: () => new Promise(() => {})
}))

function mount(doc: string, selection?: EditorSelection | { anchor: number }): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: selection ?? { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), mermaidRenderExtension('light')]
    })
  })
  forceParsing(view, doc.length, 5000)
  // Nudge a rebuild so decorations reflect the fully parsed tree.
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

const DIAGRAM = 'start\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nend'

describe('mermaidRenderExtension', () => {
  it('draws a mermaid fence while the cursor is elsewhere', () => {
    const view = mount(DIAGRAM)
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(1)
    view.destroy()
  })

  it('reveals the source while the cursor is inside the block', () => {
    // Anchor on the `flowchart LR` line, i.e. inside the fence.
    const view = mount(DIAGRAM, { anchor: DIAGRAM.indexOf('flowchart') + 2 })
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(0)
    view.destroy()
  })

  it('leaves other languages alone', () => {
    const view = mount('start\n\n```ts\nconst a = 1\n```\n\nend')
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(0)
    view.destroy()
  })

  it('accepts an info string with extra words after the language', () => {
    const view = mount('start\n\n```mermaid title="Flow"\nflowchart LR\n  A --> B\n```\n\nend')
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(1)
    view.destroy()
  })

  it('leaves an empty fence as source, since there is nothing to draw', () => {
    const view = mount('start\n\n```mermaid\n```\n\nend')
    expect(view.dom.querySelectorAll('.cm-mermaid-block').length).toBe(0)
    view.destroy()
  })

  // A rendered block is one widget with no cursor coordinates inside it, so
  // vertical motion sails over it unless the nav helpers know the block is
  // there. Without these ranges a keyboard-only user can never open the source.
  describe('mermaidBlockLineRanges', () => {
    it('reports the fence line span, fences included', () => {
      const view = mount(DIAGRAM)
      expect(mermaidBlockLineRanges(view.state)).toEqual([{ fromLine: 3, toLine: 6 }])
      view.destroy()
    })

    it('still reports the block while its source is revealed', () => {
      const view = mount(DIAGRAM, { anchor: DIAGRAM.indexOf('flowchart') + 2 })
      expect(mermaidBlockLineRanges(view.state)).toEqual([{ fromLine: 3, toLine: 6 }])
      view.destroy()
    })

    it('is empty when the extension is not installed', () => {
      const parent = document.createElement('div')
      document.body.append(parent)
      const plain = new EditorView({
        parent,
        state: EditorState.create({
          doc: DIAGRAM,
          extensions: [markdown({ base: markdownLanguage })]
        })
      })
      expect(mermaidBlockLineRanges(plain.state)).toEqual([])
      plain.destroy()
    })
  })
})
