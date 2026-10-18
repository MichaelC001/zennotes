/**
 * Closing the last window quits ZenNotes on Windows and Linux. The Quick
 * capture panel hides instead of closing, so the hotkey's next press is
 * instant, and Electron counts a hidden window as open: once the panel had
 * been used, closing the last window never fired `window-all-closed`, and the
 * app kept running with nothing on screen, no taskbar entry and no tray icon.
 * A hidden panel is not a window anyone can get back to, so it does not keep
 * the app alive. This runs after any window closes and when the panel hides.
 */
export function shouldQuitWithOnlyQuickCaptureLeft(input: {
  /** macOS keeps an app running with no window at all, as it always has. */
  isMac: boolean
  /** With the tray on (#947) the icon keeps a running app reachable and in
   *  sight, so the panel and its hotkey may go on running. */
  keepRunningInTray: boolean
  /** Windows close one by one while the app quits; one quit is enough. */
  quitting: boolean
  /** Whether a window has closed in this run. A `zennotes://quick-capture`
   *  launch opens the panel alone and stays resident between captures (the
   *  deep link stands in for the hotkey where the compositor owns the
   *  keyboard), until a window it opened is closed. */
  windowClosed: boolean
  /** Every other window, hidden ones included: a window the tray holds, a
   *  floating note or a standalone file keeps the app, as Electron would. */
  otherWindows: number
  /** A visible panel is still in use, so the app waits for it to hide. */
  quickCapture: 'none' | 'hidden' | 'visible'
}): boolean {
  return (
    !input.isMac &&
    !input.keepRunningInTray &&
    !input.quitting &&
    input.windowClosed &&
    input.otherWindows === 0 &&
    input.quickCapture === 'hidden'
  )
}
