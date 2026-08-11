import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  CloudSyncLocalEditConflictError,
  DesktopCloudSyncRepository,
  DesktopCloudSyncStateStore
} from './cloud-sync-filesystem'
import type { CloudSyncTrackedItem } from '@zennotes/shared-domain/cloud-sync-engine'

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

describe('DesktopCloudSyncRepository', () => {
  it('scans text and binary vault files while excluding local sync state', async () => {
    const root = await temporaryRoot()
    await mkdir(path.join(root, '.zennotes', 'sync'), { recursive: true })
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'package'), { recursive: true })
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

  it('does not overwrite a local edit while pulling remote changes', async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, 'note.md'), 'local edit')
    const repository = new DesktopCloudSyncRepository(root)

    await expect(
      repository.apply(
        {
          sequence: 2,
          item_id: 'item-1',
          type: 'upsert',
          path: 'note.md',
          previous_path: null,
          revision: 2,
          content: {
            encoding: 'utf8',
            data: 'remote edit',
            sha256: hash('remote edit'),
            byte_length: 11,
            media_type: 'text/markdown'
          }
        },
        tracked('note.md', 'old contents')
      )
    ).rejects.toBeInstanceOf(CloudSyncLocalEditConflictError)
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('local edit')
  })
})

describe('DesktopCloudSyncStateStore', () => {
  it('persists cursor state outside the vault', async () => {
    const root = await temporaryRoot()
    const stateDirectory = path.join(root, 'user-data', 'cloud-sync')
    const store = new DesktopCloudSyncStateStore(stateDirectory)
    const state = { version: 1 as const, vault_id: 'vault-1', cursor: 7, items: {} }

    await store.save(state)

    expect(await store.load('vault-1')).toEqual(state)
    expect(await store.load('another-vault')).toBeNull()
  })
})
