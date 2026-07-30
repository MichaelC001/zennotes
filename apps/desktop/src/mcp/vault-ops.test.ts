import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseOpenNoteDeepLink } from '../main/deep-links'
import { createNote, listNotes, scanAllTasks, searchText } from './vault-ops'

// Every note-shaped MCP result carries `link`, the zennotes:// deep link a
// model renders as a markdown link so the user can click from chat straight
// into the app (#509). These tests pin the field at each source: the shared
// meta reader, the text-search hit, the task scanner, and a mutation receipt.

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-ops-'))
  await mkdir(path.join(root, 'inbox', 'GitHub'), { recursive: true })
  await writeFile(
    path.join(root, 'inbox', 'GitHub', 'Rename -master- branch (howto).md'),
    '# Rename\n\nrename the default branch\n\n- [ ] actually do it\n'
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('mcp note links (#509)', () => {
  it('list_notes metadata carries a link that round-trips to the same path', async () => {
    const notes = await listNotes(root)
    const note = notes.find((n) => n.title.startsWith('Rename'))
    expect(note).toBeDefined()
    expect(note!.link).toBe(
      'zennotes://open?path=inbox/GitHub/Rename%20-master-%20branch%20%28howto%29.md'
    )
    expect(parseOpenNoteDeepLink(note!.link)).toEqual({ target: 'tab', path: note!.path })
  })

  it('text search hits carry the link of the matched note', async () => {
    const hits = await searchText(root, 'default branch', 10)
    expect(hits).toHaveLength(1)
    expect(parseOpenNoteDeepLink(hits[0].link)).toEqual({ target: 'tab', path: hits[0].path })
  })

  it('tasks carry the link of their source note', async () => {
    const tasks = await scanAllTasks(root)
    expect(tasks).toHaveLength(1)
    expect(parseOpenNoteDeepLink(tasks[0].link)).toEqual({
      target: 'tab',
      path: tasks[0].sourcePath
    })
  })

  it('mutation receipts carry the link of the note they produced', async () => {
    const meta = await createNote(root, 'inbox', 'From Chat (draft)')
    expect(meta.link).toContain('zennotes://open?path=')
    expect(parseOpenNoteDeepLink(meta.link)).toEqual({ target: 'tab', path: meta.path })
  })
})
