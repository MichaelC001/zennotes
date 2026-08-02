/**
 * WYSIWYG mermaid rendering for the editor's live preview (#530).
 *
 * A ```mermaid fence draws as the diagram while the cursor is elsewhere, and
 * turns back into its source the moment the cursor lands anywhere in the block,
 * which is the same bargain live preview strikes for math, tables and
 * wikilinks: what you can see is the result, what you can edit is the text.
 *
 * Two things make this cheap enough to run on a hot editor:
 *
 *   1. The mermaid module is imported lazily and only when a fence exists, so a
 *      note without diagrams never pulls the heaviest chunk in the renderer.
 *   2. Rendered SVG is cached by (source, theme mode) in `mermaid-render`, so a
 *      keystroke elsewhere in the note repaints from the cache, and moving the
 *      cursor in and out of a block costs nothing.
 *
 * A diagram mid-edit is usually invalid, so a failed render keeps the LAST good
 * drawing of that block on screen rather than flashing an error at every
 * keystroke. The error only takes over once the block is left alone and still
 * does not parse, which is the difference between a diagram you are typing and
 * one that is wrong.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`.
 */
import { syntaxTree } from '@codemirror/language'
import { Facet, RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

import { peekMermaidSvg, renderMermaidSvg } from './mermaid-render'

/** Which palette the widgets draw in. Rides a facet so a theme switch
 *  reconfigures the live-preview compartment and every diagram is redrawn,
 *  rather than leaving a dark note holding light-coloured diagrams. */
const diagramModeFacet = Facet.define<'light' | 'dark', 'light' | 'dark'>({
  combine: (values) => (values.length ? values[values.length - 1] : 'light')
})

/** The info string that marks a fence as mermaid: the language token only, so
 *  ```mermaid and ```mermaid title="x" both count. */
function isMermaidInfo(info: string): boolean {
  return info.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid'
}

/** Cursor/selection overlaps (or just touches an edge of) `[from, to]`. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (Math.max(range.from, from) <= Math.min(range.to, to)) return true
  }
  return false
}

/**
 * The last drawing of each block that rendered successfully, keyed by the
 * block's source. Keeps a diagram on screen while its text is being edited into
 * something momentarily invalid.
 */
const lastGood = new Map<string, string>()
const LAST_GOOD_LIMIT = 40

function rememberGood(source: string, svg: string): void {
  if (lastGood.size >= LAST_GOOD_LIMIT) {
    const oldest = lastGood.keys().next().value
    if (oldest !== undefined) lastGood.delete(oldest)
  }
  lastGood.set(source, svg)
}

class MermaidBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly mode: 'light' | 'dark'
  ) {
    super()
  }

  eq(other: MermaidBlockWidget): boolean {
    return other.source === this.source && other.mode === this.mode
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-mermaid-block'
    el.setAttribute('role', 'img')
    el.setAttribute('aria-label', 'Mermaid diagram')

    const cached = peekMermaidSvg(this.source, this.mode)
    if (cached?.ok) {
      el.innerHTML = cached.svg
      rememberGood(this.source, cached.svg)
      return el
    }

    // Nothing drawn yet: show the previous good diagram if this block has one,
    // otherwise leave the space empty rather than collapsing the line and
    // making the note jump as diagrams arrive.
    const previous = lastGood.get(this.source)
    if (previous) el.innerHTML = previous
    else el.classList.add('cm-mermaid-pending')

    void renderMermaidSvg(this.source, this.mode).then((result) => {
      // The widget may have been replaced while mermaid was working (a
      // keystroke, a cursor move). Writing into a detached node is harmless and
      // the live widget renders from the cache, so no check is needed beyond
      // this one for a node that is still ours.
      if (result.ok) {
        el.innerHTML = result.svg
        el.classList.remove('cm-mermaid-pending', 'cm-mermaid-error')
        el.removeAttribute('title')
        rememberGood(this.source, result.svg)
        return
      }
      if (lastGood.has(this.source)) return // keep the last good drawing
      el.classList.remove('cm-mermaid-pending')
      el.classList.add('cm-mermaid-error')
      el.textContent = `Mermaid error: ${result.error}`
    })
    return el
  }

  // Let CodeMirror handle clicks, so clicking a diagram puts the cursor in the
  // block and reveals its source. Without this the only way in is the keyboard.
  ignoreEvent(): boolean {
    return false
  }
}

/** 1-based line span of one rendered block, for the navigation helpers. */
export interface MermaidBlockLineRange {
  fromLine: number
  toLine: number
}

interface MermaidRenderValue {
  decorations: DecorationSet
  /** Every mermaid fence, rendered or revealed, so vertical motion can step
   *  INTO one instead of sailing over a widget with no cursor positions in it. */
  blockLines: readonly MermaidBlockLineRange[]
}

function buildMermaidDecorations(state: EditorState): MermaidRenderValue {
  const mode = state.facet(diagramModeFacet)
  const builder = new RangeSetBuilder<Decoration>()
  const blockLines: MermaidBlockLineRange[] = []
  const tree = syntaxTree(state)

  tree.iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      const from = node.from
      const to = node.to
      // The info string lives on the opening line, after the fence marker.
      const openLine = state.doc.lineAt(from)
      const info = openLine.text.replace(/^\s*(?:`{3,}|~{3,})/, '')
      if (!isMermaidInfo(info)) return

      const closeLine = state.doc.lineAt(to)
      // Recorded whether or not it is rendered right now: the navigation
      // helpers need to know a block is THERE to step into it, and once the
      // cursor is inside, that it may leave normally.
      blockLines.push({ fromLine: openLine.number, toLine: closeLine.number })

      // Editing it? Then it is text, not a picture.
      if (selectionTouches(state, from, to)) return
      // Body is everything between the fences. A fence with no body has nothing
      // to draw and is left as source so it can be typed into.
      if (closeLine.number - openLine.number < 2) return
      const body = state.doc
        .sliceString(openLine.to + 1, state.doc.line(closeLine.number - 1).to)
        .trim()
      if (body === '') return

      builder.add(
        openLine.from,
        closeLine.to,
        Decoration.replace({ block: true, widget: new MermaidBlockWidget(body, mode) })
      )
    }
  })

  return { decorations: builder.finish(), blockLines }
}

const mermaidRenderField = StateField.define<MermaidRenderValue>({
  create: (state) => buildMermaidDecorations(state),
  update(value, tr) {
    // Rebuild on edits, on cursor moves (to reveal or hide the active block),
    // when the parser advances (the fence may only now be recognised), and when
    // the palette changes.
    if (
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.startState.facet(diagramModeFacet) !== tr.state.facet(diagramModeFacet)
    ) {
      return buildMermaidDecorations(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/**
 * 1-based line ranges of every mermaid fence in the document, or `[]` when
 * mermaid rendering is not active in this editor. Read by the arrow-key and
 * Vim `j`/`k` helpers, which otherwise sail straight over a rendered block: it
 * is one widget with no cursor coordinates inside it, so pixel-based vertical
 * motion has nowhere to land and a keyboard-only user could never open the
 * source. (#530)
 */
export function mermaidBlockLineRanges(state: EditorState): readonly MermaidBlockLineRange[] {
  return state.field(mermaidRenderField, false)?.blockLines ?? []
}

/** Live-preview mermaid rendering, drawn in the given palette. */
export function mermaidRenderExtension(mode: 'light' | 'dark'): Extension {
  return [diagramModeFacet.of(mode), mermaidRenderField]
}
