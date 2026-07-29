// Shared Workflows contract types. Lives in bridge-contract because the main
// process reads the files and the renderer parses them, and the bridge return
// type sits between the two.
//
// Deliberately raw: the main process hands back bytes and never parses. All
// grammar lives in `@shared/workflows/parse`, the same split the templates API
// uses, so the format has exactly one home.

export interface WorkflowFile {
  /** Filename stem, used as the workflow id, e.g. `reading-log`. */
  id: string
  /** Vault-relative path, e.g. `.zennotes/workflows/reading-log.md`. */
  sourcePath: string
  /** Whole file, frontmatter included. */
  raw: string
}

/**
 * One file the run touched, with the bytes that were there before it did.
 *
 * Rollback restores recorded state rather than replaying a computed inverse.
 * Per-op inverses would mean fifteen separate chances to get an undo wrong, and
 * a wrong undo corrupts a vault rather than merely failing. `before: null`
 * means the path did not exist, so undoing it deletes. A move records both
 * paths, which is why restoring the set undoes it without a special case.
 */
export interface WorkflowJournalEntry {
  path: string
  before: string | null
}

export interface ApplyWorkflowInput {
  workflowId: string
  /** Ops exactly as `planWorkflow` produced them. */
  ops: unknown[]
}

export interface WorkflowRunReceipt {
  runId: string
  workflowId: string
  startedAt: number
  /** Ops that actually ran. */
  applied: number
  /** Vault-relative paths whose bytes changed. */
  paths: string[]
  /** Ops with no possible inverse (notify, clipboard). */
  irreversible: number
  /**
   * Set when the run failed partway and was rolled back. A half-applied
   * workflow is worse than none, because the author cannot tell which half
   * landed, so the whole run unwinds including the steps that succeeded.
   */
  rolledBack?: { reason: string }
}

export interface WorkflowUndoResult {
  runId: string
  /** Files restored to their pre-run bytes. */
  restored: number
}

export interface WorkflowRunSummary {
  runId: string
  workflowId: string
  startedAt: number
  applied: number
  paths: string[]
  /** False once undone, so the UI never offers to undo the same run twice. */
  undoable: boolean
}

/**
 * A workflow on its way OUT of the vault, to a native save dialog.
 *
 * The shareable artifact is the file itself, so this carries bytes and a
 * suggested name and nothing else: no bundle, no manifest, nothing an importer
 * would need a second reader for.
 */
export interface ExportWorkflowInput {
  /** Suggested filename including the extension, e.g. `reading-log.md`. */
  suggestedName: string
  /** The file exactly as it sits in the vault. */
  raw: string
}

/**
 * A file the user chose to import, as bytes plus the name it had.
 *
 * Deliberately parse-free, like every other workflow call: the main process
 * reads a file the user pointed at and hands it over. Whether it is a workflow
 * at all is decided by the review in `@shared/workflows/share`, in the
 * renderer, before anything is written into the vault.
 */
export interface ImportedWorkflowFile {
  /** Filename stem of the chosen file, e.g. `reading-log`. */
  name: string
  /** Whole file, frontmatter included. */
  raw: string
}

/** Mirrors `WriteTemplateInput`, since both write a flat `.zennotes/` .md file. */
export interface WriteWorkflowInput {
  /** Filename stem, no extension. Derived from the workflow name. */
  slug: string
  /** Raw `.md` contents including YAML frontmatter. */
  raw: string
  /** When a rename happened during an edit, the prior sourcePath to remove. */
  previousSourcePath?: string
}
