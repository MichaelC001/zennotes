// Pure rules behind RUNNING a workflow, as opposed to planning one.
//
// Planning is `@shared/workflows/engine`, which structurally cannot write.
// Applying is the main process. What lives here is everything in between: which
// paths a plan would write, which of those the author is still editing, the
// exact sentence shown before anything is applied, and the record left behind
// afterwards.
//
// Every function here produces something a person reads immediately before or
// after their vault changes, so each one is worth testing without mounting
// React. Nothing in this file writes, and nothing in it touches the bridge.

import type { NoteTemplate } from '@bridge-contract/templates'
import type { WorkflowRunReceipt, WorkflowUndoResult } from '@bridge-contract/workflows'
import { slugifyTemplateName } from '@shared/template-files'
import type { Diagnostic, Workflow, WorkflowOp } from '@shared/workflows/types'
import { renderTemplate } from './template-render'

/* -------------------------------------------------------------------------- */
/*  What a plan would touch                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Vault paths a plan would write, in the order the ops touch them.
 *
 * The op's own `path` and nothing else. `move`'s `to` is a FOLDER and
 * `rename`'s `to` is a TITLE, so turning either into a destination path is the
 * applier's job; guessing it here would put a path in front of the user that
 * the run may never write, and a confirmation that names the wrong file is
 * worse than one that names fewer. Ops with no path at all (notify, clipboard)
 * touch no file and are therefore absent by construction.
 */
export function planWritePaths(ops: readonly WorkflowOp[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const op of ops) {
    if (!('path' in op)) continue
    if (seen.has(op.path)) continue
    seen.add(op.path)
    paths.push(op.path)
  }
  return paths
}

/**
 * Paths the run would write that are ALSO open with unsaved edits.
 *
 * This is the collision that has to be named before a manual run: the file on
 * disk is what the workflow reads and rewrites, while the editor still holds
 * newer text, so applying blind means one of the two versions quietly loses.
 */
export function unsavedCollisions(
  paths: readonly string[],
  noteDirty: Readonly<Record<string, boolean>>
): string[] {
  return paths.filter((path) => noteDirty[path] === true)
}

/**
 * Every op that does not touch one of `paths`, order preserved.
 *
 * Ops without a path (notify, clipboard) survive: skipping a note the author is
 * editing is not a reason to swallow the notification the workflow ends with.
 */
export function opsExcludingPaths(
  ops: readonly WorkflowOp[],
  paths: Iterable<string>
): WorkflowOp[] {
  const skip = new Set(paths)
  return ops.filter((op) => !('path' in op) || !skip.has(op.path))
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Enough paths to recognize which notes are meant, never a wall of them. */
const MAX_LISTED_PATHS = 6

/** `a.md, b.md and 3 more`. Capped: a confirmation nobody reads protects nobody. */
export function formatPathList(paths: readonly string[], max: number = MAX_LISTED_PATHS): string {
  if (paths.length === 0) return ''
  if (paths.length <= max) {
    if (paths.length === 1) return paths[0]
    return `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`
  }
  return `${paths.slice(0, max).join(', ')} and ${paths.length - max} more`
}

/* -------------------------------------------------------------------------- */
/*  The confirmation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One grouped line of the dry-run summary.
 *
 * Structural on purpose, so the confirmation is fed the very object the dry-run
 * footer already renders. The alternative is a second summarizer, which is the
 * thing that eventually disagrees with the panel the author was reading when
 * they pressed Run.
 */
export interface RunOpLine {
  label: string
  count: number
  irreversible: boolean
}

/** What was decided about notes with unsaved edits, before the run is confirmed. */
export type UnsavedResolution = 'save' | 'skip'

export interface RunConfirmation {
  workflowName: string
  /** Grouped exactly as the dry run shows them. */
  lines: readonly RunOpLine[]
  /** Distinct files the run would write. */
  fileCount: number
  /** Ops with no possible inverse: notify and clipboard. */
  irreversibleCount: number
  /** Error diagnostics still open on the workflow, if any. */
  errorCount: number
  unsaved: { paths: readonly string[]; resolution: UnsavedResolution } | null
}

/** A modal cannot scroll, so the tail of a very wide plan is counted, not listed. */
const MAX_CONFIRM_LINES = 8

function totalChanges(lines: readonly RunOpLine[]): number {
  return lines.reduce((sum, line) => sum + line.count, 0)
}

export function runConfirmTitle(workflowName: string): string {
  return `Run "${workflowName}"?`
}

/** `Apply 12 changes`: the button says what pressing it does, not "OK". */
export function runConfirmLabel(lines: readonly RunOpLine[]): string {
  return `Apply ${plural(totalChanges(lines), 'change', 'changes')}`
}

/**
 * Everything the run would do, as the text shown before it does any of it.
 *
 * Reads top down as: the size of the change, then the change itself, then every
 * caveat that cannot be taken back. The irreversible line is separate from the
 * per-line `no undo` marks deliberately: someone scanning the dialog has to hit
 * the sentence saying part of this is permanent even if they skip the list.
 */
export function runConfirmDescription(input: RunConfirmation): string {
  const blocks: string[] = []
  const total = totalChanges(input.lines)

  blocks.push(
    input.fileCount === 0
      ? `${plural(total, 'change', 'changes')}, none of which writes a file.`
      : `${plural(total, 'change', 'changes')} across ${plural(input.fileCount, 'note', 'notes')}.`
  )

  const shown = input.lines.slice(0, MAX_CONFIRM_LINES)
  const listed = shown.map((line) => {
    const count = line.count > 1 ? ` ×${line.count}` : ''
    const mark = line.irreversible ? '  (no undo)' : ''
    return `  ${line.label}${count}${mark}`
  })
  const hidden = input.lines.length - shown.length
  if (hidden > 0)
    listed.push(`  and ${plural(hidden, 'other kind of change', 'other kinds of change')}`)
  blocks.push(listed.join('\n'))

  if (input.irreversibleCount > 0) {
    blocks.push(
      `${plural(input.irreversibleCount, 'step', 'steps')} cannot be undone. Notifications and clipboard writes leave nothing to roll back.`
    )
  }

  if (input.unsaved) {
    const names = formatPathList(input.unsaved.paths)
    blocks.push(
      input.unsaved.resolution === 'save'
        ? `${plural(input.unsaved.paths.length, 'note has', 'notes have')} unsaved edits and will be saved first: ${names}.`
        : `${plural(input.unsaved.paths.length, 'note with', 'notes with')} unsaved edits will be skipped: ${names}.`
    )
  }

  if (input.errorCount > 0) {
    blocks.push(
      `This workflow still reports ${plural(input.errorCount, 'error', 'errors')}. Only the steps that planned are included above.`
    )
  }

  if (input.fileCount > 0) {
    // The promise the whole feature rests on, restated where it matters.
    blocks.push('Undo restores every file this run writes, byte for byte.')
  }

  return blocks.join('\n\n')
}

/* -------------------------------------------------------------------------- */
/*  The unsaved-changes collision                                             */
/* -------------------------------------------------------------------------- */

export function unsavedCollisionTitle(paths: readonly string[]): string {
  return `Save ${plural(paths.length, 'open note', 'open notes')} before running?`
}

/**
 * Why the run stops to ask. Names the notes, because "some notes are unsaved"
 * is not something anyone can act on.
 */
export function unsavedCollisionDescription(paths: readonly string[]): string {
  const list = paths.map((path) => `  ${path}`).join('\n')
  return [
    `This run writes ${plural(paths.length, 'note', 'notes')} you have open with unsaved edits:`,
    list,
    'The workflow reads and rewrites what is on disk, so unsaved edits would be overwritten by a run that never saw them.'
  ].join('\n\n')
}

export function unsavedSkipTitle(paths: readonly string[]): string {
  return `Skip ${plural(paths.length, 'note', 'notes')} with unsaved edits?`
}

export function unsavedSkipDescription(paths: readonly string[]): string {
  return [
    `Every step that would touch ${formatPathList(paths)} is dropped. The rest of the run goes ahead.`,
    'Nothing is saved and nothing in those notes is changed.'
  ].join('\n\n')
}

/**
 * The same collision on the way back out, which is a different problem.
 *
 * Undo does not touch the editor, it writes bytes to disk, so the hazard is not
 * that the unsaved text is lost: it is that the next autosave writes it back
 * over the file undo just restored, quietly re-applying half the run.
 */
export function undoCollisionTitle(paths: readonly string[]): string {
  return `Undo over ${plural(paths.length, 'unsaved note', 'unsaved notes')}?`
}

export function undoCollisionDescription(paths: readonly string[]): string {
  const list = paths.map((path) => `  ${path}`).join('\n')
  return [
    `This run wrote ${plural(paths.length, 'note', 'notes')} you have open with unsaved edits:`,
    list,
    'Undo puts the pre-run bytes back on disk. Those edits are still in the editor, so the next save would write them straight back over the restored file.'
  ].join('\n\n')
}

/* -------------------------------------------------------------------------- */
/*  Effects the vault never sees                                              */
/* -------------------------------------------------------------------------- */

/**
 * The parts of a run that happen outside the vault.
 *
 * The main process applies every file op and deliberately skips these two (a
 * toast and a clipboard live in the renderer), so the renderer performs them
 * from the same ops list it sent, after a receipt that was not rolled back. A
 * run that failed must fire neither: the notification would announce changes
 * that were unwound, and the clipboard would carry the output of a run that,
 * as far as the vault is concerned, never happened.
 */
export interface RunSideEffects {
  /** Every `notify` message, in plan order. */
  notifications: string[]
  /** What ends up on the clipboard. Last one wins, which is what a clipboard is. */
  clipboard: string | null
}

export function collectRunSideEffects(ops: readonly WorkflowOp[]): RunSideEffects {
  const notifications: string[] = []
  let clipboard: string | null = null
  for (const op of ops) {
    if (op.kind === 'notify') notifications.push(op.message)
    else if (op.kind === 'clipboard') clipboard = op.text
  }
  return { notifications, clipboard }
}

/* -------------------------------------------------------------------------- */
/*  Templates a run applies                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Find the template an `apply-template` step names.
 *
 * The reference is whatever the author typed as one token, so matching is
 * forgiving in a fixed order: the template's id (`custom:reading-notes`), its
 * display name ignoring case, then slug equality so `book-review` finds a
 * template named "Book Review". First match wins within each rule, which keeps
 * the answer stable when two templates share a slug.
 */
export function findTemplateByRef(
  templates: readonly NoteTemplate[],
  ref: string
): NoteTemplate | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  for (const template of templates) {
    if (template.id.toLowerCase() === lower) return template
  }
  for (const template of templates) {
    if (template.name.toLowerCase() === lower) return template
  }
  const slug = slugifyTemplateName(trimmed)
  for (const template of templates) {
    if (slugifyTemplateName(template.name) === slug) return template
  }
  return null
}

/**
 * An error per `apply-template` step naming a template the vault does not have.
 *
 * Reported at plan time so the canvas marks the step red while the author is
 * looking at it, in the same wording rule 6 in `@shared/workflows/validate`
 * uses for an unknown workflow. `validate` itself cannot do this: templates are
 * a vault fact the shared domain has no access to, which is why this lives on
 * the renderer's side of the seam.
 */
export function unknownTemplateDiagnostics(
  workflow: Workflow,
  templates: readonly NoteTemplate[]
): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const statement of workflow.statements) {
    for (const step of statement.steps) {
      if (step.kind !== 'apply-template') continue
      const ref = step.args.template
      // A missing argument is the parser's report, not a second one here.
      if (typeof ref !== 'string' || !ref.trim()) continue
      if (findTemplateByRef(templates, ref)) continue
      out.push({
        severity: 'error',
        message: `\`apply-template\` refers to \`${ref}\`, which is not a template in this vault`,
        line: step.line
      })
    }
  }
  return out
}

export interface ResolvedTemplateOps {
  ops: WorkflowOp[]
  /** Distinct unresolvable references, in first-seen order. Non-empty blocks the run. */
  missing: string[]
}

/**
 * Replace each `apply-template` op's template NAME with the rendered body the
 * applier will actually write.
 *
 * The engine plans with the name because templates are the renderer's to
 * resolve (see `applyTextOp` in `@shared/workflows/apply-ops`); sending the
 * name onward would prepend the literal text `book-review` to every note.
 * Rendering happens per note, so `{{title}}` and the date tokens expand
 * against the note the op targets, exactly as they would had the template been
 * applied from the palette. A reference that resolves for none is returned in
 * `missing` rather than guessed at, and the caller refuses the whole run: half
 * a run applying real bodies while the other half writes names is the kind of
 * split outcome the dry run exists to prevent.
 */
export function resolveTemplateOps(
  ops: readonly WorkflowOp[],
  templates: readonly NoteTemplate[],
  titleForPath: (path: string) => string,
  now: Date
): ResolvedTemplateOps {
  const missing: string[] = []
  const seen = new Set<string>()
  const resolved = ops.map((op): WorkflowOp => {
    if (op.kind !== 'apply-template') return op
    const template = findTemplateByRef(templates, op.template)
    if (!template) {
      if (!seen.has(op.template)) {
        seen.add(op.template)
        missing.push(op.template)
      }
      return op
    }
    const { body } = renderTemplate(template.body, { title: titleForPath(op.path), now })
    return { ...op, template: body }
  })
  return { ops: resolved, missing }
}

/* -------------------------------------------------------------------------- */
/*  The receipt                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The one line the record leads with.
 *
 * A rolled-back run is not a success with an asterisk, so it never reads as
 * "applied": the whole run unwound, including the steps that had already
 * landed, and the headline has to say so before the reason.
 */
export function receiptHeadline(receipt: WorkflowRunReceipt): string {
  if (receipt.rolledBack) return 'Run failed. Every change was rolled back.'
  const changes = plural(receipt.applied, 'change', 'changes')
  if (receipt.paths.length === 0) return `Applied ${changes}. No files were written.`
  return `Applied ${changes} across ${plural(receipt.paths.length, 'note', 'notes')}.`
}

/**
 * Is there anything an undo could restore?
 *
 * A rolled-back run already put everything back, and a run that wrote no files
 * (notify and clipboard only) has no bytes to restore. Offering Undo on either
 * would promise to take back something that cannot be taken back.
 */
export function canUndoReceipt(receipt: WorkflowRunReceipt): boolean {
  return receipt.rolledBack === undefined && receipt.paths.length > 0
}

/** `Undo 3 notes`: the offer is sized, so it is never mistaken for undoing more. */
export function undoLabel(receipt: WorkflowRunReceipt): string {
  return `Undo ${plural(receipt.paths.length, 'note', 'notes')}`
}

/**
 * The part of a run an undo will NOT reverse, stated on the receipt itself.
 *
 * Null when there is nothing to declare. Never folded into the undo promise:
 * a notification that already fired stays fired.
 */
export function irreversibleNote(receipt: WorkflowRunReceipt): string | null {
  if (receipt.irreversible === 0) return null
  return `${plural(receipt.irreversible, 'step', 'steps')} cannot be undone: notifications and clipboard writes stay done.`
}

export function undoneHeadline(result: WorkflowUndoResult): string {
  return result.restored === 1
    ? 'Undone. 1 file restored to how it was.'
    : `Undone. ${result.restored} files restored to how they were.`
}
