import { describe, expect, it } from 'vitest'
import type { NoteFolder, NoteMeta } from '@shared/ipc'
import { searchCreateTarget } from './search-create'

// #826: the note search palette offers to create the note the query names
// when nothing carries that name yet. This is the pure half: where the note
// would land, and which existing note (if any) already answers the query.

function note(path: string, folder: NoteFolder = 'inbox'): NoteMeta {
  const file = path.split('/').pop() ?? path
  return {
    path,
    title: file.replace(/\.md$/, ''),
    folder,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

const notes = [
  note('inbox/Alpha.md'),
  note('inbox/projects/Roadmap.md'),
  note('quick/Scratch.md', 'quick'),
  note('trash/Gone.md', 'trash')
]

describe('searchCreateTarget (#826)', () => {
  it('puts a bare name in the Inbox root', () => {
    expect(searchCreateTarget('Meeting notes', notes)).toEqual({
      folder: 'inbox',
      subpath: '',
      title: 'Meeting notes',
      relPath: 'inbox/Meeting notes.md',
      existing: null
    })
  })

  it('reads a slash as a path under Inbox and a leading top folder as that folder', () => {
    expect(searchCreateTarget('projects/ideas/Q4', notes)).toMatchObject({
      folder: 'inbox',
      subpath: 'projects/ideas',
      title: 'Q4',
      existing: null
    })
    expect(searchCreateTarget('archive/Old plan', notes)).toMatchObject({
      folder: 'archive',
      subpath: '',
      title: 'Old plan',
      existing: null
    })
    expect(searchCreateTarget('/Meeting notes.md', notes)).toMatchObject({
      folder: 'inbox',
      subpath: '',
      title: 'Meeting notes'
    })
  })

  it('offers nothing for an empty query, a name that cannot be a file, or the Trash', () => {
    expect(searchCreateTarget('', notes)).toBeNull()
    expect(searchCreateTarget('   ', notes)).toBeNull()
    expect(searchCreateTarget('what?', notes)).toBeNull()
    expect(searchCreateTarget('a:b', notes)).toBeNull()
    expect(searchCreateTarget('../escape', notes)).toBeNull()
    expect(searchCreateTarget('trash/Gone', notes)).toBeNull()
    expect(searchCreateTarget('trash/Brand new', notes)).toBeNull()
  })

  it('reports the note that already has that exact name, ignoring case', () => {
    expect(searchCreateTarget('alpha', notes)?.existing?.path).toBe('inbox/Alpha.md')
    // A bare name matches a same-titled note anywhere outside the Trash, so
    // Shift+Enter never makes a second "Roadmap" that wikilinks cannot tell apart.
    expect(searchCreateTarget('Roadmap', notes)?.existing?.path).toBe('inbox/projects/Roadmap.md')
    expect(searchCreateTarget('scratch', notes)?.existing?.path).toBe('quick/Scratch.md')
    // A path is exact: the root has no Roadmap, so this one is creatable.
    expect(searchCreateTarget('/Roadmap', notes)?.existing).toBeNull()
    expect(searchCreateTarget('projects/roadmap', notes)?.existing?.path).toBe(
      'inbox/projects/Roadmap.md'
    )
  })

  it('does not treat a fuzzy or partial match as existing', () => {
    expect(searchCreateTarget('Alph', notes)?.existing).toBeNull()
    expect(searchCreateTarget('Alpha 2', notes)?.existing).toBeNull()
  })

  it('never counts a trashed note as existing', () => {
    expect(searchCreateTarget('Gone', notes)).toMatchObject({
      relPath: 'inbox/Gone.md',
      existing: null
    })
  })
})
