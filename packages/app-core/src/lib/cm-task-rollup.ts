/**
 * #512: the editor half of derived subtask progress. A parent task line with
 * subtasks gets a `2/5` chip at the end of the line, recomputed from the
 * document on every edit and never written into the text; the counting rule
 * lives in `task-rollup.ts`, shared with the reading view's remark plugin.
 *
 * WYSIWYG-only: registered via the same extension list as the metadata chips.
 */
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { isTagSkippedContext } from './cm-hashtags'
import { LIST_ITEM_RE, computeTaskRollups } from './task-rollup'

class RollupWidget extends WidgetType {
  constructor(
    readonly done: number,
    readonly total: number
  ) {
    super()
  }
  override eq(other: RollupWidget): boolean {
    return other.done === this.done && other.total === this.total
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className =
      this.done === this.total
        ? 'cm-task-meta cm-task-rollup cm-task-rollup-complete'
        : 'cm-task-meta cm-task-rollup'
    span.textContent = `${this.done}/${this.total}`
    return span
  }
  override ignoreEvent(): boolean {
    return true
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const doc = state.doc
  const builder = new RangeSetBuilder<Decoration>()
  const lineTextAt = (n: number): string | null => {
    if (n < 1 || n > doc.lines) return null
    const line = doc.line(n)
    // A list-shaped line inside a code fence is prose, not a task; hand the
    // walk a null so it neither counts nor closes anything.
    if (LIST_ITEM_RE.test(line.text) && isTagSkippedContext(state, line.from)) return null
    return line.text
  }
  for (const { from, to } of view.visibleRanges) {
    const firstLine = doc.lineAt(from).number
    const lastLine = doc.lineAt(Math.max(from, to - 1)).number
    const rollups = computeTaskRollups(lineTextAt, firstLine, lastLine, doc.lines)
    for (const n of [...rollups.keys()].sort((a, b) => a - b)) {
      const rollup = rollups.get(n)
      if (!rollup) continue
      const line = doc.line(n)
      builder.add(
        line.to,
        line.to,
        Decoration.widget({ widget: new RollupWidget(rollup.done, rollup.total), side: 1 })
      )
    }
  }
  return builder.finish()
}

const taskRollupPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

export const taskRollupExtension = [taskRollupPlugin]
