import { describe, expect, it, vi } from 'vitest'

// tray.ts imports electron at module load; the helpers under test are pure.
vi.mock('electron', () => ({
  app: { isPackaged: false },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ setTemplateImage: () => undefined }) },
  Tray: class {}
}))

import { parseTraySyncStatus, shouldHideOnClose, traySyncLine, trayTooltip } from './tray'

const clock = (epochMs: number): string => `T${epochMs}`

describe('close to tray (#947)', () => {
  const base = {
    keepRunningInTray: true,
    quitting: false,
    isWorkspaceWindow: true,
    otherVisibleWorkspaceWindows: 0
  }

  it('hides the last visible workspace window', () => {
    expect(shouldHideOnClose(base)).toBe(true)
  })

  it('closes as before with the setting off', () => {
    expect(shouldHideOnClose({ ...base, keepRunningInTray: false })).toBe(false)
  })

  it('lets every window close while the app quits, or it could never exit', () => {
    expect(shouldHideOnClose({ ...base, quitting: true })).toBe(false)
  })

  it('closes one of several windows instead of hiding it', () => {
    expect(shouldHideOnClose({ ...base, otherVisibleWorkspaceWindows: 1 })).toBe(false)
  })

  it('never holds a utility window such as Quick capture', () => {
    expect(shouldHideOnClose({ ...base, isWorkspaceWindow: false })).toBe(false)
  })
})

describe('tray sync line (#947)', () => {
  it('says nothing without a connected vault', () => {
    expect(traySyncLine(null, clock)).toBeNull()
    expect(trayTooltip(null)).toBe('ZenNotes')
  })

  it('gives a clock time for the last sync, which stays true while the menu is open', () => {
    const line = traySyncLine({ state: 'idle', vaultName: 'Work', lastSyncedAt: 1_700_000_000_000 }, clock)
    expect(line).toBe('Cloud: synced at T1700000000000')
    expect(trayTooltip(line)).toBe('ZenNotes\nCloud: synced at T1700000000000')
  })

  it('names each state', () => {
    const at = (state: 'idle' | 'syncing' | 'attention' | 'error') =>
      traySyncLine({ state, vaultName: null, lastSyncedAt: null }, clock)
    expect(at('idle')).toBe('Cloud: ready')
    expect(at('syncing')).toBe('Cloud: syncing…')
    expect(at('attention')).toBe('Cloud: needs attention')
    expect(at('error')).toBe('Cloud: sync failed')
  })
})

describe('tray sync status from the renderer (#947)', () => {
  it('keeps a well-formed status', () => {
    expect(parseTraySyncStatus({ state: 'syncing', vaultName: ' Work ', lastSyncedAt: 5 })).toEqual({
      state: 'syncing',
      vaultName: 'Work',
      lastSyncedAt: 5
    })
  })

  it('drops anything else, since the renderer is untrusted', () => {
    expect(parseTraySyncStatus(null)).toBeNull()
    expect(parseTraySyncStatus('idle')).toBeNull()
    expect(parseTraySyncStatus({ state: 'exploded' })).toBeNull()
    expect(parseTraySyncStatus({ state: 'idle', vaultName: 42, lastSyncedAt: Number.NaN })).toEqual({
      state: 'idle',
      vaultName: null,
      lastSyncedAt: null
    })
  })

  it('caps a long vault name', () => {
    const status = parseTraySyncStatus({ state: 'idle', vaultName: 'x'.repeat(500), lastSyncedAt: null })
    expect(status?.vaultName).toHaveLength(120)
  })
})
