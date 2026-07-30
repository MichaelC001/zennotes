// Where a path op puts a note, shared between the engine and the applier.
//
// The engine plans against a snapshot and must promise downstream steps a
// destination; the desktop applier performs the move and must land the file
// exactly where the plan promised (diverging only for a collision, which it
// then reports as a redirect). One copy of the target arithmetic is what keeps
// those two promises the same promise, exactly as `apply-ops` does for content
// transforms. Everything here is pure string work on vault-relative posix
// paths: no I/O, no platform separators.

/** What a workflow is allowed to write. */
export const NOTE_EXTENSIONS = ['.md', '.excalidraw']

/** Top-level folders that are containers rather than part of a note's subpath. */
export const FOLDER_ROOTS = new Set(['inbox', 'quick', 'archive', 'trash'])

/** Vault-relative paths are posix in the plan, so they are compared as posix. */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

export function relDirname(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut === -1 ? '' : rel.slice(0, cut)
}

export function relBasename(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut === -1 ? rel : rel.slice(cut + 1)
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** `.md` or `.excalidraw`, lowercased, or '' when the name carries neither. */
export function noteExtensionOf(rel: string): string {
  const lower = relBasename(rel).toLowerCase()
  return NOTE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? ''
}

export function stripNoteExtension(name: string): string {
  const ext = noteExtensionOf(name)
  return ext ? name.slice(0, name.length - ext.length) : name
}

/**
 * Where a `move` puts a note: same filename, new folder. `to` is a folder
 * because `rename` is the op that changes a name, which is the only reason
 * these are two ops and not one.
 */
export function moveTarget(rel: string, folder: string): string {
  return joinRel(normalizeRel(folder), relBasename(rel))
}

/**
 * Where a `rename` puts a note: same folder, new name, same file type, so a
 * renamed `.excalidraw` drawing is still a drawing. The pattern may already
 * carry an extension (`{{title}}.md`), which is dropped rather than doubled.
 */
export function renameTarget(rel: string, pattern: string): string {
  const name = stripNoteExtension(normalizeRel(pattern).trim())
  if (!name) throw new Error(`Workflow rename has an empty target for ${rel}`)
  const ext = noteExtensionOf(rel) || NOTE_EXTENSIONS[0]
  return joinRel(relDirname(rel), `${name}${ext}`)
}

/**
 * Where `archive` and `trash` put a note: the destination folder, with the
 * source's subfolder mirrored, so `inbox/demo/X.md` lands at `archive/demo/X.md`
 * and moving it back returns it to `demo/`. This mirrors `moveBetweenFolders`
 * in `vault.ts` without depending on the vault's caches or settings.
 */
export function folderTarget(folder: 'archive' | 'trash', rel: string): string {
  const segments = normalizeRel(rel).split('/')
  const file = segments.pop() ?? ''
  if (segments.length > 0 && FOLDER_ROOTS.has((segments[0] ?? '').toLowerCase())) segments.shift()
  return [folder, ...segments, file].join('/')
}
