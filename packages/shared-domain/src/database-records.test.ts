import { describe, expect, it } from 'vitest'
import { planRecordPages } from './database-records'
import type { DatabaseDoc } from './databases'

const doc: DatabaseDoc = {
  version: 1,
  path: 'Books.base/data.csv',
  title: 'Books',
  idFieldId: 'id',
  activeViewId: 'table',
  views: [],
  fields: [
    { id: 'id', name: 'ID', type: 'text' },
    { id: 'title', name: 'Title', type: 'text' }
  ],
  rows: [
    { id: 'a', cells: { id: 'a', title: 'Dune' } },
    { id: 'b', cells: { id: 'b', title: 'Emma' } },
    { id: 'c', cells: { id: 'c', title: 'Kindred' } },
    { id: 'd', cells: { id: 'd', title: '   ' } }
  ],
  pages: { a: 'Books.base/Dune.md', b: 'Books.base/Emma.md' }
}

describe('planRecordPages', () => {
  it('plans a page for records without one, or whose page is gone, in row order', () => {
    const plan = planRecordPages(doc, (path) => path === 'Books.base/Dune.md')
    expect(plan.missing.map((r) => r.id)).toEqual(['b', 'c'])
    expect(plan.existing).toBe(1)
    expect(plan.untitled).toBe(1)
  })

  it('plans nothing for a database whose titled records all have pages', () => {
    const plan = planRecordPages({ ...doc, rows: doc.rows.slice(0, 2) }, () => true)
    expect(plan).toEqual({ missing: [], existing: 2, untitled: 0 })
  })

  it('leaves out every record when the database has no title field', () => {
    const plan = planRecordPages({ ...doc, fields: [doc.fields[0]], pages: {} }, () => false)
    expect(plan.missing).toEqual([])
    expect(plan.untitled).toBe(4)
  })
})
