/**
 * Derived subtask progress for parent task lines (#512).
 *
 * A parent task with subtasks shows how far along its children are, as a
 * `2/5` chip next to the line. The count is computed from the document every
 * time it renders and is never written back: ZenNotes is not the only writer
 * of a vault, and a marker written into the parent goes stale the moment
 * Obsidian, vim or the phone checks a child off. Derived display is always
 * right no matter who edited the file.
 *
 * One counting rule, two renderers: the CodeMirror widget in
 * `cm-task-rollup.ts` and the remark plugin in `markdown.ts` both count with
 * the helpers here, so a parent can never say 2/5 in the editor and 3/5 in
 * the reading view.
 *
 * What counts: direct child tasks only, one nesting level down, matching the
 * list structure the reading view sees. Grandchildren roll into their own
 * parent. Cancelled (`[-]`) and forwarded (`[>]`) children leave the flow
 * entirely, so they are out of the denominator; an in-progress (`[/]`) child
 * counts as not yet done. A non-task bullet between parent and a deeper task
 * blocks the rollup the same way the mdast tree does: that task belongs to
 * the bullet, not to the task above it.
 */
import { TASK_LINE_RE } from '@shared/tasklists'

export interface TaskRollup {
  done: number
  total: number
}

/** Any list item line (task or not): its indent prefix (list nesting, with
 *  blockquote markers folded in) and the bullet. Exported so the editor
 *  plugin can pre-filter which lines are worth a code-fence check. */
export const LIST_ITEM_RE = /^(\s*(?:>\s*)*)(?:[-+*]|\d+[.)])\s/

export type ChildTaskState = 'open' | 'done' | 'in-progress' | 'cancelled' | 'forwarded'

function childStateForChar(ch: string): ChildTaskState {
  if (ch === 'x' || ch === 'X') return 'done'
  if (ch === '/') return 'in-progress'
  if (ch === '-') return 'cancelled'
  if (ch === '>') return 'forwarded'
  return 'open'
}

/** Cancelled and forwarded children are no longer this list's work, so they
 *  do not dilute the parent's progress. */
export function rollupCountsChild(state: ChildTaskState): boolean {
  return state === 'open' || state === 'done' || state === 'in-progress'
}

export function rollupChildDone(state: ChildTaskState): boolean {
  return state === 'done'
}

interface StackEntry {
  line: number
  indent: number
  isTask: boolean
  rollup: TaskRollup
}

/**
 * One downward pass over the document, maintaining the stack of open list
 * items. Returns the rollup for every parent task line in
 * `[firstLine, lastLine]` that has at least one countable child. The walk
 * continues past `lastLine` while items are still open, so a parent at the
 * bottom of the viewport counts its whole subtree, and stops as soon as the
 * stack empties beyond the range.
 *
 * `lineTextAt` returns null for lines the caller wants ignored (past the end
 * of the document, or task-shaped lines inside code fences); a null line
 * leaves the stack untouched, like a blank one.
 */
export function computeTaskRollups(
  lineTextAt: (n: number) => string | null,
  firstLine: number,
  lastLine: number,
  lineCount: number
): Map<number, TaskRollup> {
  const result = new Map<number, TaskRollup>()
  const stack: StackEntry[] = []

  const close = (entry: StackEntry): void => {
    if (
      entry.isTask &&
      entry.rollup.total > 0 &&
      entry.line >= firstLine &&
      entry.line <= lastLine
    ) {
      result.set(entry.line, entry.rollup)
    }
  }

  for (let n = firstLine; n <= lineCount; n++) {
    if (n > lastLine && stack.length === 0) break
    const text = lineTextAt(n)
    if (text === null || text.trim() === '') continue

    const item = LIST_ITEM_RE.exec(text)
    if (!item) {
      // Plain text at or left of an item's indent ends that item (a heading,
      // a paragraph after the list); deeper text is the item's own body.
      const indent = (/^(\s*(?:>\s*)*)/.exec(text) as RegExpExecArray)[1].length
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        close(stack.pop() as StackEntry)
      }
      continue
    }

    const indent = item[1].length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      close(stack.pop() as StackEntry)
    }

    const task = TASK_LINE_RE.exec(text)
    if (task) {
      const parent = stack[stack.length - 1]
      if (parent && parent.isTask) {
        const state = childStateForChar(task[2])
        if (rollupCountsChild(state)) {
          parent.rollup.total += 1
          if (rollupChildDone(state)) parent.rollup.done += 1
        }
      }
    }
    stack.push({ line: n, indent, isTask: task !== null, rollup: { done: 0, total: 0 } })
  }

  while (stack.length > 0) close(stack.pop() as StackEntry)
  return result
}
