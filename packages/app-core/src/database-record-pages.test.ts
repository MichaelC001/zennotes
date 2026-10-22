// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseDoc } from '@shared/databases'

// "Create pages for all records": a database converted from a CSV has no
// record pages, and a record is a note links can reach only once it has one.

const CSV = 'Books.base/data.csv'
const DUNE = 'Books.base/Dune.md'
const GONE = 'Books.base/Emma.md'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

async function setup(overrides: { createRecordPage?: (csv: string, title: string, body: string) => Promise<string> } = {}) {
  const files = new Map([[DUNE, '---\nAuthor: Herbert\n---\n# Dune\n\nRead twice.\n']])
  const metadata = (path: string) => ({
    path, title: path.split('/').pop()!.replace(/\.md$/, ''), folder: 'inbox' as const,
    siblingOrder: 0, createdAt: 1, updatedAt: 1, size: 0, tags: [], wikilinks: [], assetEmbeds: [], hasAttachments: false, excerpt: ''
  })
  const doc: DatabaseDoc = {
    version: 1, path: CSV, title: 'Books', idFieldId: 'id', activeViewId: 'table', views: [],
    fields: [{ id: 'id', name: 'ID', type: 'text' }, { id: 'title', name: 'Title', type: 'text' }, { id: 'author', name: 'Author', type: 'text' }],
    rows: [
      { id: 'dune', cells: { id: 'dune', title: 'Dune', author: 'Herbert' } },
      // Mapped to a page that was deleted since.
      { id: 'emma', cells: { id: 'emma', title: 'Emma', author: 'Austen' } },
      { id: 'kindred', cells: { id: 'kindred', title: 'Kindred', author: 'Butler' } },
      { id: 'blank', cells: { id: 'blank', title: '  ', author: 'Nobody' } }
    ],
    pages: { dune: DUNE, emma: GONE },
    pageHasContent: { dune: true, emma: false }
  }
  const createRecordPage = vi.fn(
    overrides.createRecordPage ??
      (async (_csv: string, title: string, body: string) => {
        const path = `Books.base/${title}.md`
        files.set(path, body)
        return path
      })
  )
  const bridge = {
    getCapabilities: () => ({}), listNotes: async () => [...files.keys()].map(metadata), listFolders: async () => [],
    scanTasks: async () => [], scanTasksForPath: async () => [], hasAssetsDir: async () => false,
    getRemoteWorkspaceInfo: async () => null, setVaultSettings: async (s: unknown) => s,
    readNote: vi.fn(async (path: string) => ({ ...metadata(path), body: files.get(path) ?? '' })),
    writeDatabaseRows: vi.fn(async () => {}),
    writeDatabaseSchema: vi.fn(async () => {}),
    createRecordPage
  }
  Object.defineProperty(window, 'zen', { configurable: true, value: bridge })
  const { useStore } = await import('./store')
  const prompts = await import('./lib/confirm-requests')
  const toasts = (await import('./lib/toast')).useToastStore
  useStore.setState({
    vault: { root: '/test', name: 'Test' },
    databases: { [CSV]: doc },
    notes: [...files.keys()].map(metadata),
    noteContents: {},
    noteDirty: {}
  })
  const run = async (answer: boolean) => {
    const running = useStore.getState().createAllRecordPages(CSV)
    await vi.waitFor(() => expect(prompts.getConfirmRequest()).not.toBeNull())
    const request = prompts.getConfirmRequest()!
    prompts.settleConfirmRequest(request, answer)
    return { request, result: await running }
  }
  return { useStore, bridge, files, run, prompts, toasts, doc }
}

describe('createAllRecordPages', () => {
  it('gives each record without a page its page, and leaves the rest', async () => {
    const s = await setup()
    const { request, result } = await s.run(true)

    expect(request.options.title).toBe('Create pages for 2 records?')
    expect(result).toEqual({ created: 2, existing: 1, untitled: 1 })
    expect(s.bridge.createRecordPage.mock.calls.map((c) => c[1])).toEqual(['Emma', 'Kindred'])
    // The page the grid's own "open" would make: properties as frontmatter, the title as its heading.
    expect(s.files.get('Books.base/Kindred.md')).toBe('---\nAuthor: Butler\n---\n# Kindred\n\n')
    const pages = s.useStore.getState().databases[CSV].pages
    expect(pages).toEqual({ dune: DUNE, emma: 'Books.base/Emma.md', kindred: 'Books.base/Kindred.md' })
    expect(s.files.get(DUNE)).toContain('Read twice.')
  })

  it('writes nothing when the question is declined', async () => {
    const s = await setup()
    const { result } = await s.run(false)
    expect(result).toBeNull()
    expect(s.bridge.createRecordPage).not.toHaveBeenCalled()
    expect(s.useStore.getState().databases[CSV].pages).toEqual(s.doc.pages)
  })

  it('keeps the pages it made when one fails partway, and says so', async () => {
    let calls = 0
    const s = await setup({
      createRecordPage: async (_csv, title) => {
        calls++
        if (calls === 2) throw new Error('disk full')
        return `Books.base/${title}.md`
      }
    })
    const { result } = await s.run(true)
    expect(result).toEqual({ created: 1, existing: 1, untitled: 1 })
    expect(s.useStore.getState().databases[CSV].pages).toMatchObject({ emma: 'Books.base/Emma.md' })
    expect(s.useStore.getState().databases[CSV].pages).not.toHaveProperty('kindred')
    expect(s.toasts.getState().toasts.at(-1)?.message).toContain('Created 1 of 2 record pages, then: disk full')
  })

  it('asks nothing when every titled record already has its page', async () => {
    const s = await setup()
    const done = {
      ...s.doc,
      rows: s.doc.rows.filter((r) => r.id === 'dune' || r.id === 'blank')
    }
    s.useStore.setState({ databases: { [CSV]: done } })
    const result = await s.useStore.getState().createAllRecordPages(CSV)
    expect(result).toEqual({ created: 0, existing: 1, untitled: 1 })
    expect(s.prompts.getConfirmRequest()).toBeNull()
    expect(s.bridge.createRecordPage).not.toHaveBeenCalled()
  })
})
