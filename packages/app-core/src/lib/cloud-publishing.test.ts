import { describe, expect, it, vi } from 'vitest'
import type { CloudServiceAccount } from '@zennotes/bridge-contract/cloud-sync'
import {
  collectCloudPublishAssets,
  publishCloudNote,
  type CloudPublishingBridge
} from './cloud-publishing'
import { useStore } from '../store'

const serviceAccount = (publishActive = true): CloudServiceAccount => ({
  user: { name: 'Ada', email: 'ada@example.com' },
  device: {
    id: 'device-1',
    name: 'Ada’s Mac',
    platform: 'desktop',
    app_version: '2.26.0'
  },
  features: {
    sync: { active: true, limits: null },
    backup: { active: true, limits: null },
    publish: { active: publishActive, limits: null }
  }
})

function setup(published = false, publishActive = true) {
  const createPublishedNote = vi.fn(async () => ({
    id: 42,
    slug: 'launch',
    url: 'https://zennotes.org/s/launch'
  }))
  const updateCloudPublishedNote = vi.fn(async () => ({
    id: 42,
    slug: 'launch',
    url: 'https://zennotes.org/s/launch'
  }))
  const bridge: CloudPublishingBridge = {
    getCloudServiceAccount: vi.fn(async () => serviceAccount(publishActive)),
    listCloudPublishedNotes: vi.fn(async () => published
      ? [{
          id: 42,
          slug: 'launch',
          url: 'https://zennotes.org/s/launch',
          title: 'Launch',
          note_path: 'Notes/Launch.md',
          view_count: 3,
          created_at: '2026-08-10T12:00:00.000Z',
          updated_at: '2026-08-10T12:00:00.000Z'
        }]
      : []),
    publishCloudNote: createPublishedNote,
    updateCloudPublishedNote,
    readVaultAssetBase64: vi.fn(async () => 'AQID')
  }

  return { bridge, createPublishedNote, updateCloudPublishedNote }
}

const note = {
  path: 'Notes/Launch.md',
  title: 'Launch',
  body: '# Launch',
  assetEmbeds: []
}

describe('cloud publishing', () => {
  it('publishes a note for the first time', async () => {
    const { bridge, createPublishedNote } = setup()

    await expect(publishCloudNote(note, bridge)).resolves.toMatchObject({ updated: false })
    expect(createPublishedNote).toHaveBeenCalledWith({
      note_path: note.path,
      title: note.title,
      markdown: note.body
    })
  })

  it('updates the existing public note without changing its link', async () => {
    const { bridge, updateCloudPublishedNote } = setup(true)

    await expect(publishCloudNote(note, bridge)).resolves.toMatchObject({
      updated: true,
      url: 'https://zennotes.org/s/launch'
    })
    expect(updateCloudPublishedNote).toHaveBeenCalledWith(42, {
      note_path: note.path,
      title: note.title,
      markdown: note.body
    })
  })

  it('rejects attachments when their bytes were not prepared', async () => {
    const { bridge, createPublishedNote } = setup()

    await expect(publishCloudNote({ ...note, assetEmbeds: ['photo.png'] }, bridge))
      .rejects.toThrow('attachment')
    expect(createPublishedNote).not.toHaveBeenCalled()
  })

  it('reads and publishes supported local attachments', async () => {
    const { bridge, createPublishedNote } = setup()
    const withPhoto = { ...note, body: '![Photo](photo.png)', assetEmbeds: ['photo.png'] }
    useStore.setState({
      assetFiles: [{ path: 'Notes/photo.png', name: 'photo.png' } as never]
    })

    const assets = await collectCloudPublishAssets(withPhoto, '/vault', bridge)
    await publishCloudNote(withPhoto, bridge, assets)

    expect(bridge.readVaultAssetBase64).toHaveBeenCalledWith('Notes/photo.png')
    expect(createPublishedNote).toHaveBeenCalledWith(expect.objectContaining({
      assets: [{ ref: 'photo.png', name: 'photo.png', mime: 'image/png', base64: 'AQID' }]
    }))
  })

  it('requires an active publishing entitlement', async () => {
    const { bridge, createPublishedNote } = setup(false, false)

    await expect(publishCloudNote(note, bridge)).rejects.toThrow('plan')
    expect(createPublishedNote).not.toHaveBeenCalled()
  })
})
