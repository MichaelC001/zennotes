import { describe, expect, it } from 'vitest'
import type { NoteFolder } from '@zennotes/bridge-contract/ipc'
import { createDatabaseOps, type DatabaseFileOps } from './database-ops'
import { parseCsv } from './database-csv'

// The composition is transport-agnostic by design: these tests drive it over
// an in-memory vault, the exact seam the web bridge (HTTP) and the desktop
// remote client (#499) plug into. What is asserted here holds for both.

interface MemVault {
  io: DatabaseFileOps
  files: Map<string, string>
  folders: { folder: NoteFolder; subpath: string }[]
}

function memVault(atRoot = false): MemVault {
  const files = new Map<string, string>()
  const folders: { folder: NoteFolder; subpath: string }[] = []
  const io: DatabaseFileOps = {
    readFileTextOrNull: async (rel) => files.get(rel) ?? null,
    writeFile: async (rel, text) => {
      files.set(rel, text)
    },
    createFolder: async (folder, subpath) => {
      folders.push({ folder, subpath })
    },
    renameFolder: async (folder, oldSubpath, newSubpath) => {
      const relOf = (sub: string): string =>
        folder === 'inbox' && atRoot ? sub : `${folder}/${sub}`
      const oldPrefix = `${relOf(oldSubpath)}/`
      const newPrefix = `${relOf(newSubpath)}/`
      for (const [key, value] of [...files]) {
        if (key.startsWith(oldPrefix)) {
          files.delete(key)
          files.set(newPrefix + key.slice(oldPrefix.length), value)
        }
      }
      for (const f of folders) {
        if (f.folder === folder && f.subpath === oldSubpath) f.subpath = newSubpath
      }
      return newSubpath
    },
    listFolders: async () => folders.map((f) => ({ ...f })),
    primaryNotesAtRoot: async () => atRoot
  }
  return { io, files, folders }
}

describe('createDatabaseOps', () => {
  it('creates a database as a .base folder with csv + sidecar, then lists and reopens it', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)

    const doc = await ops.createDatabase('inbox', '', 'Reading Log')
    expect(doc.path).toBe('inbox/Reading Log.base/data.csv')
    expect(doc.title).toBe('Reading Log')
    expect(vault.files.has('inbox/Reading Log.base/data.csv')).toBe(true)
    expect(vault.files.has('inbox/Reading Log.base/schema.json')).toBe(true)
    expect(vault.folders).toEqual([{ folder: 'inbox', subpath: 'Reading Log.base' }])

    const listed = await ops.listDatabases()
    expect(listed).toEqual([{ path: 'inbox/Reading Log.base/data.csv', title: 'Reading Log' }])

    const reopened = await ops.openDatabase(doc.path)
    expect(reopened.fields.map((f) => f.name)).toEqual(['id', 'Name'])
    expect(reopened.rows).toEqual([])
  })

  it('suffixes instead of clobbering when the name is taken', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    await ops.createDatabase('inbox', '', 'Log')
    const second = await ops.createDatabase('inbox', '', 'Log')
    expect(second.path).toBe('inbox/Log 2.base/data.csv')
  })

  it('adopts a bare CSV: infers a schema, persists the sidecar, canonicalizes ids', async () => {
    const vault = memVault()
    vault.files.set('inbox/Books.base/data.csv', 'Title,Rating\nDune,5\nNeuromancer,4\n')
    const ops = createDatabaseOps(vault.io)

    const doc = await ops.openDatabase('inbox/Books.base/data.csv')
    expect(doc.rows).toHaveLength(2)
    expect(vault.files.has('inbox/Books.base/schema.json')).toBe(true)
    // Canonicalized CSV gained a persistent id column.
    const grid = parseCsv(vault.files.get('inbox/Books.base/data.csv')!)
    expect(grid[0].length).toBeGreaterThan(2)
    // Reopening uses the persisted sidecar and sees identical rows.
    const again = await ops.openDatabase('inbox/Books.base/data.csv')
    expect(again.rows).toEqual(doc.rows)
  })

  it('writes rows through the sidecar schema and reads them back', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('quick', '', 'Tasks')
    const nameField = doc.fields.find((f) => f.name === 'Name')!
    const idField = doc.fields.find((f) => f.name === 'id')!

    const written = await ops.writeDatabaseRows(doc.path, [
      { id: 'r1', cells: { [idField.id]: 'r1', [nameField.id]: 'first' } }
    ])
    expect(written.rows).toHaveLength(1)
    const reopened = await ops.openDatabase(doc.path)
    expect(reopened.rows).toHaveLength(1)
  })

  it('rejects an invalid schema write and a rows write without a sidecar', async () => {
    const vault = memVault()
    vault.files.set('inbox/Loose.base/data.csv', 'a,b\n1,2\n')
    const ops = createDatabaseOps(vault.io)
    await expect(ops.writeDatabaseRows('inbox/Loose.base/data.csv', [])).rejects.toThrow(
      /sidecar missing/
    )
    const doc = await ops.openDatabase('inbox/Loose.base/data.csv')
    await expect(
      ops.writeDatabaseSchema(doc.path, { ...doc, fields: [] } as never, [])
    ).rejects.toThrow(/Invalid database schema/)
  })

  it('creates record pages with collision suffixes and reports their content flags', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', '', 'CRM')

    const first = await ops.createRecordPage(doc.path, 'Acme', '# Acme\n')
    const second = await ops.createRecordPage(doc.path, 'Acme', '# Acme\n\nnotes here\n')
    expect(first).toBe('inbox/CRM.base/Acme.md')
    expect(second).toBe('inbox/CRM.base/Acme 2.md')

    const sidecarRaw = JSON.parse(vault.files.get('inbox/CRM.base/schema.json')!)
    sidecarRaw.pages = { row1: 'Acme.md', row2: 'Acme 2.md' }
    vault.files.set('inbox/CRM.base/schema.json', JSON.stringify(sidecarRaw))
    const reopened = await ops.openDatabase(doc.path)
    // Empty-bodied page is false, the one with prose is true.
    expect(reopened.pageHasContent).toEqual({ row1: false, row2: true })
  })

  it('renames the .base folder and returns the new csv path', async () => {
    const vault = memVault()
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', 'Work', 'Old Name')
    expect(doc.path).toBe('inbox/Work/Old Name.base/data.csv')

    const renamed = await ops.renameDatabase(doc.path, 'New Name')
    expect(renamed).toBe('inbox/Work/New Name.base/data.csv')
    expect(vault.files.has('inbox/Work/New Name.base/data.csv')).toBe(true)
    expect(vault.files.has('inbox/Work/Old Name.base/data.csv')).toBe(false)
  })

  it('respects primaryNotesLocation root for inbox paths', async () => {
    const vault = memVault(true)
    const ops = createDatabaseOps(vault.io)
    const doc = await ops.createDatabase('inbox', '', 'Rooted')
    expect(doc.path).toBe('Rooted.base/data.csv')
    const listed = await ops.listDatabases()
    expect(listed[0].path).toBe('Rooted.base/data.csv')
  })
})
