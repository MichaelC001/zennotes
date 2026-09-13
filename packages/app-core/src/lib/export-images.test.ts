// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleExportImages } from './export-images'

// #769: the preview lazy-loads local images, so in the hidden export window an
// image below the viewport never loaded and printed as an empty frame. The
// export now flips deferred images to eager and waits for every load to end.

function image(src: string | null, loading?: string): HTMLImageElement {
  const img = document.createElement('img')
  if (src !== null) img.setAttribute('src', src)
  if (loading) img.setAttribute('loading', loading)
  document.body.append(img)
  return img
}

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('settleExportImages', () => {
  it('turns lazy images eager and resolves once every load has ended', async () => {
    const lazy = image('zen-asset://v/bottom.png', 'lazy')
    const plain = image('https://example.test/remote.png')
    let settled = false
    const done = settleExportImages(document).then(() => {
      settled = true
    })

    expect(lazy.getAttribute('loading')).toBe('eager')
    await Promise.resolve()
    expect(settled).toBe(false)

    lazy.dispatchEvent(new Event('load'))
    await Promise.resolve()
    expect(settled).toBe(false)

    // A failed load ends the wait too: the export prints the broken image
    // rather than hanging on it.
    plain.dispatchEvent(new Event('error'))
    await done
    expect(settled).toBe(true)
  })

  it('resolves at once when nothing is pending', async () => {
    image(null)
    image('')
    await expect(settleExportImages(document)).resolves.toBeUndefined()
  })

  it('gives up after the timeout so a dead source cannot hang the export', async () => {
    vi.useFakeTimers()
    image('https://example.test/never.png', 'lazy')
    let settled = false
    const done = settleExportImages(document, 500).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(settled).toBe(true)
  })
})
