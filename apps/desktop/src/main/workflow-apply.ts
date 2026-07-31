// Applying a workflow run, and taking it back.
//
// The engine plans and never writes (see `@shared/workflows/engine`); this
// module is the only place a planned run reaches disk. Everything below exists
// to keep one promise: after a run, the vault is either exactly what the plan
// said it would be, or exactly what it was before. Never half of each.
//
// Four decisions carry that promise:
//
//   1. Undo restores RECORDED BYTES, it never replays a computed inverse. The
//      journal holds `{ path, before }` for every file the run touched, where
//      `before: null` means the path did not exist. Undo writes every `before`
//      back and deletes where null. Per-op inverses would be fifteen separate
//      chances to corrupt a vault; this is one mechanism that is right by
//      construction, and a `move` needs no special case because recording both
//      of its paths already describes how to put it back.
//   2. The journal records the PRE-RUN state, so the first touch of a path
//      wins. A later op editing the same file must not overwrite the entry
//      with a value this very run produced, or undo would restore a half-run.
//   3. A partial failure rolls the WHOLE run back, including the steps that
//      already succeeded. A half-applied workflow is worse than none, because
//      the author cannot tell which half landed. If the rollback itself cannot
//      finish, the receipt says so loudly and names the files: never report
//      success over a vault we could not put back.
//   4. Containment is checked for every path in the plan BEFORE the first byte
//      is written, so one traversal attempt aborts the run untouched rather
//      than leaving a rolled-back mess behind.
//
// `notify` and `clipboard` are not applied here (the main process is not where
// the user's clipboard and toasts live) and are not journalled. They are
// counted into `receipt.irreversible` so the promise the UI makes about undo
// stays true.
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type {
  ApplyWorkflowInput,
  WorkflowJournalEntry,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult
} from '@zennotes/bridge-contract/workflows'
import { IRREVERSIBLE_OP_KINDS } from '@shared/workflows/types'
import type { WorkflowOp } from '@shared/workflows/types'
// Every content transform lives in `@shared/workflows/apply-ops`, because the
// renderer previews it, the desktop applies it and Go will mirror it: the same
// split the parser uses. Importing `TextOp` rather than restating the list is
// what makes an op moved across that line a compile error here instead of a
// write that silently stops happening.
import { applyTextOp } from '@shared/workflows/apply-ops'
import type { TextOp } from '@shared/workflows/apply-ops'
// The path-target arithmetic is shared with the engine for the same reason the
// content transforms are: the engine PROMISES downstream steps a destination,
// and the applier must land the file exactly there. Two copies would let those
// promises drift apart, which is how phantom notes happen.
import {
  NOTE_EXTENSIONS,
  folderTarget,
  joinRel,
  moveTarget,
  normalizeRel,
  noteExtensionOf,
  relBasename,
  relDirname,
  renameTarget,
  stripNoteExtension,
  type SystemFolderDirs
} from '@shared/workflows/paths'
import { WORKFLOWS_REL_DIR } from '@shared/workflows-view'
import { getVaultSettings, writeFileAtomic } from './vault'

/* -------------------------------------------------------------------------- */
/*  Where a run is recorded                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run ledgers live beside the workflows that produced them, in a dot directory
 * so `listWorkflowFiles` (which skips dot entries) never mistakes one for a
 * workflow.
 */
export const RUNS_REL_DIR = `${WORKFLOWS_REL_DIR}/.runs`

/** Bumped when the on-disk ledger shape changes; older files are then ignored. */
const LEDGER_VERSION = 1

/**
 * A ledger carries a full copy of every touched file's previous bytes, so the
 * history is bounded rather than growing with every scheduled run forever. A
 * hundred runs is far more undo than anyone reaches back through, and pruning
 * only ever forgets an undo option, it never changes a note.
 */
export const MAX_RETAINED_RUNS = 100

/** The internal directory a workflow must never write into. */
const INTERNAL_DIR = '.zennotes'

/**
 * One applied run, exactly as it is persisted.
 *
 * `hashes` is the content hash of what the run LEFT at each path (null where it
 * removed the file). A future event-triggered run needs to recognise its own
 * writes coming back at it through the watcher, and across sync that recognition
 * cannot be identity of a write handle, only of content. Recording it now is
 * what makes that loop guard possible later without a second migration.
 */
export interface WorkflowRunLedger {
  version: number
  runId: string
  workflowId: string
  startedAt: number
  finishedAt: number
  applied: number
  irreversible: number
  paths: string[]
  ops: WorkflowOp[]
  journal: WorkflowJournalEntry[]
  hashes: Record<string, string | null>
  /** Set once undone, so the same run cannot be taken back twice. */
  undone: boolean
  undoneAt?: number
  /** Present only for a run whose rollback could not finish. */
  rolledBack?: { reason: string }
}

/* -------------------------------------------------------------------------- */
/*  Paths                                                                     */
/* -------------------------------------------------------------------------- */

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/')
}

/** Derived from `RUNS_REL_DIR` so the exported name and the real directory
 *  cannot drift apart. */
function runsDir(root: string): string {
  return path.join(root, ...RUNS_REL_DIR.split('/'))
}

/**
 * Resolve a vault-relative path a workflow wants to write, refusing anything
 * outside the vault, inside `.zennotes`, or that is not a note.
 *
 * Three separate refusals for three separate reasons:
 *
 *   - Escaping the vault is the obvious one, and it is checked on every single
 *     path (op targets, computed destinations, and again on every journal entry
 *     at undo time) because a ledger read back from disk must never become a
 *     write primitive pointed anywhere on the filesystem.
 *   - `.zennotes` holds this feature's own run ledgers, plus workflows,
 *     templates and settings. A workflow that could write there could rewrite
 *     the record of what it did.
 *   - The extension check keeps a mistyped `write reports/weekly` from either
 *     creating a file the app cannot show, or truncating a binary asset that
 *     this module would then "restore" as mangled UTF-8. Rejecting is the honest
 *     answer: silently appending `.md` would apply something other than the path
 *     the user saw in the dry run.
 */
export function resolveVaultPath(root: string, rel: string): string {
  // Before normalising, because normalising would quietly turn `/tmp/evil.md`
  // into `tmp/evil.md` inside the vault: a write to a path the user never saw
  // in the dry run, which is the one thing this feature must never do. Drive
  // letters are checked too, so a workflow authored on Windows and synced to a
  // Mac is refused rather than reinterpreted.
  if (path.isAbsolute(rel) || /^[/\\]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`Workflow op path escapes the vault: ${rel}`)
  }
  const clean = normalizeRel(rel)
  if (!clean) throw new Error('Workflow op has an empty path')
  const abs = path.resolve(root, clean)
  const rootAbs = path.resolve(root)
  if (abs === rootAbs || !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Workflow op path escapes the vault: ${rel}`)
  }
  const inside = toPosix(path.relative(rootAbs, abs))
  const first = inside.split('/')[0] ?? ''
  if (first.toLowerCase() === INTERNAL_DIR) {
    throw new Error(`Workflow op path is inside ${INTERNAL_DIR}: ${rel}`)
  }
  if (!noteExtensionOf(inside)) {
    throw new Error(`Workflow op path is not a note (${NOTE_EXTENSIONS.join(' or ')}): ${rel}`)
  }
  return abs
}

/** Every vault path an op could touch, for the pre-flight containment check. */
function opTargets(op: WorkflowOp, dirs?: SystemFolderDirs): string[] {
  switch (op.kind) {
    case 'notify':
    case 'clipboard':
      return []
    case 'move':
      return [op.path, moveTarget(op.path, op.to)]
    case 'rename':
      return [op.path, renameTarget(op.path, op.to)]
    case 'archive':
      return [op.path, folderTarget('archive', op.path, dirs)]
    case 'trash':
      return [op.path, folderTarget('trash', op.path, dirs)]
    default:
      return [op.path]
  }
}

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

/**
 * A destination that is not already taken, matching `uniqueTitle` in `vault.ts`
 * (`X.md`, `X 2.md`, `X 3.md`).
 *
 * A move that clobbered an existing note would still be undoable, but a second
 * run without an undo would silently merge two notes into one, and nothing in
 * the dry run warned about it. Suffixing is what the rest of the app does.
 */
async function uniqueRel(root: string, rel: string): Promise<string> {
  const ext = noteExtensionOf(rel)
  const stem = joinRel(relDirname(rel), stripNoteExtension(relBasename(rel)))
  let candidate = rel
  // A ceiling rather than `while (true)`: a directory that answers "exists" to
  // everything (a permissions oddity, a broken network mount) must fail loudly
  // instead of spinning forever inside a run that holds a half-written journal.
  for (let n = 2; n < 1000; n += 1) {
    if (!(await exists(path.resolve(root, candidate)))) return candidate
    candidate = `${stem} ${n}${ext}`
  }
  throw new Error(`Cannot find a free destination for ${rel}`)
}

/* -------------------------------------------------------------------------- */
/*  Op validation                                                             */
/* -------------------------------------------------------------------------- */

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

/**
 * Narrow one op that arrived over IPC. Returns null for anything malformed.
 *
 * Rebuilt field by field rather than cast, which is not ceremony: the result is
 * what gets persisted into the ledger, so anything extra that rode in on the
 * wire is dropped here instead of being kept forever in the run history.
 */
export function parseWorkflowOp(value: unknown): WorkflowOp | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const kind = stringField(record, 'kind')
  const notePath = stringField(record, 'path')
  switch (kind) {
    case 'set-frontmatter': {
      const field = stringField(record, 'field')
      const fieldValue = stringField(record, 'value')
      if (notePath === null || field === null || fieldValue === null) return null
      return { kind, path: notePath, field, value: fieldValue }
    }
    case 'add-tag':
    case 'remove-tag': {
      const tag = stringField(record, 'tag')
      if (notePath === null || tag === null) return null
      return { kind, path: notePath, tag }
    }
    case 'move':
    case 'rename': {
      const to = stringField(record, 'to')
      if (notePath === null || to === null) return null
      return { kind, path: notePath, to }
    }
    case 'append':
    case 'prepend': {
      const text = stringField(record, 'text')
      if (notePath === null || text === null) return null
      return { kind, path: notePath, text }
    }
    case 'write-section': {
      const heading = stringField(record, 'heading')
      const text = stringField(record, 'text')
      if (notePath === null || heading === null || text === null) return null
      return { kind, path: notePath, heading, text }
    }
    case 'write-note': {
      const text = stringField(record, 'text')
      if (notePath === null || text === null) return null
      return { kind, path: notePath, text }
    }
    case 'create-note': {
      const body = stringField(record, 'body')
      if (notePath === null || body === null) return null
      return { kind, path: notePath, body }
    }
    case 'apply-template': {
      const template = stringField(record, 'template')
      if (notePath === null || template === null) return null
      return { kind, path: notePath, template }
    }
    case 'archive':
    case 'trash': {
      if (notePath === null) return null
      return { kind, path: notePath }
    }
    case 'notify': {
      const message = stringField(record, 'message')
      if (message === null) return null
      return { kind, message }
    }
    case 'clipboard': {
      const text = stringField(record, 'text')
      if (text === null) return null
      return { kind, text }
    }
    default:
      return null
  }
}

/** Every op, or an error naming the first bad one. Nothing is applied part-way. */
function parseWorkflowOps(values: unknown[]): WorkflowOp[] {
  const ops: WorkflowOp[] = []
  values.forEach((value, index) => {
    const op = parseWorkflowOp(value)
    if (!op) throw new Error(`Workflow op ${index} is not a valid operation`)
    ops.push(op)
  })
  return ops
}

/* -------------------------------------------------------------------------- */
/*  Run identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Distinguishes two runs started in the same millisecond. Deliberately not
 * `Math.random`: a run id names a file that undo has to find again, and a value
 * nobody can reason about is a bad name for a durable record.
 */
let runSequence = 0

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * `<startedAt>-<sequence>-<ops hash>`.
 *
 * The 13-digit millisecond timestamp leads, so ledger filenames sort
 * lexicographically in the same order they ran (through the year 2286, when the
 * digit count changes). The ops hash makes the id a fingerprint of what the run
 * intended, which is what lets two ids from separate processes in the same
 * millisecond differ, and makes a duplicate submission recognisable.
 */
function makeRunId(startedAt: number, workflowId: string, ops: WorkflowOp[]): string {
  runSequence = (runSequence + 1) % 1000
  const seq = String(runSequence).padStart(3, '0')
  const digest = hashText(`${workflowId}\n${JSON.stringify(ops)}`).slice(0, 8)
  return `${startedAt}-${seq}-${digest}`
}

/** A run id that no ledger has taken, so a run can never overwrite another's. */
async function allocateRunId(
  root: string,
  startedAt: number,
  workflowId: string,
  ops: WorkflowOp[]
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const runId = makeRunId(startedAt, workflowId, ops)
    if (!(await exists(ledgerPathFor(root, runId)))) return runId
  }
  throw new Error('Cannot allocate a workflow run id')
}

function ledgerPathFor(root: string, runId: string): string {
  return path.join(runsDir(root), `${runId}.json`)
}

/**
 * Resolve a ledger file for a run id that came from the renderer. The id names
 * a file, so it is checked as one: charset first, then the resolved path is
 * required to sit directly in the runs directory.
 */
function resolveLedgerPath(root: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes('..')) {
    throw new Error(`Invalid workflow run id: ${runId}`)
  }
  const abs = ledgerPathFor(root, runId)
  if (path.dirname(abs) !== runsDir(root)) {
    throw new Error(`Invalid workflow run id: ${runId}`)
  }
  return abs
}

/* -------------------------------------------------------------------------- */
/*  Applying                                                                  */
/* -------------------------------------------------------------------------- */

interface RunState {
  root: string
  /** Resolved on-disk names for remapped system folders (vault.json
   *  `systemFolderPaths`), so `archive`/`trash` ops file into the directory
   *  the app actually treats as Archive/Trash. Empty on default vaults. */
  systemFolderDirs: SystemFolderDirs
  /**
   * Vault-relative path to its pre-run bytes, in the order the run touched
   * them. Insertion-ordered and written only when absent, which is the
   * first-touch-wins rule: the entry must describe the state before the run,
   * not before the latest op.
   */
  journal: Map<string, string | null>
  /** Path to the hash of what the run left there; null where it removed it. */
  written: Map<string, string | null>
  /**
   * Destination the plan promised to where the file actually landed, for the
   * one case where they differ: `uniqueRel` had to suffix around a collision.
   * Later ops in the same run name the promised path; this is the forwarding
   * address that keeps them on the note. See `resolveLiveRel` for why an op
   * whose stated path still exists never follows a redirect.
   */
  redirects: Map<string, string>
}

function journalTouch(state: RunState, rel: string, before: string | null): void {
  if (!state.journal.has(rel)) state.journal.set(rel, before)
}

/**
 * Where an op's stated path actually lives right now.
 *
 * The stated path wins whenever the file is still there, so a redirect can
 * never hijack an op aimed at a real note (a pre-existing note at the promised
 * destination keeps receiving the ops that name it). The redirect is followed
 * only into the gap this run itself created: the promised destination is gone
 * or was never free, and the run knows where the file actually went.
 */
async function resolveLiveRel(state: RunState, rel: string): Promise<string> {
  const stated = normalizeRel(rel)
  const via = state.redirects.get(stated)
  if (via === undefined) return stated
  if (await exists(resolveVaultPath(state.root, stated))) return stated
  return via
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Text ops that act on a note the plan saw on a wire, rather than on a path
 *  the author typed. Only these demand that their target still exists. */
const PER_NOTE_TEXT_OPS = new Set([
  'set-frontmatter',
  'add-tag',
  'remove-tag',
  'append',
  'prepend',
  'apply-template'
])

/** One content transform: read, journal, write. Identical output writes nothing. */
async function applyTextOpToVault(state: RunState, op: TextOp): Promise<void> {
  const rel = await resolveLiveRel(state, op.path)
  const abs = resolveVaultPath(state.root, rel)
  const live = await readIfExists(abs)
  // `create-note` MEANS create. Its transform is a whole-file write that ignores
  // the previous bytes, so letting it land on an existing note silently replaces
  // that note (an empty body blanks it outright). `create-each` generates one of
  // these per item, so a pattern that collides on a second run would quietly eat
  // real notes. Refusing here fails the run, which rolls the whole thing back and
  // leaves the vault untouched. Replacing a note on purpose is `write`.
  if (op.kind === 'create-note' && live !== null) {
    throw new Error(
      `create-note would replace the existing note ${rel}. Use write to replace a note on purpose.`
    )
  }
  // The mirror image, for the ops that act on a wire note: a target that has
  // vanished means the plan is describing a vault that no longer exists (the
  // note was moved or removed, by an earlier step reading a stale wire or by
  // someone else mid-run). Applying the transform to '' would materialize a
  // phantom note at the abandoned path, which is strictly worse than failing:
  // the run rolls back and the receipt names the step that lied.
  if (live === null && PER_NOTE_TEXT_OPS.has(op.kind)) {
    throw new Error(
      `Cannot ${op.kind} ${rel}: the note is missing (moved or removed earlier in this run?)`
    )
  }
  // `applyTextOp` takes '' for a file that does not exist yet, and answers null
  // only for an op that is not a text op. Reaching that here would mean this
  // module and the shared one disagree about which side of the line an op sits
  // on, and a silently skipped write is exactly the failure this feature exists
  // to make impossible, so it throws and the run rolls back.
  const next = applyTextOp(live ?? '', op)
  if (next === null) throw new Error(`Workflow op ${op.kind} is not a text op`)
  // An op that changes nothing (adding a tag the note already carries) should
  // not touch the file: an mtime bump is a sync round trip and a watcher event
  // for a change that did not happen. Only for a file that already exists;
  // creating an empty note is a real change even though '' equals ''.
  if (live !== null && next === live) return
  journalTouch(state, rel, live)
  await writeFileAtomic(abs, next)
  state.written.set(rel, hashText(next))
}

/** One path change. Journals both ends, which is what makes undo need no inverse. */
async function movePathInVault(
  state: RunState,
  kind: WorkflowOp['kind'],
  fromRel: string,
  nominalRel: string,
  promisedRel: string
): Promise<void> {
  const from = normalizeRel(fromRel)
  const fromAbs = resolveVaultPath(state.root, from)
  const live = await readIfExists(fromAbs)
  // The plan was made from a snapshot; if the note has since gone, the rest of
  // the plan is describing a vault that no longer exists. Failing here rolls the
  // whole run back, which is the honest outcome.
  if (live === null) throw new Error(`Cannot ${kind} ${from}: the note is missing`)
  const nominal = normalizeRel(nominalRel)
  // Already where the op wants it (trashing something in the trash). Not an
  // error, and nothing to journal.
  if (nominal === from) return

  const to = await uniqueRel(state.root, nominal)
  const toAbs = resolveVaultPath(state.root, to)
  journalTouch(state, from, live)
  // `uniqueRel` just said this path is free, but it is read rather than assumed
  // null: another process can create a file inside that window, and journalling
  // it as "did not exist" would turn undo into a delete of somebody's note.
  journalTouch(state, to, await readIfExists(toAbs))
  await fs.mkdir(path.dirname(toAbs), { recursive: true })
  await fs.rename(fromAbs, toAbs)
  state.written.set(from, null)
  state.written.set(to, hashText(live))
  // Later ops in this plan name the destination the engine promised; when the
  // vault forced a different one, leave a forwarding address.
  const promised = normalizeRel(promisedRel)
  if (to !== promised) state.redirects.set(promised, to)
}

async function applyOp(state: RunState, op: WorkflowOp): Promise<void> {
  switch (op.kind) {
    // Neither reaches the filesystem, so neither is journalled. They are counted
    // as irreversible on the receipt and performed by the renderer, which is
    // where a clipboard and a notification actually exist.
    case 'notify':
    case 'clipboard':
      return
    // Path ops resolve their source through the run's forwarding addresses,
    // then aim where the ACTUAL file's name says (an earlier collision suffix
    // must survive a later move), while the redirect they record is keyed by
    // the destination the ENGINE promised, because that is the name later ops
    // will use.
    case 'move': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        moveTarget(from, op.to),
        moveTarget(normalizeRel(op.path), op.to)
      )
    }
    case 'rename': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        renameTarget(from, op.to),
        renameTarget(normalizeRel(op.path), op.to)
      )
    }
    case 'archive': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        folderTarget('archive', from, state.systemFolderDirs),
        folderTarget('archive', normalizeRel(op.path), state.systemFolderDirs)
      )
    }
    case 'trash': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        folderTarget('trash', from, state.systemFolderDirs),
        folderTarget('trash', normalizeRel(op.path), state.systemFolderDirs)
      )
    }
    default:
      return await applyTextOpToVault(state, op)
  }
}

/**
 * Put every journalled path back the way the run found it.
 *
 * Returns the entries it could not restore rather than throwing, because the
 * caller is already handling a failure and needs the full list to report: a
 * rollback that stops at the first problem leaves more of the vault wrong than
 * one that carries on.
 */
async function restoreEntries(
  root: string,
  entries: Iterable<readonly [string, string | null]>
): Promise<{ restored: number; failures: RestoreFailure[] }> {
  const failures: RestoreFailure[] = []
  let restored = 0
  for (const [rel, before] of entries) {
    try {
      // Re-validated on the way back out. At rollback time these paths came
      // from this run, but undo replays the same code over a file read off
      // disk, and that file must never be able to point a write anywhere.
      const abs = resolveVaultPath(root, rel)
      // A path is journalled BEFORE its write is attempted, so a run that failed
      // mid-way has journalled paths it never actually changed. Restoring those
      // is pointless at best, and actively harmful here: whatever failed the
      // write (a read-only directory, a vanished volume) fails the restore too,
      // and the rollback then reports ROLLBACK INCOMPLETE over a file that was
      // never touched. That contradicts the headline the user is reading and is
      // the fastest way to lose their trust in undo. Comparing first turns that
      // false alarm into the clean rollback it actually was.
      if ((await readIfExists(abs)) === before) {
        restored += 1
        continue
      }
      if (before === null) {
        await fs.rm(abs, { force: true })
        await pruneEmptyDirs(root, path.dirname(abs))
      } else {
        await writeFileAtomic(abs, before)
      }
      restored += 1
    } catch (err) {
      failures.push({ path: rel, message: messageOf(err) })
    }
  }
  return { restored, failures }
}

/** A path a restore could not put back, kept structured so both the receipt's
 *  `paths` and its human-readable reason can be built from the same fact. */
interface RestoreFailure {
  path: string
  message: string
}

function describeFailures(failures: RestoreFailure[]): string {
  return failures.map((failure) => `${failure.path} (${failure.message})`).join('; ')
}

/**
 * Remove directories the run emptied, walking up while each is empty.
 *
 * Stops before the vault's top-level folders: `inbox/2026` left behind by an
 * undone create is clutter, but `inbox` itself is furniture, and a vault whose
 * folders quietly disappear is a vault nobody trusts. Best effort throughout,
 * since a leftover empty directory is not a reason to fail an undo.
 */
async function pruneEmptyDirs(root: string, startDir: string): Promise<void> {
  const rootAbs = path.resolve(root)
  let dir = startDir
  while (dir.startsWith(rootAbs + path.sep)) {
    const parent = path.dirname(dir)
    // Only strictly below a top-level folder, so `inbox` survives.
    if (parent === rootAbs) return
    try {
      const entries = await fs.readdir(dir)
      if (entries.length > 0) return
      await fs.rmdir(dir)
    } catch {
      return
    }
    dir = parent
  }
}

async function writeLedger(root: string, ledger: WorkflowRunLedger): Promise<void> {
  await fs.mkdir(runsDir(root), { recursive: true })
  await writeFileAtomic(ledgerPathFor(root, ledger.runId), `${JSON.stringify(ledger, null, 2)}\n`)
}

/** Drop the oldest ledgers past the cap. Filenames sort chronologically. */
async function pruneOldRuns(root: string): Promise<void> {
  try {
    const dir = runsDir(root)
    const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.json')).sort()
    const excess = names.slice(0, Math.max(0, names.length - MAX_RETAINED_RUNS))
    for (const name of excess) await fs.rm(path.join(dir, name), { force: true })
  } catch (err) {
    // Losing the prune is harmless; failing a completed run over it is not.
    console.warn('[workflows] could not prune old run ledgers:', err)
  }
}

/* -------------------------------------------------------------------------- */
/*  One run at a time per vault                                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply and undo are serialized per vault root. Two windows on one vault, or
 * the Undo toast racing a second run, would otherwise interleave their
 * read-journal-write sequences: one run journals bytes another run is about to
 * replace, and a rollback then restores pre-run bytes over committed writes
 * while both receipts report success. A promise chain per key (the shape
 * `configWriteQueue` uses in vault.ts) closes the whole class.
 */
const vaultRunQueues = new Map<string, Promise<unknown>>()

async function withVaultRunLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(root)
  const prev = vaultRunQueues.get(key) ?? Promise.resolve()
  // The stored link is settled-only, so one failed run cannot wedge the chain
  // or resurface its error in the next caller; `next` still carries the real
  // rejection to its own caller.
  const next = prev.then(task)
  const tracked: Promise<unknown> = next
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => {
      if (vaultRunQueues.get(key) === tracked) vaultRunQueues.delete(key)
    })
  vaultRunQueues.set(key, tracked)
  return next
}

/**
 * Apply a planned run, journalling as it goes.
 *
 * The receipt is the whole truth about what happened: how many ops ran, which
 * paths changed, how many effects had no undo, and whether the run was taken
 * back. A rolled-back run reports `applied: 0` and no paths, because that is
 * the state the vault is in.
 */
export async function applyWorkflowOps(
  root: string,
  input: ApplyWorkflowInput
): Promise<WorkflowRunReceipt> {
  return withVaultRunLock(root, () => applyWorkflowOpsNow(root, input))
}

async function applyWorkflowOpsNow(
  root: string,
  input: ApplyWorkflowInput
): Promise<WorkflowRunReceipt> {
  const startedAt = Date.now()
  const workflowId = input.workflowId.trim() || 'unknown'
  const ops = parseWorkflowOps(input.ops)
  const irreversible = ops.filter((op) => IRREVERSIBLE_OP_KINDS.has(op.kind)).length

  // Containment first, for every path in the plan including the destinations
  // this module computes. One traversal attempt aborts the run before a single
  // byte is written, so there is nothing to roll back.
  const systemFolderDirs: SystemFolderDirs = (await getVaultSettings(root)).systemFolderPaths ?? {}
  for (const op of ops) {
    for (const target of opTargets(op, systemFolderDirs)) resolveVaultPath(root, target)
  }

  const runId = await allocateRunId(root, startedAt, workflowId, ops)
  const run: RunIdentity = { runId, workflowId, startedAt, irreversible, ops }
  const state: RunState = {
    root,
    systemFolderDirs,
    journal: new Map(),
    written: new Map(),
    redirects: new Map()
  }
  let applied = 0

  try {
    for (const op of ops) {
      await applyOp(state, op)
      // `notify` and `clipboard` did not run here, so they are not counted as
      // applied; they are already declared in `irreversible`.
      if (!IRREVERSIBLE_OP_KINDS.has(op.kind)) applied += 1
    }
  } catch (err) {
    return await rollBackRun(root, run, state, messageOf(err))
  }

  const paths = [...state.written.keys()]
  // A run with no ops at all left no record worth keeping; anything that ran
  // gets a ledger, even one whose journal is empty (a notify-only run), so the
  // history shows it happened and shows it cannot be undone.
  if (ops.length > 0) {
    try {
      await writeLedger(root, {
        ...ledgerBase(run, state),
        finishedAt: Date.now(),
        applied,
        paths,
        undone: false
      })
    } catch (err) {
      // A run that cannot be recorded is a run that cannot be undone, and every
      // promise this feature makes rests on undo. So the journal, still in
      // memory and still correct, is spent putting the vault back rather than
      // left as the only copy of a guarantee nothing on disk can keep.
      return await rollBackRun(
        root,
        run,
        state,
        `The run could not be recorded, so it was not kept (${messageOf(err)})`
      )
    }
    await pruneOldRuns(root)
  }

  return { runId, workflowId, startedAt, applied, paths, irreversible }
}

/** The parts of a run that are fixed before the first op executes. */
interface RunIdentity {
  runId: string
  workflowId: string
  startedAt: number
  irreversible: number
  ops: WorkflowOp[]
}

function ledgerBase(
  run: RunIdentity,
  state: RunState
): Omit<WorkflowRunLedger, 'finishedAt' | 'applied' | 'paths' | 'undone'> {
  return {
    version: LEDGER_VERSION,
    runId: run.runId,
    workflowId: run.workflowId,
    startedAt: run.startedAt,
    irreversible: run.irreversible,
    ops: run.ops,
    journal: journalEntries(state),
    hashes: Object.fromEntries(state.written)
  }
}

/**
 * Unwind everything the run wrote and report it, whatever went wrong.
 *
 * The clean case leaves no ledger: the vault is exactly as it was found, so
 * there is nothing to undo and a run in the history offering an undo would be
 * describing changes that are not there. The incomplete case is the opposite:
 * the journal is now the only record of files still holding this run's bytes,
 * so it is persisted and the reason says so in as many words.
 */
async function rollBackRun(
  root: string,
  run: RunIdentity,
  state: RunState,
  cause: string
): Promise<WorkflowRunReceipt> {
  const { failures } = await restoreEntries(root, state.journal)
  const base = {
    runId: run.runId,
    workflowId: run.workflowId,
    startedAt: run.startedAt,
    applied: 0,
    irreversible: run.irreversible
  }
  if (failures.length === 0) {
    return {
      ...base,
      paths: [],
      rolledBack: { reason: `${cause}. The run was rolled back; your vault is unchanged.` }
    }
  }
  // The paths still differing from their pre-run bytes are exactly the ones the
  // rollback could not reach, which is what `paths` promises to list.
  const unrestored = failures.map((failure) => failure.path)
  let reason =
    `${cause}. ROLLBACK INCOMPLETE: ${failures.length} of ${state.journal.size} ` +
    `files could not be restored (${describeFailures(failures)}). ` +
    `Undo run ${run.runId} to try again.`
  try {
    await writeLedger(root, {
      ...ledgerBase(run, state),
      finishedAt: Date.now(),
      applied: 0,
      paths: unrestored,
      undone: false,
      rolledBack: { reason }
    })
  } catch (err) {
    // Nothing left to fall back on, so the receipt has to carry the whole truth.
    reason = `${reason} The run could not be recorded either (${messageOf(err)}), so there is no undo to retry.`
  }
  return { ...base, paths: unrestored, rolledBack: { reason } }
}

function journalEntries(state: RunState): WorkflowJournalEntry[] {
  return [...state.journal].map(([entryPath, before]) => ({ path: entryPath, before }))
}

/* -------------------------------------------------------------------------- */
/*  Reading the history back                                                  */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseJournal(value: unknown): WorkflowJournalEntry[] {
  if (!Array.isArray(value)) return []
  const entries: WorkflowJournalEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const entryPath = item.path
    const before = item.before
    if (typeof entryPath !== 'string') continue
    if (typeof before !== 'string' && before !== null) continue
    entries.push({ path: entryPath, before })
  }
  return entries
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseHashes(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) return {}
  const hashes: Record<string, string | null> = {}
  for (const [key, hash] of Object.entries(value)) {
    if (typeof hash === 'string' || hash === null) hashes[key] = hash
  }
  return hashes
}

function parseNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Read one ledger, tolerating a file a newer version wrote fields into.
 *
 * The journal is validated strictly (it is what undo writes from) while the
 * reporting fields fall back, because a run whose `applied` count is unreadable
 * is still a run the user must be able to undo.
 */
async function readLedger(abs: string): Promise<WorkflowRunLedger> {
  const raw = await fs.readFile(abs, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error('Run ledger is not an object')
  const runId = parsed.runId
  if (typeof runId !== 'string' || !runId) throw new Error('Run ledger has no run id')
  const ops = Array.isArray(parsed.ops)
    ? parsed.ops
        .map((op) => parseWorkflowOp(op))
        .filter((op): op is WorkflowOp => op !== null)
    : []
  const ledger: WorkflowRunLedger = {
    version: parseNumber(parsed.version, LEDGER_VERSION),
    runId,
    workflowId: typeof parsed.workflowId === 'string' ? parsed.workflowId : 'unknown',
    startedAt: parseNumber(parsed.startedAt, 0),
    finishedAt: parseNumber(parsed.finishedAt, 0),
    applied: parseNumber(parsed.applied, 0),
    irreversible: parseNumber(parsed.irreversible, 0),
    paths: parseStringArray(parsed.paths),
    ops,
    journal: parseJournal(parsed.journal),
    hashes: parseHashes(parsed.hashes),
    undone: parsed.undone === true
  }
  if (typeof parsed.undoneAt === 'number') ledger.undoneAt = parsed.undoneAt
  const rolledBack = parsed.rolledBack
  if (isRecord(rolledBack) && typeof rolledBack.reason === 'string') {
    ledger.rolledBack = { reason: rolledBack.reason }
  }
  return ledger
}

/**
 * Take a run back by restoring the bytes it recorded.
 *
 * Undoing an unknown or already-undone run is an error, never a silent success:
 * "nothing happened" and "your vault is back" are different answers, and only
 * one of them is safe to show the user.
 *
 * A partial restore throws WITHOUT marking the run undone. Restoring recorded
 * bytes is idempotent, so leaving the run undoable means the honest recovery
 * (try again) is also the correct one.
 */
export async function undoWorkflowRun(root: string, runId: string): Promise<WorkflowUndoResult> {
  return withVaultRunLock(root, () => undoWorkflowRunNow(root, runId))
}

async function undoWorkflowRunNow(root: string, runId: string): Promise<WorkflowUndoResult> {
  const abs = resolveLedgerPath(root, runId)
  let ledger: WorkflowRunLedger
  try {
    ledger = await readLedger(abs)
  } catch (err) {
    if (isMissing(err)) throw new Error(`Unknown workflow run: ${runId}`)
    throw new Error(`Cannot read the record of run ${runId}: ${messageOf(err)}`)
  }
  if (ledger.undone) throw new Error(`Workflow run was already undone: ${runId}`)

  const { restored, failures } = await restoreEntries(
    root,
    ledger.journal.map((entry) => [entry.path, entry.before] as const)
  )
  if (failures.length > 0) {
    throw new Error(
      `Undo of run ${runId} is incomplete: ${failures.length} of ${ledger.journal.length} ` +
        `files could not be restored (${describeFailures(failures)}). ` +
        `The run is still undoable; try again.`
    )
  }

  await writeLedger(root, { ...ledger, undone: true, undoneAt: Date.now() })
  return { runId, restored }
}

/**
 * Remove every ledger a workflow's runs left behind, resolving to how many.
 *
 * Exists for the guided tutorial's leave-no-trace cleanup: the practice
 * workflow's ledgers hold copies of the practice notes' bytes, so "the vault
 * ends exactly as it started" includes them. Serialized on the same per-vault
 * queue as apply and undo, so it can never race a run into losing its journal
 * mid-write. An unreadable ledger is left alone: it cannot be proven ours.
 */
export async function deleteWorkflowRuns(root: string, workflowId: string): Promise<number> {
  return withVaultRunLock(root, () => deleteWorkflowRunsNow(root, workflowId))
}

async function deleteWorkflowRunsNow(root: string, workflowId: string): Promise<number> {
  const dir = runsDir(root)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    try {
      const ledger = await readLedger(path.join(dir, name))
      if (ledger.workflowId !== workflowId) continue
      await fs.rm(path.join(dir, name), { force: true })
      removed += 1
    } catch {
      /* unreadable: not provably this workflow's, so it stays */
    }
  }
  return removed
}

/**
 * Every recorded run, newest first, which is the order a history list shows and
 * the order the most recent undo is reached in.
 *
 * A vault with no runs is the normal case, so a missing directory is an empty
 * list rather than an error. One unreadable ledger is skipped with a warning
 * instead of hiding the rest of the history.
 */
export async function listWorkflowRuns(root: string): Promise<WorkflowRunSummary[]> {
  const dir = runsDir(root)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const runs: WorkflowRunSummary[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    try {
      const ledger = await readLedger(path.join(dir, name))
      runs.push({
        runId: ledger.runId,
        workflowId: ledger.workflowId,
        startedAt: ledger.startedAt,
        applied: ledger.applied,
        paths: ledger.paths,
        // Nothing recorded means nothing to restore, so offering undo would be
        // a promise the journal cannot keep.
        undoable: !ledger.undone && ledger.journal.length > 0
      })
    } catch (err) {
      console.warn(`[workflows] skipping unreadable run ledger ${name}:`, err)
    }
  }
  runs.sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId))
  return runs
}
