import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  mkdir
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DesktopCloudSyncRepository, DesktopCloudSyncStateStore } from './cloud-sync-filesystem'
import { createCloudSyncClient } from './cloud-sync-client'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  cloudSyncUploadSource
} from './cloud-sync-upload-source'
import type { CloudSyncChange } from '@zennotes/bridge-contract/cloud-sync'
import { releaseCloudSyncStagedFile } from '@zennotes/shared-domain/cloud-sync-content'
import {
  CloudSyncCoordinator,
  type CloudSyncRemote,
  type CloudSyncRepositoryConflict
} from '@zennotes/shared-domain/cloud-sync-coordinator'
import type { CloudSyncState, CloudSyncTrackedItem } from '@zennotes/shared-domain/cloud-sync-engine'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-cloud-sync-'))
  roots.push(root)
  return root
}

function hash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function upsert(path: string, contents: string, previousPath: string | null = null): CloudSyncChange {
  return {
    sequence: 2,
    item_id: 'item-remote',
    type: 'upsert',
    path,
    previous_path: previousPath,
    revision: 2,
    content: {
      encoding: 'utf8',
      data: contents,
      sha256: hash(contents),
      byte_length: Buffer.byteLength(contents),
      media_type: 'text/markdown'
    }
  }
}

function tracked(path: string, contents: string): CloudSyncTrackedItem {
  return {
    item_id: 'item-1',
    path,
    kind: 'text',
    revision: 1,
    sha256: hash(contents),
    byte_length: Buffer.byteLength(contents),
    media_type: 'text/markdown'
  }
}

/** Lands an upsert the way a large Cloud body arrives: staged on disk first. */
async function applyStaged(
  root: string,
  change: CloudSyncChange,
  previous: CloudSyncTrackedItem | undefined
): Promise<CloudSyncRepositoryConflict | void> {
  const { content, ...metadata } = change
  const { data, ...contentMetadata } = content!
  const reference = { ...contentMetadata, item_id: change.item_id, revision: change.revision }
  const repository = new DesktopCloudSyncRepository(root, {
    stagingDirectory: await temporaryRoot(),
    fetchImplementation: async () => new Response(data)
  })
  const file = await repository.stageCloudContent({
    reference,
    previewLimitBytes: 0,
    getInstruction: async () => ({
      item_id: reference.item_id,
      revision: reference.revision,
      content: contentMetadata,
      download: {
        method: 'GET',
        url: 'https://objects.example.test/immutable',
        headers: {},
        expires_at: '2099-10-01T12:00:00Z'
      }
    })
  })
  try {
    return await repository.applyStagedCloudContent(
      { ...metadata, content_ref: reference },
      previous,
      file
    )
  } finally {
    await releaseCloudSyncStagedFile(file)
  }
}

describe('DesktopCloudSyncRepository', () => {
  it('scans text and binary vault files while excluding local sync state', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes', 'sync'), { recursive: true })
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'package'), {
      recursive: true
    })
    await writeFile(path.join(root, 'note.md'), '# Note')
    await writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2, 3]))
    await writeFile(path.join(root, '.zennotes', 'sync', 'state.json'), '{}')
    await writeFile(path.join(root, '.git', 'config'), 'repository metadata')
    await writeFile(path.join(root, 'node_modules', 'package', 'index.js'), 'dependency')

    const items = await new DesktopCloudSyncRepository(root).scan()

    expect(items.map((item) => item.path)).toEqual(['image.png', 'note.md'])
    expect(items.find((item) => item.path === 'note.md')?.content.encoding).toBe('utf8')
    expect(items.find((item) => item.path === 'image.png')?.content.encoding).toBe('base64')
  })

  it('keeps oversized file contents out of memory and records their upload source', async () => {
    const root = await temporaryRoot()
    const absolutePath = path.join(root, 'archive.bin')
    const bytes = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 17)
    await writeFile(absolutePath, bytes)

    const items = await new DesktopCloudSyncRepository(root).scan()

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      path: 'archive.bin',
      kind: 'binary',
      content: {
        encoding: 'base64',
        data: '',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.byteLength,
        media_type: 'application/octet-stream'
      }
    })
    expect(cloudSyncUploadSource(items[0]!.content)).toBe(absolutePath)
  })

  it('keeps device-local workspace state out of scans and ignores remote workspace mutations', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(path.join(root, '.zennotes', 'workspace.json'), '{"device":"desktop"}')
    await writeFile(path.join(root, 'note.md'), '# Note')
    const repository = new DesktopCloudSyncRepository(root)

    expect((await repository.scan()).map((item) => item.path)).toEqual(['note.md'])

    await repository.apply(
      {
        sequence: 2,
        item_id: 'workspace-item',
        type: 'upsert',
        path: '.zennotes/workspace.json',
        previous_path: null,
        revision: 2,
        content: {
          encoding: 'utf8',
          data: '{"device":"mobile"}',
          sha256: hash('{"device":"mobile"}'),
          byte_length: 19,
          media_type: 'application/json'
        }
      },
      tracked('.zennotes/workspace.json', '{"device":"desktop"}')
    )

    expect(await readFile(path.join(root, '.zennotes', 'workspace.json'), 'utf8')).toBe(
      '{"device":"desktop"}'
    )
  })

  it('applies upsert, move, and delete changes inside the vault', async () => {
    const root = await temporaryRoot()
    const repository = new DesktopCloudSyncRepository(root)

    await repository.apply(
      {
        sequence: 1,
        item_id: 'item-1',
        type: 'upsert',
        path: 'notes/one.md',
        previous_path: null,
        revision: 1,
        content: {
          encoding: 'utf8',
          data: 'one',
          sha256: hash('one'),
          byte_length: 3,
          media_type: 'text/markdown'
        }
      },
      undefined
    )
    await repository.apply(
      {
        sequence: 2,
        item_id: 'item-1',
        type: 'move',
        path: 'archive/one.md',
        previous_path: 'notes/one.md',
        revision: 2
      },
      tracked('notes/one.md', 'one')
    )
    await repository.apply(
      {
        sequence: 3,
        item_id: 'item-1',
        type: 'delete',
        path: 'archive/one.md',
        previous_path: null,
        revision: 3
      },
      tracked('archive/one.md', 'one')
    )

    await expect(readFile(path.join(root, 'archive', 'one.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('returns both versions without writing a conflict note into the vault', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      upsert('note.md', 'remote edit'),
      tracked('note.md', 'old contents')
    )

    expect(conflict).toMatchObject({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'note.md',
      conflict_copy_path: null,
      local: { path: 'note.md', content: { data: 'local edit' } }
    })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
    expect(await readdir(root)).toEqual(['note.md'])
  })

  it('applies an explicit Cloud choice only while the local version is unchanged', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)
    const conflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT' as const,
      item_id: 'item-remote',
      path: 'note.md',
      local_sha256: hash('local edit'),
      remote_sha256: hash('cloud edit')
    }

    await repository.resolveBootstrapConflict({
      path: 'note.md',
      expectedLocalSha256: conflict.local_sha256,
      cloudContent: upsert('note.md', 'cloud edit').content!,
      resolution: { conflict, choice: 'cloud' }
    })

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('cloud edit')
    await expect(
      repository.resolveBootstrapConflict({
        path: 'note.md',
        expectedLocalSha256: conflict.local_sha256,
        cloudContent: upsert('note.md', 'cloud edit').content!,
        resolution: { conflict, choice: 'cloud' }
      })
    ).rejects.toThrow('changed on this device')
  })

  it('keeps both bootstrap versions under explicit paths', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)
    const conflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT' as const,
      item_id: 'item-remote',
      path: 'note.md',
      local_sha256: hash('local edit'),
      remote_sha256: hash('cloud edit')
    }

    await repository.resolveBootstrapConflict({
      path: 'note.md',
      expectedLocalSha256: conflict.local_sha256,
      cloudContent: upsert('note.md', 'cloud edit').content!,
      resolution: {
        conflict,
        choice: 'both',
        keep_both_path: 'note (this device).md'
      }
    })

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('cloud edit')
    expect(await readFile(path.join(root, 'note (this device).md'), 'utf8')).toBe('local edit')
  })

  it('writes an explicit merged bootstrap result', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)
    const conflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT' as const,
      item_id: 'item-remote',
      path: 'note.md',
      local_sha256: hash('local edit'),
      remote_sha256: hash('cloud edit')
    }

    await repository.resolveBootstrapConflict({
      path: 'note.md',
      expectedLocalSha256: conflict.local_sha256,
      cloudContent: upsert('note.md', 'cloud edit').content!,
      resolution: { conflict, choice: 'merged', merged_text: 'merged result' }
    })

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('merged result')
  })

  it('materializes moved and keep-both decisions without overwriting another file', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    await writeFile(path.join(root, 'existing.md'), 'leave me alone')
    const repository = new DesktopCloudSyncRepository(root)

    await repository.applyConflictResolutionFiles({
      expected_path: 'note.md',
      expected_sha256: hash('local edit'),
      files: [
        {
          path: 'archive/note.md',
          content: upsert('archive/note.md', 'cloud edit').content!
        },
        {
          path: 'note from Mac.md',
          content: upsert('note from Mac.md', 'local edit').content!
        }
      ]
    })

    await expect(readFile(path.join(root, 'note.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(path.join(root, 'archive', 'note.md'), 'utf8')).toBe('cloud edit')
    expect(await readFile(path.join(root, 'note from Mac.md'), 'utf8')).toBe('local edit')
    await expect(
      repository.applyConflictResolutionFiles({
        expected_path: 'archive/note.md',
        expected_sha256: hash('cloud edit'),
        files: [
          {
            path: 'existing.md',
            content: upsert('existing.md', 'cloud edit').content!
          }
        ]
      })
    ).rejects.toThrow('already exists')
    expect(await readFile(path.join(root, 'archive', 'note.md'), 'utf8')).toBe('cloud edit')
    expect(await readFile(path.join(root, 'existing.md'), 'utf8')).toBe('leave me alone')
  })

  it('removes newly created resolution files when a later write fails', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    await writeFile(path.join(root, 'blocked'), 'not a directory')
    const repository = new DesktopCloudSyncRepository(root)

    await expect(
      repository.applyConflictResolutionFiles({
        expected_path: 'note.md',
        expected_sha256: hash('local edit'),
        files: [
          { path: 'copy.md', content: upsert('copy.md', 'safe copy').content! },
          {
            path: 'blocked/note.md',
            content: upsert('blocked/note.md', 'fails').content!
          }
        ]
      })
    ).rejects.toThrow()

    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
    expect(await readFile(path.join(root, 'blocked'), 'utf8')).toBe('not a directory')
    await expect(readFile(path.join(root, 'copy.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  // What wedged the reporter: the change feed carried a file this device had
  // never tracked, so sync refused it without ever noticing that the bytes on
  // disk were already exactly what was being delivered.
  it('adopts a file that already matches the incoming change', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(path.join(root, '.zennotes', 'vault.json'), '{"favorites":[]}')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      upsert('.zennotes/vault.json', '{"favorites":[]}'),
      undefined
    )

    expect(conflict).toBeUndefined()
    expect(await readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8')).toBe(
      '{"favorites":[]}'
    )
    expect(await readdir(path.join(root, '.zennotes'))).toEqual(['vault.json'])
  })

  it('leaves an existing legacy conflict copy untouched and creates no new one', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    await writeFile(path.join(root, 'note (cloud conflict).md'), 'an earlier conflict')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(upsert('note.md', 'remote edit'), undefined)

    expect(conflict?.conflict_copy_path).toBeNull()
    expect(await readFile(path.join(root, 'note (cloud conflict).md'), 'utf8')).toBe(
      'an earlier conflict'
    )
    expect((await readdir(root)).sort()).toEqual(['note (cloud conflict).md', 'note.md'])
  })

  // Settings are a question, not a merge: a numbered copy inside a hidden
  // folder is not something anyone can act on, so the cloud version waits at
  // one fixed path and the app asks which side to keep.
  it('parks conflicting vault settings at one fixed path for the user to answer', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(path.join(root, '.zennotes', 'vault.json'), '{"favorites":["a"]}')
    const repository = new DesktopCloudSyncRepository(root)

    const first = await repository.apply(
      upsert('.zennotes/vault.json', '{"favorites":["b"]}'),
      undefined
    )
    expect(first).toMatchObject({
      code: 'SETTINGS_CONFLICT',
      path: '.zennotes/vault.json',
      conflict_copy_path: '.zennotes/vault.cloud-conflict.json'
    })
    expect(await repository.pendingConflictPaths()).toEqual(['.zennotes/vault.json'])
    // The settings in use are still this device's.
    expect(await readFile(path.join(root, '.zennotes', 'vault.json'), 'utf8')).toBe(
      '{"favorites":["a"]}'
    )

    // A newer cloud version replaces the pending one instead of piling up.
    await repository.apply(upsert('.zennotes/vault.json', '{"favorites":["c"]}'), undefined)
    expect(await readFile(path.join(root, '.zennotes', 'vault.cloud-conflict.json'), 'utf8')).toBe(
      '{"favorites":["c"]}'
    )
    expect((await readdir(path.join(root, '.zennotes'))).sort()).toEqual([
      'vault.cloud-conflict.json',
      'vault.json'
    ])
  })

  it('keeps a locally edited file that the remote deleted', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      {
        sequence: 3,
        item_id: 'item-1',
        type: 'delete',
        path: 'note.md',
        previous_path: null,
        revision: 3
      },
      tracked('note.md', 'old contents')
    )

    expect(conflict).toMatchObject({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'note.md',
      conflict_copy_path: null,
      local: { content: { data: 'local edit' } }
    })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
  })

  it('accepts a delete for a file that is already gone locally', async () => {
    const root = await temporaryRoot()
    const repository = new DesktopCloudSyncRepository(root)

    const conflict = await repository.apply(
      {
        sequence: 4,
        item_id: 'item-1',
        type: 'delete',
        path: 'note.md',
        previous_path: null,
        revision: 4
      },
      tracked('note.md', 'old contents')
    )

    expect(conflict).toBeUndefined()
  })
})

describe('DesktopCloudSyncStateStore', () => {
  it('persists cursor state outside the vault', async () => {
    const root = await temporaryRoot()
    const stateDirectory = path.join(root, 'user-data', 'cloud-sync')
    const store = new DesktopCloudSyncStateStore(stateDirectory)
    const state = {
      version: 1 as const,
      vault_id: 'vault-1',
      cursor: 7,
      items: {}
    }

    await store.save(state)

    expect(await store.load('vault-1')).toEqual(state)
    expect(await store.load('another-vault')).toBeNull()
  })
})

describe('DesktopCloudSyncRepository: decisions and writes', () => {
  it('copies a file above the inline limit from disk when keeping both versions', async () => {
    const root = await temporaryRoot()
    const bytes = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 7)
    await writeFile(path.join(root, 'Deck.pdf'), bytes)
    const repository = new DesktopCloudSyncRepository(root)
    const [local] = await repository.scan()
    expect(local.content.data).toBe('')

    await repository.applyConflictResolutionFiles({
      expected_path: 'Deck.pdf',
      expected_sha256: local.content.sha256,
      files: [
        { path: 'Deck.pdf', content: upsert('Deck.pdf', 'cloud bytes').content! },
        { path: 'Deck (this device).pdf', content: local.content }
      ]
    })

    expect((await readFile(path.join(root, 'Deck (this device).pdf'))).equals(bytes)).toBe(true)
    expect(await readFile(path.join(root, 'Deck.pdf'), 'utf8')).toBe('cloud bytes')
  }, 20_000)

  it('puts the other device\'s version where it went and moves this device\'s different file beside it', async () => {
    // Dave (2026-10-23): the computer trashed the note his phone edited, and
    // the phone had trashed an Untitled.md of its own into the same slot.
    const root = await temporaryRoot()
    const note = 'inbox/Daily Notes/Untitled.md'
    await mkdir(path.join(root, 'inbox/Daily Notes'), { recursive: true })
    await mkdir(path.join(root, 'trash/Daily Notes'), { recursive: true })
    await writeFile(path.join(root, note), 'edited here')
    await writeFile(path.join(root, 'trash/Daily Notes/Untitled.md'), 'own scratch')
    await writeFile(path.join(root, 'trash/Daily Notes/Untitled 2.md'), 'already second')
    const cloud = upsert('trash/Daily Notes/Untitled.md', 'from the computer').content!
    const { data, ...contentMetadata } = cloud
    const reference = { ...contentMetadata, item_id: 'item-remote', revision: 2 }
    const repository = new DesktopCloudSyncRepository(root, {
      stagingDirectory: await temporaryRoot(),
      fetchImplementation: async () => new Response(data)
    })
    const file = await repository.stageCloudContent({
      reference,
      previewLimitBytes: 0,
      getInstruction: async () => ({
        item_id: reference.item_id, revision: reference.revision, content: contentMetadata,
        download: { method: 'GET', url: 'https://objects.example.test/immutable', headers: {}, expires_at: '2099-10-01T12:00:00Z' }
      })
    })
    try {
      await repository.resolveStagedCloudConflict({
        expected_path: note, expected_sha256: hash('edited here'), cloud_path: 'trash/Daily Notes/Untitled.md', file
      })
    } finally {
      await releaseCloudSyncStagedFile(file)
    }

    expect(await readFile(path.join(root, 'trash/Daily Notes/Untitled.md'), 'utf8')).toBe('from the computer')
    expect(await readFile(path.join(root, 'trash/Daily Notes/Untitled 3.md'), 'utf8')).toBe('own scratch')
    expect(await readFile(path.join(root, 'trash/Daily Notes/Untitled 2.md'), 'utf8')).toBe('already second')
    await expect(readFile(path.join(root, note), 'utf8')).rejects.toThrow()
  })

  it('moves only for the other device\'s version: a chosen name that is taken still refuses', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'Plan.md'), 'edited here')
    await writeFile(path.join(root, 'Taken.md'), 'someone else')
    const repository = new DesktopCloudSyncRepository(root)
    const cloud = upsert('Taken.md', 'cloud').content!

    await expect(repository.applyConflictResolutionFiles({
      expected_path: 'Plan.md', expected_sha256: hash('edited here'),
      files: [{ path: 'Taken.md', content: cloud }]
    })).rejects.toThrow('already exists')
    await repository.applyConflictResolutionFiles({
      expected_path: 'Plan.md', expected_sha256: hash('edited here'),
      files: [{ path: 'Taken.md', content: cloud, displace_existing: true }]
    })
    expect(await readFile(path.join(root, 'Taken.md'), 'utf8')).toBe('cloud')
    expect(await readFile(path.join(root, 'Taken 2.md'), 'utf8')).toBe('someone else')
  })

  it('refuses to write a snapshot that carries no bytes and no source', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'Deck.pdf'), 'agreed')
    const repository = new DesktopCloudSyncRepository(root)

    await expect(
      repository.replaceConflictFile({
        path: 'Deck.pdf',
        expectedSha256: hash('agreed'),
        content: {
          encoding: 'base64',
          data: '',
          sha256: 'missing',
          byte_length: 10,
          media_type: 'application/pdf'
        }
      })
    ).rejects.toThrow('too large to copy')
    expect(await readFile(path.join(root, 'Deck.pdf'), 'utf8')).toBe('agreed')
  })

  it('writes through a symlinked note instead of replacing the link', async () => {
    const root = await temporaryRoot()
    const elsewhere = await temporaryRoot()
    const target = path.join(elsewhere, 'linked.md')
    await writeFile(target, 'agreed')
    try {
      await symlink(target, path.join(root, 'linked.md'))
    } catch {
      // Creating symlinks can require privileges (e.g. Windows); skip there.
      return
    }
    const repository = new DesktopCloudSyncRepository(root)

    await repository.replaceConflictFile({
      path: 'linked.md',
      expectedSha256: hash('agreed'),
      content: upsert('linked.md', 'from cloud').content!
    })

    expect((await lstat(path.join(root, 'linked.md'))).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('from cloud')
  })

  it('leaves an existing note its own permissions', async () => {
    // Windows has no POSIX mode bits to keep.
    if (process.platform === 'win32') return
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'private.md'), 'agreed')
    await chmod(path.join(root, 'private.md'), 0o600)
    const repository = new DesktopCloudSyncRepository(root)

    await repository.replaceConflictFile({
      path: 'private.md',
      expectedSha256: hash('agreed'),
      content: upsert('private.md', 'from cloud').content!
    })

    expect((await stat(path.join(root, 'private.md'))).mode & 0o777).toBe(0o600)
  })
})

// A Cloud restore brings a note back out of Trash as an upsert whose
// previous_path is where the note was, not as a move. Writing only the new
// path left the old file behind; the next scan found it untracked and the
// push uploaded it as a brand-new note to every device. Small bodies land
// through `apply`, large ones are staged on disk and land through
// `applyStagedCloudContent`, and both have to retire the old path.
describe.each([
  {
    mode: 'inline',
    land: (root: string, change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined) =>
      new DesktopCloudSyncRepository(root).apply(change, previous)
  },
  { mode: 'staged', land: applyStaged }
])('DesktopCloudSyncRepository: an upsert that changes path ($mode)', ({ land }) => {
  it.each(['agreed', 'restored'])('removes the old file once the new path holds %j', async (contents) => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'trash', 'Note.md'), 'agreed')

    const conflict = await land(
      root,
      upsert('Note.md', contents, 'trash/Note.md'),
      tracked('trash/Note.md', 'agreed')
    )

    expect(conflict).toBeUndefined()
    expect(await readFile(path.join(root, 'Note.md'), 'utf8')).toBe(contents)
    expect(await readdir(path.join(root, 'trash'))).toEqual([])
  })

  // How a replay finds the vault after a crash between writing the new path
  // and removing the old one.
  it('removes the old file when the new path already holds the incoming bytes', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'trash', 'Note.md'), 'agreed')
    await writeFile(path.join(root, 'Note.md'), 'restored')

    const conflict = await land(
      root,
      upsert('Note.md', 'restored', 'trash/Note.md'),
      tracked('trash/Note.md', 'agreed')
    )

    expect(conflict).toBeUndefined()
    expect(await readFile(path.join(root, 'Note.md'), 'utf8')).toBe('restored')
    expect(await readdir(path.join(root, 'trash'))).toEqual([])
  })

  it.each([
    { target: 'empty', atTarget: null },
    { target: 'already holding the incoming bytes', atTarget: 'restored' }
  ])('keeps an old file edited on this device, with the new path $target', async ({ atTarget }) => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'trash', 'Note.md'), 'local edit')
    if (atTarget !== null) await writeFile(path.join(root, 'Note.md'), atTarget)

    const conflict = await land(
      root,
      upsert('Note.md', 'restored', 'trash/Note.md'),
      tracked('trash/Note.md', 'agreed')
    )

    expect(conflict).toMatchObject({
      code: 'LOCAL_EDIT_CONFLICT',
      path: 'trash/Note.md',
      conflict_copy_path: null,
      local: { path: 'trash/Note.md', content: { data: 'local edit' } }
    })
    expect(await readFile(path.join(root, 'trash', 'Note.md'), 'utf8')).toBe('local edit')
    expect(await readFile(path.join(root, 'Note.md'), 'utf8').catch(() => null)).toBe(atTarget)
  })

  it('writes an upsert that keeps its path in place, as before', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'agreed')
    await writeFile(path.join(root, 'other.md'), 'leave me alone')

    const conflict = await land(root, upsert('note.md', 'remote edit'), tracked('note.md', 'agreed'))

    expect(conflict).toBeUndefined()
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('remote edit')
    expect(await readFile(path.join(root, 'other.md'), 'utf8')).toBe('leave me alone')
    expect((await readdir(root)).sort()).toEqual(['note.md', 'other.md'])
  })

  it('never removes an untracked file that previous_path names', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'trash', 'Note.md'), 'not tracked here')

    const conflict = await land(root, upsert('Note.md', 'restored', 'trash/Note.md'), undefined)

    expect(conflict).toBeUndefined()
    expect(await readFile(path.join(root, 'Note.md'), 'utf8')).toBe('restored')
    expect(await readFile(path.join(root, 'trash', 'Note.md'), 'utf8')).toBe('not tracked here')
  })

  // On a case-insensitive volume (the macOS and Windows default) both
  // spellings open one file, so removing the "old" one would remove the note
  // that was just written. A case-sensitive volume has two files to tidy.
  it.each(['agreed', 'remote edit'])(
    'keeps exactly one file when an upsert only changes the case of its path (%j)',
    async (contents) => {
      const root = await temporaryRoot()
      await writeFile(path.join(root, 'note.md'), 'agreed')

      const conflict = await land(
        root,
        upsert('Note.md', contents, 'note.md'),
        tracked('note.md', 'agreed')
      )

      expect(conflict).toBeUndefined()
      expect(await readdir(root)).toHaveLength(1)
      expect(await readFile(path.join(root, 'Note.md'), 'utf8')).toBe(contents)
    }
  )
})

describe('DesktopCloudSyncRepository: a Cloud restore from Trash', () => {
  it('lands the restored note once and uploads nothing back', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'trash', 'Note.md'), 'agreed')
    const restore = upsert('Note.md', 'agreed', 'trash/Note.md')
    let state: CloudSyncState | null = {
      version: 1,
      vault_id: 'vault',
      cursor: restore.sequence - 1,
      items: {
        [restore.item_id]: { ...tracked('trash/Note.md', 'agreed'), item_id: restore.item_id }
      }
    }
    const remote: CloudSyncRemote = {
      manifest: vi.fn(),
      changes: vi.fn(async (_vault: string, after: number) => ({
        data: after < restore.sequence ? [restore] : [],
        cursor: restore.sequence,
        has_more: false
      })),
      mutate: vi.fn(async () => ({ acknowledged: [], cursor: restore.sequence, conflicts: [] }))
    }
    const coordinator = new CloudSyncCoordinator(
      'vault',
      remote,
      new DesktopCloudSyncRepository(root),
      {
        load: async () => state,
        save: async (next) => {
          state = next
        }
      },
      { itemId: () => 'item-duplicate', operationId: () => 'operation' }
    )

    const result = await coordinator.sync()

    expect(result).toMatchObject({ pulled: 1, pushed: 0 })
    expect(remote.mutate).not.toHaveBeenCalled()
    expect(await readFile(path.join(root, 'Note.md'), 'utf8')).toBe('agreed')
    expect(await readdir(path.join(root, 'trash'))).toEqual([])
  })
})

describe('DesktopCloudSyncRepository: back after Cloud pruned its change log', () => {
  it('rebuilds from the manifest without losing an edit made while away', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'Plan.md'), 'v1')
    await writeFile(path.join(root, 'Draft.md'), 'draft, edited here')
    await writeFile(path.join(root, 'Trip.md'), 'trip, edited here')
    const item = (id: string, relPath: string, revision: number, contents: string) => ({
      ...tracked(relPath, contents), item_id: id, revision
    })
    // The state the desktop kept from before the trip, reused on relink.
    const states = new DesktopCloudSyncStateStore(await temporaryRoot())
    await states.save({
      version: 1,
      vault_id: 'vault',
      cursor: 3,
      items: {
        plan: item('plan', 'Plan.md', 1, 'v1'),
        draft: item('draft', 'Draft.md', 1, 'draft'),
        trip: item('trip', 'Trip.md', 1, 'trip')
      }
    })
    const listed = [item('plan', 'Plan.md', 7, 'v7'), item('draft', 'Draft.md', 1, 'draft')]
    const remote: CloudSyncRemote = {
      manifest: vi.fn(async () => ({
        data: listed.map((entry, index) => ({ ...entry, content: upsert(entry.path, index === 0 ? 'v7' : 'draft').content })),
        cursor: 40,
        next_page: null
      })),
      changes: vi.fn(async (_vault: string, after: number) => {
        if (after < 30) {
          throw Object.assign(new Error('This cursor is older than the retained change log.'), {
            name: 'CloudServiceRequestError', status: 410, code: 'CURSOR_EXPIRED', details: { pruned_through: 30, cursor: 40 }
          })
        }
        return { data: [], cursor: after, has_more: false }
      }),
      mutate: vi.fn<CloudSyncRemote['mutate']>(async (_vault, body) => ({
        acknowledged: body.mutations.map((mutation) => ({
          operation_id: mutation.operation_id, item_id: mutation.item_id, revision: 2, sequence: 41
        })),
        cursor: 41,
        conflicts: []
      }))
    }
    let operation = 0
    const coordinator = new CloudSyncCoordinator('vault', remote, new DesktopCloudSyncRepository(root), states, {
      itemId: () => 'item-new', operationId: () => `operation-${++operation}`
    })

    const result = await coordinator.sync()

    expect(await readFile(path.join(root, 'Plan.md'), 'utf8')).toBe('v7')
    expect(await readFile(path.join(root, 'Draft.md'), 'utf8')).toBe('draft, edited here')
    // Deleted in Cloud, edited here: kept, and waiting for a decision.
    expect(await readFile(path.join(root, 'Trip.md'), 'utf8')).toBe('trip, edited here')
    expect(vi.mocked(remote.mutate).mock.calls.flatMap((call) => call[1].mutations)).toEqual([
      expect.objectContaining({ type: 'upsert', item_id: 'draft', base_revision: 1, path: 'Draft.md' })
    ])
    expect(result.pendingConflicts).toEqual([
      expect.objectContaining({ item_id: 'trip', kind: 'delete', path: 'Trip.md', cloud_path: null })
    ])
    expect((await states.load('vault'))?.cursor).toBe(40)
  })

  it('reads the 410 off the wire through the desktop client and catches up', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'Plan.md'), 'v1')
    await writeFile(path.join(root, 'Draft.md'), 'draft, edited here')
    const states = new DesktopCloudSyncStateStore(await temporaryRoot())
    await states.save({
      version: 1,
      vault_id: 'vault',
      cursor: 3,
      items: {
        plan: { ...tracked('Plan.md', 'v1'), item_id: 'plan' },
        draft: { ...tracked('Draft.md', 'draft'), item_id: 'draft' }
      }
    })
    const body = (contents: string) => upsert('x', contents).content!
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
    const requests: string[] = []
    // Cloud's own answers, as the website sends them.
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (url.pathname === '/api/v1/vaults/vault/changes') {
        const after = Number(url.searchParams.get('after'))
        if (after < 30) {
          return json(410, { error: {
            code: 'CURSOR_EXPIRED',
            message: 'This cursor is older than the retained change log. Rebuild this vault from its manifest.',
            details: { pruned_through: 30, cursor: 40 }
          } })
        }
        return json(200, { data: [], cursor: after, has_more: false })
      }
      if (url.pathname === '/api/v1/vaults/vault/manifest') {
        const metadata = (id: string, relPath: string, revision: number, contents: string) => {
          const { data: _data, encoding: _encoding, ...content } = body(contents)
          return { item_id: id, path: relPath, kind: 'text', revision, ...content }
        }
        return json(200, {
          data: [metadata('draft', 'Draft.md', 1, 'draft'), metadata('plan', 'Plan.md', 7, 'v7')],
          cursor: 40,
          next_page: null
        })
      }
      if (url.pathname === '/api/v1/vaults/vault/items/plan/revisions/7') {
        return json(200, { data: { item_id: 'plan', revision: 7, path: 'Plan.md', kind: 'text', deleted: false, content: body('v7') } })
      }
      if (url.pathname === '/api/v1/vaults/vault/mutations') {
        const { mutations } = JSON.parse(String(init?.body))
        return json(200, {
          acknowledged: mutations.map((mutation: { operation_id: string; item_id: string }) => ({
            operation_id: mutation.operation_id, item_id: mutation.item_id, revision: 2, sequence: 41
          })),
          conflicts: [],
          cursor: 41
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    let operation = 0
    const coordinator = new CloudSyncCoordinator(
      'vault',
      createCloudSyncClient('https://zennotes.test', 'token', fetchImplementation),
      new DesktopCloudSyncRepository(root),
      states,
      { itemId: () => 'item-new', operationId: () => `operation-${++operation}` }
    )

    await expect(coordinator.sync()).resolves.toMatchObject({ pulled: 1, pushed: 1 })

    expect(await readFile(path.join(root, 'Plan.md'), 'utf8')).toBe('v7')
    expect(await readFile(path.join(root, 'Draft.md'), 'utf8')).toBe('draft, edited here')
    expect(requests).toEqual([
      'GET /api/v1/vaults/vault/changes?after=3&limit=250',
      'GET /api/v1/vaults/vault/manifest?include_content=false&page=1&per_page=250',
      'GET /api/v1/vaults/vault/items/plan/revisions/7',
      'GET /api/v1/vaults/vault/changes?after=40&limit=250',
      'POST /api/v1/vaults/vault/mutations',
      'GET /api/v1/vaults/vault/changes?after=40&limit=250'
    ])
  })
})
