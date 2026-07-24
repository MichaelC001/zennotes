// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// #459: pasting an image into a note that lives in a subfolder (e.g. a daily
// note under `Daily Notes/`) inserts a vault-root wikilink `![[assets/img.png]]`.
// That path must resolve from the vault root — Obsidian wikilink semantics —
// not relative to the note's folder, otherwise the embed silently fails to
// render whenever another file shares the basename. The reporter's manual fix
// (a leading slash, `![[/assets/img.png]]`) forced the root match; now the bare
// path does too.

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      resolveLocalAssetUrl: vi.fn((_r: string, _n: string, href: string) => `zen-asset://v/${href}`),
      resolveVaultAssetUrl: vi.fn((_r: string, rel: string) => `zen-asset://v/${rel}`)
    }
  })
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  const { useStore } = await import('../store')
  const { resolveAssetVaultRelativePath, enhanceLocalAssetNodes } = await import('./local-assets')
  return { useStore, resolveAssetVaultRelativePath, enhanceLocalAssetNodes }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

const DAILY_NOTE = 'Daily Notes/2026-07-24.md'

describe('#459 — vault-root wikilink embeds resolve from the root', () => {
  it('resolves a path-qualified asset from a subfolder note even when the basename collides', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({
      assetFiles: [{ path: 'assets/image.png' }, { path: 'Photos/image.png' }] as never
    })
    // Before the fix this returned null (note-relative join missed, basename
    // search was ambiguous) so the image never rendered.
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, 'assets/image.png')).toBe(
      'assets/image.png'
    )
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, 'Photos/image.png')).toBe(
      'Photos/image.png'
    )
  })

  it('still resolves a unique basename from a subfolder note', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({ assetFiles: [{ path: 'assets/image.png' }] as never })
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, 'assets/image.png')).toBe(
      'assets/image.png'
    )
  })

  it('leading-slash absolute paths keep resolving from the root', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    useStore.setState({
      assetFiles: [{ path: 'assets/image.png' }, { path: 'Photos/image.png' }] as never
    })
    expect(resolveAssetVaultRelativePath('/v', DAILY_NOTE, '/assets/image.png')).toBe(
      'assets/image.png'
    )
  })

  it('prefers a genuine note-relative sibling over the vault-root candidate', async () => {
    const { useStore, resolveAssetVaultRelativePath } = await load()
    // Both a sibling `Folder/pic.png` and a root `pic.png` exist: a note-relative
    // markdown link `[x](pic.png)` must still resolve to the sibling, not the root.
    useStore.setState({
      assetFiles: [{ path: 'Folder/pic.png' }, { path: 'pic.png' }] as never
    })
    expect(resolveAssetVaultRelativePath('/v', 'Folder/note.md', 'pic.png')).toBe('Folder/pic.png')
  })

  it('renders the img embed src for a subfolder note (end to end)', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({
      assetFiles: [{ path: 'assets/image.png' }, { path: 'Photos/image.png' }] as never
    })
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="assets/image.png" alt="image.png"></p>'
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: DAILY_NOTE })
    const img = root.querySelector<HTMLImageElement>('img')!
    expect(img.dataset.localAssetUrl).toBe('zen-asset://v/assets/image.png')
  })
})
