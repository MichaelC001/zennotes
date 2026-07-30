/**
 * Database operations composed from generic vault-file IO.
 *
 * A ZenNotes database is a `<Name>.base/` folder holding `data.csv`, a
 * `schema.json` sidecar, and optional record-page notes. Nothing about
 * reading or writing one needs a database-aware backend: it is all plain
 * file reads and writes plus folder create/rename. This module owns that
 * composition once, parameterized over `DatabaseFileOps`, so every
 * transport reuses the same logic:
 *
 *  - the web app binds it to the HTTP bridge's note/folder endpoints
 *  - the desktop app binds it to the remote-workspace client when
 *    connected to a server (#499)
 *
 * The desktop's LOCAL implementation (main/databases.ts, direct fs)
 * predates this module and stays byte-compatible with it; the CSV and
 * sidecar formats come from the same @shared/database-csv helpers.
 */

import type { NoteFolder } from '@zennotes/bridge-contract/ipc'
import {
  csvPathForFormDir,
  databaseSchemaPathFor,
  formDirFromCsvPath,
  formTitleFromCsvPath,
  FORM_DIR_SUFFIX,
  isFormDirName,
  type DatabaseDoc,
  type DatabaseSidecar,
  type DatabaseSummary,
  type DbField,
  type DbRow,
  type DbView
} from './databases'
import { buildDefaultViews, inferFields, parseCsv, parseRows, serializeRows } from './database-csv'

/** The generic vault-file IO a transport must provide. `readFileTextOrNull`
 *  and `writeFile` must accept ANY vault-relative path, including `.base/`
 *  internals like `data.csv` and `schema.json`, not just `.md` notes. */
export interface DatabaseFileOps {
  /** A file's text, or null when missing/unreadable (ENOENT-as-absent). */
  readFileTextOrNull(relPath: string): Promise<string | null>
  writeFile(relPath: string, text: string): Promise<void>
  createFolder(folder: NoteFolder, subpath: string): Promise<void>
  renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string>
  listFolders(): Promise<{ folder: NoteFolder; subpath: string }[]>
  /** True when the vault keeps inbox notes at the root (`primaryNotesLocation: 'root'`). */
  primaryNotesAtRoot(): Promise<boolean>
}

export interface DatabaseOps {
  openDatabase(csvPath: string): Promise<DatabaseDoc>
  writeDatabaseRows(csvPath: string, rows: DbRow[]): Promise<DatabaseDoc>
  writeDatabaseSchema(csvPath: string, sidecar: DatabaseSidecar, rows: DbRow[]): Promise<DatabaseDoc>
  createDatabase(folder: NoteFolder, subpath: string, title?: string): Promise<DatabaseDoc>
  createRecordPage(csvPath: string, title: string, body: string): Promise<string>
  renameDatabase(csvPath: string, newTitle: string): Promise<string>
  listDatabases(): Promise<DatabaseSummary[]>
}

const SCHEMA_SAMPLE_ROWS = 50
const DB_TITLE_BAD = /[\\/:*?"<>|]/g

function dbGenId(): string {
  return globalThis.crypto.randomUUID()
}
function dbToPosix(p: string): string {
  return p.replace(/\\/g, '/')
}
function joinSub(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** Title of a database from its data.csv path. */
function dbTitleFromPath(csvPath: string): string {
  const posix = dbToPosix(csvPath)
  if (formDirFromCsvPath(posix)) return formTitleFromCsvPath(posix)
  const base = posix.split('/').filter(Boolean).pop() ?? csvPath
  return base.replace(/\.csv$/i, '')
}

/** True if a note has body beyond frontmatter + a single title heading. */
function dbNoteHasBody(text: string): boolean {
  let body = text
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body)
  if (fm) body = body.slice(fm[0].length)
  body = body.replace(/^\s*#[^\n]*\r?\n?/, '')
  return body.trim().length > 0
}

/** Defensive sidecar parse — schema.json is user-visible and user-editable. */
export function dbNormalizeSidecar(raw: unknown): DatabaseSidecar | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const fields = Array.isArray(obj.fields) ? (obj.fields as DbField[]) : null
  if (!fields || fields.length === 0) return null
  if (!fields.every((f) => f && typeof f.id === 'string' && typeof f.name === 'string')) return null
  const fieldIds = new Set(fields.map((f) => f.id))
  const idFieldId =
    typeof obj.idFieldId === 'string' && fieldIds.has(obj.idFieldId) ? obj.idFieldId : fields[0].id
  let views = Array.isArray(obj.views) ? (obj.views as DbView[]) : []
  views = views.filter(
    (v) => v && typeof v.id === 'string' && (v.type === 'table' || v.type === 'board')
  )
  if (views.length === 0) views = buildDefaultViews(fields).views
  const activeViewId =
    typeof obj.activeViewId === 'string' && views.some((v) => v.id === obj.activeViewId)
      ? obj.activeViewId
      : views[0].id
  const pages =
    obj.pages && typeof obj.pages === 'object'
      ? (Object.fromEntries(
          Object.entries(obj.pages as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string'
          )
        ) as Record<string, string>)
      : undefined
  return { version: 1, idFieldId, fields, views, activeViewId, ...(pages ? { pages } : {}) }
}

function dbPagesToFull(csvRel: string, pages: Record<string, string>): Record<string, string> {
  const formDir = formDirFromCsvPath(dbToPosix(csvRel))
  if (!formDir) return pages
  const prefix = `${formDir}/`
  return Object.fromEntries(
    Object.entries(pages).map(([id, p]) => [id, p.startsWith(prefix) ? p : `${prefix}${p}`])
  )
}
function dbPagesToRelative(csvRel: string, pages: Record<string, string>): Record<string, string> {
  const formDir = formDirFromCsvPath(dbToPosix(csvRel))
  if (!formDir) return pages
  const prefix = `${formDir}/`
  return Object.fromEntries(
    Object.entries(pages).map(([id, p]) => [id, p.startsWith(prefix) ? p.slice(prefix.length) : p])
  )
}

function dbHydrate(
  csvPath: string,
  sidecar: DatabaseSidecar,
  rows: DbRow[],
  pageHasContent?: Record<string, boolean>
): DatabaseDoc {
  return {
    ...sidecar,
    path: dbToPosix(csvPath),
    title: dbTitleFromPath(csvPath),
    rows,
    ...(pageHasContent ? { pageHasContent } : {})
  }
}

/** Vault-relative directory for a (folder, subpath) — mirrors the server folderRoot. */
function vaultRelDir(folder: NoteFolder, subpath: string, atRoot: boolean): string {
  const sub = (subpath ?? '').replace(/^\/+|\/+$/g, '')
  if (folder === 'inbox') return atRoot ? sub : joinSub('inbox', sub)
  return joinSub(folder, sub)
}

/** Split a vault-relative folder path into (folder, subpath) — inverse of vaultRelDir. */
function splitVaultPath(rel: string, atRoot: boolean): { folder: NoteFolder; subpath: string } {
  const parts = dbToPosix(rel).split('/').filter(Boolean)
  const top = parts[0]
  if (top === 'quick' || top === 'archive' || top === 'trash') {
    return { folder: top as NoteFolder, subpath: parts.slice(1).join('/') }
  }
  if (top === 'inbox' && !atRoot) {
    return { folder: 'inbox', subpath: parts.slice(1).join('/') }
  }
  return { folder: 'inbox', subpath: parts.join('/') }
}

export function createDatabaseOps(io: DatabaseFileOps): DatabaseOps {
  async function dbReadSidecar(csvPath: string): Promise<DatabaseSidecar | null> {
    const schemaPath = databaseSchemaPathFor(dbToPosix(csvPath))
    if (!schemaPath) return null
    const raw = await io.readFileTextOrNull(schemaPath)
    if (raw === null) return null
    let sidecar: DatabaseSidecar | null
    try {
      sidecar = dbNormalizeSidecar(JSON.parse(raw))
    } catch {
      return null
    }
    if (sidecar?.pages) sidecar.pages = dbPagesToFull(dbToPosix(csvPath), sidecar.pages)
    return sidecar
  }

  async function dbPersistSidecar(csvPath: string, sidecar: DatabaseSidecar): Promise<void> {
    const schemaPath = databaseSchemaPathFor(dbToPosix(csvPath))
    if (!schemaPath) throw new Error(`Not a database folder: ${csvPath}`)
    const onDisk: DatabaseSidecar = sidecar.pages
      ? { ...sidecar, pages: dbPagesToRelative(dbToPosix(csvPath), sidecar.pages) }
      : sidecar
    await io.writeFile(schemaPath, `${JSON.stringify(onDisk, null, 2)}\n`)
  }

  async function dbReadPageFlags(
    pages?: Record<string, string>
  ): Promise<Record<string, boolean> | undefined> {
    if (!pages || Object.keys(pages).length === 0) return undefined
    const flags: Record<string, boolean> = {}
    await Promise.all(
      Object.entries(pages).map(async ([rowId, notePath]) => {
        const text = await io.readFileTextOrNull(notePath)
        if (text !== null) flags[rowId] = dbNoteHasBody(text)
      })
    )
    return flags
  }

  async function openDatabase(csvPath: string): Promise<DatabaseDoc> {
    const rel = dbToPosix(csvPath)
    const csvText = await io.readFileTextOrNull(rel)
    if (csvText === null) throw new Error(`Database not found: ${rel}`)

    const existing = await dbReadSidecar(rel)
    if (existing) {
      const rows = parseRows(csvText, existing.fields, existing.idFieldId, dbGenId)
      const pageHasContent = await dbReadPageFlags(existing.pages)
      return dbHydrate(rel, existing, rows, pageHasContent)
    }

    // Adopt a plain CSV: infer the schema + materialize it.
    const grid = parseCsv(csvText)
    const headers = grid[0] ?? []
    const { fields, idFieldId } = inferFields(headers, grid.slice(1, 1 + SCHEMA_SAMPLE_ROWS), dbGenId)
    const { views, activeViewId } = buildDefaultViews(fields, dbGenId)
    const sidecar: DatabaseSidecar = { version: 1, idFieldId, fields, views, activeViewId }
    const rows = parseRows(csvText, fields, idFieldId, dbGenId)
    await dbPersistSidecar(rel, sidecar)
    await io.writeFile(rel, serializeRows(rows, fields)) // canonicalize + persist ids
    return dbHydrate(rel, sidecar, rows)
  }

  async function writeDatabaseRows(csvPath: string, rows: DbRow[]): Promise<DatabaseDoc> {
    const rel = dbToPosix(csvPath)
    const sidecar = await dbReadSidecar(rel)
    if (!sidecar) throw new Error(`Database sidecar missing: ${rel}`)
    await io.writeFile(rel, serializeRows(rows, sidecar.fields))
    return dbHydrate(rel, sidecar, rows.map((r) => ({ ...r })))
  }

  async function writeDatabaseSchema(
    csvPath: string,
    sidecar: DatabaseSidecar,
    rows: DbRow[]
  ): Promise<DatabaseDoc> {
    const rel = dbToPosix(csvPath)
    const normalized = dbNormalizeSidecar(sidecar)
    if (!normalized) throw new Error(`Invalid database schema: ${rel}`)
    await dbPersistSidecar(rel, normalized)
    await io.writeFile(rel, serializeRows(rows, normalized.fields))
    return dbHydrate(rel, normalized, rows.map((r) => ({ ...r })))
  }

  async function createDatabase(
    folder: NoteFolder,
    subpath: string,
    title?: string
  ): Promise<DatabaseDoc> {
    const atRoot = await io.primaryNotesAtRoot()
    const baseTitle = (title ?? 'Untitled Database').trim() || 'Untitled Database'
    const baseName = baseTitle.replace(DB_TITLE_BAD, '-')
    const dirRel = vaultRelDir(folder, subpath, atRoot)
    const csvFor = (name: string): string =>
      csvPathForFormDir(joinSub(dirRel, `${name}${FORM_DIR_SUFFIX}`))
    // Resolve a non-colliding <Name>.base under the directory.
    let name = baseName
    let n = 2
    while ((await io.readFileTextOrNull(csvFor(name))) !== null) name = `${baseName} ${n++}`
    const csvPath = csvFor(name)
    const folderSub = joinSub(subpath, `${name}${FORM_DIR_SUFFIX}`)

    const idField: DbField = { id: dbGenId(), name: 'id', type: 'text', hidden: true }
    const nameField: DbField = { id: dbGenId(), name: 'Name', type: 'text' }
    const fields = [idField, nameField]
    const { views, activeViewId } = buildDefaultViews(fields, dbGenId)
    const sidecar: DatabaseSidecar = {
      version: 1,
      idFieldId: idField.id,
      fields,
      views,
      activeViewId
    }

    await io.createFolder(folder, folderSub)
    await dbPersistSidecar(csvPath, sidecar)
    await io.writeFile(csvPath, serializeRows([], fields))
    return dbHydrate(csvPath, sidecar, [])
  }

  async function createRecordPage(csvPath: string, title: string, body: string): Promise<string> {
    const formDir = formDirFromCsvPath(dbToPosix(csvPath))
    if (!formDir) throw new Error(`Not a database folder: ${csvPath}`)
    const safe = (title.trim() || 'Untitled').replace(/[\\/]/g, '-')
    let finalTitle = safe
    let n = 2
    while ((await io.readFileTextOrNull(`${formDir}/${finalTitle}.md`)) !== null) {
      finalTitle = `${safe} ${n++}`
    }
    const noteRel = `${formDir}/${finalTitle}.md`
    await io.writeFile(noteRel, body)
    return noteRel
  }

  async function renameDatabase(csvPath: string, newTitle: string): Promise<string> {
    const oldFormDir = formDirFromCsvPath(dbToPosix(csvPath))
    if (!oldFormDir) throw new Error(`Not a database folder: ${csvPath}`)
    const parentRel = oldFormDir.includes('/')
      ? oldFormDir.slice(0, oldFormDir.lastIndexOf('/'))
      : ''
    const safeName = (newTitle.trim() || 'Untitled Database').replace(DB_TITLE_BAD, '-')
    const makeFormDir = (name: string): string =>
      parentRel ? `${parentRel}/${name}${FORM_DIR_SUFFIX}` : `${name}${FORM_DIR_SUFFIX}`
    let targetFormDir = makeFormDir(safeName)
    if (targetFormDir === oldFormDir) return csvPath
    let n = 2
    while ((await io.readFileTextOrNull(csvPathForFormDir(targetFormDir))) !== null) {
      targetFormDir = makeFormDir(`${safeName} ${n++}`)
    }
    const atRoot = await io.primaryNotesAtRoot()
    const { folder, subpath: oldSub } = splitVaultPath(oldFormDir, atRoot)
    const { subpath: newSub } = splitVaultPath(targetFormDir, atRoot)
    await io.renameFolder(folder, oldSub, newSub)
    return csvPathForFormDir(targetFormDir)
  }

  async function listDatabases(): Promise<DatabaseSummary[]> {
    const [folders, atRoot] = await Promise.all([io.listFolders(), io.primaryNotesAtRoot()])
    const out: DatabaseSummary[] = []
    for (const f of folders) {
      if (!isFormDirName(f.subpath)) continue
      // The folder subpath is folder-relative; reconstruct the vault-relative path.
      const csv = csvPathForFormDir(vaultRelDir(f.folder, f.subpath, atRoot))
      out.push({ path: csv, title: dbTitleFromPath(csv) })
    }
    return out.sort((a, b) => a.title.localeCompare(b.title))
  }

  return {
    openDatabase,
    writeDatabaseRows,
    writeDatabaseSchema,
    createDatabase,
    createRecordPage,
    renameDatabase,
    listDatabases
  }
}
