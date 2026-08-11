import { describe, expect, it } from 'vitest'
import {
  cloudSyncPathKey,
  normalizeCloudSyncPath,
  shouldTraverseCloudSyncDirectory,
  shouldSyncVaultPath
} from './cloud-sync'

describe('normalizeCloudSyncPath', () => {
  it('normalizes separators and unicode without changing the visible path', () => {
    expect(normalizeCloudSyncPath('inbox\\Cafe\u0301.md')).toBe('inbox/Café.md')
  })

  it.each(['', '/inbox/Note.md', 'inbox/', 'inbox/../Note.md', './Note.md', 'C:\\Note.md'])(
    'rejects unsafe file path %s',
    (path) => {
      expect(() => normalizeCloudSyncPath(path)).toThrow('Invalid sync path')
    }
  )
})

describe('cloudSyncPathKey', () => {
  it('uses a case-insensitive unicode-normalized collision key', () => {
    expect(cloudSyncPathKey('Inbox/Cafe\u0301.md')).toBe(cloudSyncPathKey('inbox/CAFÉ.md'))
  })
})

describe('shouldSyncVaultPath', () => {
  it.each([
    'inbox/Note.md',
    'Projects/Database.csv',
    'Projects/Database.csv.base.json',
    'assets/diagram.png',
    '.zennotes/vault.json',
    '.zennotes/comments/inbox/Note.md.comments.json',
    '.zennotes/templates/meeting.md',
    '.zennotes/workflows/review.json'
  ])('includes user-authored vault file %s', (path) => {
    expect(shouldSyncVaultPath(path)).toBe(true)
  })

  it.each([
    '.DS_Store',
    'Thumbs.db',
    'inbox/Note.md.tmp',
    'inbox/Note.md.bak',
    '.zennotes/workspace.json',
    '.zennotes/mobile-note-meta-cache-v1.json',
    '.zennotes/deleted-assets/token/file.png',
    '.zennotes/sync/device-state.json',
    '.zennotes/unknown-runtime-cache.json',
    '.git/config',
    'vendor/project/.svn/entries',
    'node_modules/package/index.js'
  ])('excludes device-local or temporary file %s', (path) => {
    expect(shouldSyncVaultPath(path)).toBe(false)
  })

  it('prunes repository metadata and dependency directories during traversal', () => {
    expect(shouldTraverseCloudSyncDirectory('notes')).toBe(true)
    expect(shouldTraverseCloudSyncDirectory('.zennotes/templates')).toBe(true)
    expect(shouldTraverseCloudSyncDirectory('.git')).toBe(false)
    expect(shouldTraverseCloudSyncDirectory('project/node_modules')).toBe(false)
  })
})
