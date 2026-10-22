/**
 * Pure record-level operations on a DatabaseDoc, shared by every surface
 * that edits rows: the app's grid, and the `zn base` CLI commands (#556).
 * Doc-in, doc-out, no IO. These moved here from app-core's database-cells
 * (which re-exports them unchanged) so the CLI and future MCP tools import
 * the one implementation instead of growing copies.
 */
import { defaultGenId } from './database-csv'
import { yamlValue } from './frontmatter'
import type { DatabaseDoc, DbField, DbRow, SelectOption } from './databases'

export function fieldsById(doc: DatabaseDoc): Map<string, DbField> {
  return new Map(doc.fields.map((f) => [f.id, f]))
}

/** A record's display title: the first non-id field's value (fallback "Untitled"). */
export function recordTitle(doc: DatabaseDoc, row: DbRow): string {
  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const v = titleField ? (row.cells[titleField.id] ?? '').trim() : ''
  return v || 'Untitled'
}

/**
 * Compose a record "page" note: the record's properties as flat YAML
 * frontmatter followed by `body` (the freeform page). The id field and the
 * title field are omitted — the title is the page's `# heading`, so repeating
 * it as a `Name:` property would be redundant. Empty values render as a blank
 * `key:` rather than `key: ""`.
 */
export function composePageBody(doc: DatabaseDoc, row: DbRow, body: string): string {
  const titleFieldId = doc.fields.find((f) => f.id !== doc.idFieldId)?.id
  const lines = ['---']
  for (const f of doc.fields) {
    if (f.id === doc.idFieldId || f.id === titleFieldId) continue
    const v = row.cells[f.id] ?? ''
    lines.push(v ? `${f.name}: ${yamlValue(v)}` : `${f.name}:`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`
}

/** What giving every record its page would do: the records that get one, and
 *  how many are left as they are. */
export interface RecordPagePlan {
  /** Records with no page, or whose page is gone, in row order. */
  missing: DbRow[]
  /** Records whose page is mapped and still there. */
  existing: number
  /** Records with an empty title field, left without a page. */
  untitled: number
}

/**
 * Plan "Create pages for all records". A record is a note links can reach
 * only once it has a page, and a page used to be made only by opening the
 * record, one at a time: a database converted from a CSV of hundreds of rows
 * had none to link to. A record whose page is mapped and still exists keeps
 * it; one whose page was deleted gets a new one, as opening it would; one
 * with an empty title is skipped, since its page would only be "Untitled"
 * and nothing could link to it by name. `zn base pages` (zennotescli
 * internal/database) mirrors these rules.
 */
export function planRecordPages(
  doc: DatabaseDoc,
  pageExists: (path: string) => boolean
): RecordPagePlan {
  const titleField = doc.fields.find((f) => f.id !== doc.idFieldId)
  const missing: DbRow[] = []
  let existing = 0
  let untitled = 0
  for (const row of doc.rows) {
    const page = doc.pages?.[row.id]
    if (page && pageExists(page)) {
      existing++
      continue
    }
    if (!(titleField ? (row.cells[titleField.id] ?? '').trim() : '')) {
      untitled++
      continue
    }
    missing.push(row)
  }
  return { missing, existing, untitled }
}

export function setCell(doc: DatabaseDoc, rowId: string, fieldId: string, value: string): DatabaseDoc {
  return {
    ...doc,
    rows: doc.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r))
  }
}

export function addRow(doc: DatabaseDoc): DatabaseDoc {
  const id = defaultGenId()
  const cells: Record<string, string> = {}
  for (const f of doc.fields) cells[f.id] = ''
  cells[doc.idFieldId] = id
  const row: DbRow = { id, cells }
  return { ...doc, rows: [...doc.rows, row] }
}

export function deleteRow(doc: DatabaseDoc, rowId: string): DatabaseDoc {
  return { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) }
}

export function ensureSelectOption(doc: DatabaseDoc, fieldId: string, rawValue: string): DatabaseDoc {
  const value = rawValue.trim().replace(/,/g, ' ') // option values may not contain commas
  if (!value) return doc
  return {
    ...doc,
    fields: doc.fields.map((f) => {
      if (f.id !== fieldId) return f
      const options = f.options ?? []
      if (options.some((o) => o.value === value)) return f
      const opt: SelectOption = { id: defaultGenId(), value }
      return { ...f, options: [...options, opt] }
    })
  }
}
