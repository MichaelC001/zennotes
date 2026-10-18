import { describe, expect, it } from 'vitest'
import { shouldQuitWithOnlyQuickCaptureLeft } from './last-window'

describe('a hidden Quick capture panel does not keep the app alive', () => {
  // The last workspace window just closed on Linux or Windows, the tray is
  // off, and the panel was opened once and dismissed.
  const base = {
    isMac: false,
    keepRunningInTray: false,
    quitting: false,
    windowClosed: true,
    otherWindows: 0,
    quickCapture: 'hidden' as const
  }

  it('quits once only the hidden panel is left', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft(base)).toBe(true)
  })

  it('leaves macOS running with no window, as always', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft({ ...base, isMac: true })).toBe(false)
  })

  it('keeps running with the tray on, where the icon shows it and the hotkey still works', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft({ ...base, keepRunningInTray: true })).toBe(false)
  })

  it('stands aside while the app is already quitting', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft({ ...base, quitting: true })).toBe(false)
  })

  it('keeps any other window open, hidden or not, the way Electron counts them', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft({ ...base, otherWindows: 1 })).toBe(false)
  })

  it('waits for a panel still on screen to hide', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft({ ...base, quickCapture: 'visible' })).toBe(false)
  })

  it('leaves the no-window case to window-all-closed', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft({ ...base, quickCapture: 'none' })).toBe(false)
  })

  it('keeps a quick-capture deep-link launch resident until a window is closed', () => {
    expect(shouldQuitWithOnlyQuickCaptureLeft({ ...base, windowClosed: false })).toBe(false)
  })
})
