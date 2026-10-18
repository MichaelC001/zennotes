import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron'
import path from 'node:path'
import type { TraySyncState, TraySyncStatus } from '@shared/ipc'

/**
 * The tray icon behind "Keep running in the tray" (#947). With it on, closing
 * the last workspace window hides it instead of ending the session, so Cloud
 * sync (which runs in the window's renderer) and the Quick capture hotkey keep
 * working. The icon is how a hidden app stays reachable and honest: a click
 * brings the window back, the menu quits for real, and a connected vault's
 * sync state shows in the tooltip and on a menu line.
 */

export interface TrayActions {
  showWindows(): void
  openQuickCapture(): void
  quit(): void
}

const SYNC_STATES: ReadonlySet<TraySyncState> = new Set(['idle', 'syncing', 'attention', 'error'])
const MAX_VAULT_NAME_LENGTH = 120

/** The renderer is untrusted: keep only a well-formed status. */
export function parseTraySyncStatus(raw: unknown): TraySyncStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.state !== 'string' || !SYNC_STATES.has(value.state as TraySyncState)) return null
  const vaultName =
    typeof value.vaultName === 'string' && value.vaultName.trim()
      ? value.vaultName.trim().slice(0, MAX_VAULT_NAME_LENGTH)
      : null
  const lastSyncedAt =
    typeof value.lastSyncedAt === 'number' && Number.isFinite(value.lastSyncedAt) && value.lastSyncedAt > 0
      ? value.lastSyncedAt
      : null
  return { state: value.state as TraySyncState, vaultName, lastSyncedAt }
}

/** The tray's sync line. A menu is not redrawn while it is open, so a time is
 *  given as a clock time ("Synced at 14:05"), which stays true, rather than
 *  "2 min ago", which would not. */
export function traySyncLine(
  status: TraySyncStatus | null,
  formatTime: (epochMs: number) => string
): string | null {
  if (!status) return null
  switch (status.state) {
    case 'syncing':
      return 'Cloud: syncing…'
    case 'attention':
      return 'Cloud: needs attention'
    case 'error':
      return 'Cloud: sync failed'
    case 'idle':
      return status.lastSyncedAt === null
        ? 'Cloud: ready'
        : `Cloud: synced at ${formatTime(status.lastSyncedAt)}`
  }
}

export function trayTooltip(syncLine: string | null): string {
  return syncLine ? `ZenNotes\n${syncLine}` : 'ZenNotes'
}

/**
 * Whether a workspace window's close should hide it instead. Only the last
 * visible workspace window hides: closing one of several still closes it, and
 * quitting (the tray's Quit, Cmd+Q, an update's restart) or the session
 * ending always lets windows close, or the app could never exit.
 */
export function shouldHideOnClose(input: {
  keepRunningInTray: boolean
  quitting: boolean
  sessionEnding: boolean
  isWorkspaceWindow: boolean
  otherVisibleWorkspaceWindows: number
}): boolean {
  return (
    input.keepRunningInTray &&
    !input.quitting &&
    !input.sessionEnding &&
    input.isWorkspaceWindow &&
    input.otherVisibleWorkspaceWindows === 0
  )
}

/** Long enough to cover the gap between Windows asking every app and telling
 *  them the answer, short enough that someone who cancelled a sign-out is
 *  unlikely to close a window inside it. */
export const SESSION_END_GRACE_MS = 10_000

/**
 * Windows asks every window before it signs out, restarts or shuts down
 * (`query-session-end`), and a close turned into a hide from then on would
 * hold the session up, so windows close for real. The question is not the
 * answer, though: another app can refuse, or the user can cancel, and then
 * Electron says nothing more, since it emits `session-end` only when the
 * session really ends. So a question holds for a grace period and lapses,
 * and closing hides to the tray again; `session-end` is final. Times come
 * from a monotonic clock the caller passes in.
 */
export class SessionEndWatch {
  private queriedAt: number | null = null
  private ended = false

  constructor(private readonly graceMs = SESSION_END_GRACE_MS) {}

  query(now: number): void {
    this.queriedAt = now
  }

  end(): void {
    this.ended = true
  }

  isEnding(now: number): boolean {
    if (this.ended) return true
    return this.queriedAt !== null && now - this.queriedAt < this.graceMs
  }
}

let tray: Tray | null = null
let actions: TrayActions | null = null
let syncStatus: TraySyncStatus | null = null

function trayIconFile(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tray', name)
    : path.join(__dirname, '../../build/tray', name)
}

/** macOS gets a template glyph, which the menu bar tints for light and dark.
 *  Windows and Linux panels come in both shades with no tinting, so they get
 *  the app icon's dark tile, which reads on either; Linux at 32 px, since its
 *  panels draw tray icons at 22 to 24 and scale down more cleanly than up. */
function trayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    const image = nativeImage.createFromPath(trayIconFile('trayTemplate.png'))
    image.setTemplateImage(true)
    return image
  }
  if (process.platform === 'linux') return nativeImage.createFromPath(trayIconFile('tray@2x.png'))
  return nativeImage.createFromPath(trayIconFile('tray.png'))
}

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function refreshTray(): void {
  if (!tray || tray.isDestroyed() || !actions) return
  const current = actions
  const syncLine = traySyncLine(syncStatus, formatClockTime)
  tray.setToolTip(trayTooltip(syncLine))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open ZenNotes', click: () => current.showWindows() },
      { label: 'Quick Capture', click: () => current.openQuickCapture() },
      ...(syncLine ? [{ type: 'separator' as const }, { label: syncLine, enabled: false }] : []),
      { type: 'separator' },
      { label: 'Quit ZenNotes', click: () => current.quit() }
    ])
  )
}

export function isTrayShown(): boolean {
  return tray !== null && !tray.isDestroyed()
}

/** Create the icon if it is not there yet. The Tray object lives in this
 *  module for the life of the app; a collected Tray takes its icon with it. */
export function showTray(next: TrayActions): void {
  actions = next
  if (!isTrayShown()) {
    tray = new Tray(trayIcon())
    // A left click opens the window. On Linux most hosts open the menu on any
    // click instead, and the menu's first item does the same.
    tray.on('click', () => actions?.showWindows())
  }
  refreshTray()
}

export function hideTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

export function setTraySyncStatus(status: TraySyncStatus | null): void {
  syncStatus = status
  refreshTray()
}
