import type { NoteFolder, NoteMeta } from '@shared/ipc'
import { parseCreateNotePath } from './wikilinks'

export interface SearchCreateTarget {
  folder: NoteFolder
  subpath: string
  title: string
  relPath: string
  /**
   * The live note the query already names, when there is one: a note at the
   * same path, or, for a bare name, a note with that exact title anywhere
   * outside the Trash. Creating would only make a same-named twin, so the
   * palette hides its create row and Shift+Enter opens this note instead.
   */
  existing: NoteMeta | null
}

/**
 * Where "create a note named after the search" would put the note (#826).
 * The free text of the query is read like the argument of `:e`: a bare name
 * lands in the Inbox root, `projects/roadmap` nests under Inbox, and a leading
 * top folder (`archive/old`) picks that folder. Returns null when there is
 * nothing to create: no free text (an empty or tag-only query), text that
 * cannot be a file name, or a path into the Trash.
 */
export function searchCreateTarget(
  freeText: string,
  notes: readonly NoteMeta[]
): SearchCreateTarget | null {
  const text = freeText.trim()
  if (!text) return null
  let parsed: ReturnType<typeof parseCreateNotePath>
  try {
    parsed = parseCreateNotePath(text)
  } catch {
    return null
  }
  if (parsed.folder === 'trash') return null

  const relPathLower = parsed.relPath.toLowerCase()
  const titleLower = parsed.title.toLowerCase()
  const live = notes.filter((note) => note.folder !== 'trash')
  const bareName = !/[\\/]/.test(text)
  const existing =
    live.find((note) => note.path.toLowerCase() === relPathLower) ??
    (bareName ? live.find((note) => note.title.trim().toLowerCase() === titleLower) : undefined) ??
    null
  return { ...parsed, existing }
}
