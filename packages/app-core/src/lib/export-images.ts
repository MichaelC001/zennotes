/**
 * Settle every image in a rendered note before a PDF export prints.
 *
 * The reading preview marks local images `loading="lazy"`: on screen a long
 * note only fetches what scrolls into view. The export window is hidden and
 * never scrolls, so an image below its viewport never starts loading, and the
 * print captures an empty frame with the caption underneath (#769). The
 * export therefore flips every deferred image to eager (which starts its load
 * at once) and waits for the loads to finish, success or failure alike, so the
 * page prints whatever the images turn out to be.
 *
 * Capped, so one dead remote URL can never hang the export. The desktop main
 * process gives the export window 15 s in total; this stays well inside it.
 */
export const EXPORT_IMAGE_SETTLE_TIMEOUT_MS = 8000

export function settleExportImages(
  root: ParentNode,
  timeoutMs = EXPORT_IMAGE_SETTLE_TIMEOUT_MS
): Promise<void> {
  const pending: Promise<void>[] = []
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    if (img.getAttribute('loading') === 'lazy') img.setAttribute('loading', 'eager')
    // `complete` is true once the load ended either way, and for an image with
    // no source, which has nothing to wait for.
    if (img.complete) continue
    pending.push(
      new Promise<void>((resolve) => {
        const done = (): void => {
          img.removeEventListener('load', done)
          img.removeEventListener('error', done)
          resolve()
        }
        img.addEventListener('load', done)
        img.addEventListener('error', done)
      })
    )
  }
  if (pending.length === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    void Promise.all(pending).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
