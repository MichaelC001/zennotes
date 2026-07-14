import { describe, it, expect } from 'vitest'
import {
  normalizeSystemFolderPaths,
  resolveFolderPath,
  buildReverseFolderMap,
  DEFAULT_FOLDER_PATHS
} from './system-folder-paths'

describe('normalizeSystemFolderPaths', () => {
  it('returns empty object for non-object input', () => {
    expect(normalizeSystemFolderPaths(null)).toEqual({})
    expect(normalizeSystemFolderPaths(undefined)).toEqual({})
    expect(normalizeSystemFolderPaths('string')).toEqual({})
    expect(normalizeSystemFolderPaths(42)).toEqual({})
  })

  it('returns empty object for empty object', () => {
    expect(normalizeSystemFolderPaths({})).toEqual({})
  })

  it('returns empty object when all paths are defaults', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'inbox', trash: 'trash' })).toEqual({})
  })

  it('normalizes valid custom paths', () => {
    expect(normalizeSystemFolderPaths({ inbox: '01 - Entry' })).toEqual({ inbox: '01 - Entry' })
    expect(normalizeSystemFolderPaths({ archive: 'Archive', trash: 'deleted' })).toEqual({
      archive: 'Archive',
      trash: 'deleted'
    })
  })

  it('normalizes backslashes to forward slashes', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'Notes\\Inbox' })).toEqual({ inbox: 'Notes/Inbox' })
  })

  it('rejects paths with .. segments', () => {
    expect(normalizeSystemFolderPaths({ inbox: '../inbox' })).toEqual({})
  })

  it('rejects paths with leading /', () => {
    expect(normalizeSystemFolderPaths({ inbox: '/inbox' })).toEqual({})
  })

  it('rejects paths with empty segments', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'inbox//sub' })).toEqual({})
  })

  it('rejects paths starting with dot in top segment', () => {
    expect(normalizeSystemFolderPaths({ trash: '.trash' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: '.hidden/inbox' })).toEqual({})
  })

  it('rejects paths with invalid characters', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'inbox:name' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: 'inbox?' })).toEqual({})
  })

  it('rejects paths exceeding max length', () => {
    const long = 'a'.repeat(129)
    expect(normalizeSystemFolderPaths({ inbox: long })).toEqual({})
  })

  it('rejects empty string values', () => {
    expect(normalizeSystemFolderPaths({ inbox: '' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: '  ' })).toEqual({})
  })

  it('rejects non-string values', () => {
    expect(normalizeSystemFolderPaths({ inbox: 42 })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: true })).toEqual({})
  })

  it('rejects paths colliding with reserved root names', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'assets' })).toEqual({})
    expect(normalizeSystemFolderPaths({ inbox: '.zennotes' })).toEqual({})
    expect(normalizeSystemFolderPaths({ trash: 'comments' })).toEqual({})
  })

  it('rejects duplicate custom paths', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'Notes', archive: 'Notes' })).toEqual({})
  })

  it('rejects nested paths that are prefix of another', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'Archive', archive: 'Archive/Old' })).toEqual({})
    expect(normalizeSystemFolderPaths({ archive: 'Archive', inbox: 'Archive/Inbox' })).toEqual({})
  })

  it('ignores unknown keys', () => {
    expect(normalizeSystemFolderPaths({ inbox: '01 - Entry', other: 'value' })).toEqual({
      inbox: '01 - Entry'
    })
  })

  it('allows nested paths', () => {
    expect(normalizeSystemFolderPaths({ inbox: 'Notes/Inbox' })).toEqual({
      inbox: 'Notes/Inbox'
    })
  })

  it('allows setting all four folders', () => {
    const result = normalizeSystemFolderPaths({
      inbox: '01 - Entry',
      quick: 'Quick Notes',
      archive: 'Archive',
      trash: 'deleted'
    })
    expect(result).toEqual({
      inbox: '01 - Entry',
      quick: 'Quick Notes',
      archive: 'Archive',
      trash: 'deleted'
    })
  })
})

describe('resolveFolderPath', () => {
  it('returns default when no overrides', () => {
    expect(resolveFolderPath('inbox')).toBe('inbox')
    expect(resolveFolderPath('trash')).toBe('trash')
  })

  it('returns default when override is null/undefined', () => {
    expect(resolveFolderPath('inbox', null)).toBe('inbox')
    expect(resolveFolderPath('inbox', undefined)).toBe('inbox')
  })

  it('returns custom path when set', () => {
    expect(resolveFolderPath('inbox', { inbox: '01 - Entry' })).toBe('01 - Entry')
  })

  it('falls back to default for unset folders', () => {
    const overrides = { inbox: '01 - Entry' }
    expect(resolveFolderPath('archive', overrides)).toBe('archive')
  })
})

describe('buildReverseFolderMap', () => {
  it('returns empty map when no overrides', () => {
    expect(buildReverseFolderMap(null)).toEqual(new Map())
    expect(buildReverseFolderMap({})).toEqual(new Map())
  })

  it('maps custom top segments to folder IDs', () => {
    const map = buildReverseFolderMap({ inbox: '01 - Entry', trash: 'deleted' })
    expect(map.get('01 - entry')).toBe('inbox')
    expect(map.get('deleted')).toBe('trash')
    expect(map.size).toBe(2)
  })

  it('maps nested paths by top segment', () => {
    const map = buildReverseFolderMap({ inbox: 'Notes/Inbox' })
    expect(map.get('notes')).toBe('inbox')
    expect(map.size).toBe(1)
  })
})

describe('DEFAULT_FOLDER_PATHS', () => {
  it('maps each folder ID to itself', () => {
    for (const key of ['inbox', 'quick', 'archive', 'trash'] as const) {
      expect(DEFAULT_FOLDER_PATHS[key]).toBe(key)
    }
  })
})
