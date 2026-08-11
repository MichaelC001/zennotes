import { useEffect, useState } from 'react'
import { getZenBridge, type ZenBridge } from '@zennotes/bridge-contract/bridge'
import type { PublishableCloudNote } from '../lib/cloud-publishing'
import {
  subscribePublishedNoteChanges,
  type PublishedNoteChange
} from '../lib/published-note-events'
import { requestPublishNote } from '../lib/publish-note-requests'
import { LinkIcon } from './icons'

type PublishedNoteLookupBridge = Pick<ZenBridge, 'listCloudPublishedNotes'>

export function PublishedNoteButton({
  note,
  bridge = getZenBridge()
}: {
  note: PublishableCloudNote
  bridge?: PublishedNoteLookupBridge
}): JSX.Element {
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let changedSinceRequest = false

    setPublishedUrl(null)
    setLoading(true)

    const unsubscribe = subscribePublishedNoteChanges((change: PublishedNoteChange) => {
      if (change.notePath !== note.path) return
      changedSinceRequest = true
      setPublishedUrl(change.url)
    })

    void bridge.listCloudPublishedNotes()
      .then((publishedNotes) => {
        if (cancelled || changedSinceRequest) return
        const published = publishedNotes.find((candidate) => candidate.note_path === note.path)
        setPublishedUrl(published?.url ?? null)
      })
      .catch(() => {
        // Publishing stays available when the status lookup is temporarily unavailable.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge, note.path])

  const published = publishedUrl !== null
  const label = published ? 'Published · Manage public note' : 'Publish note'

  return (
    <button
      type="button"
      onClick={() => requestPublishNote(note)}
      aria-label={label}
      aria-busy={loading}
      data-published={published ? 'true' : 'false'}
      className={[
        'group relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors',
        published
          ? 'gap-1.5 border border-accent/25 bg-accent/10 px-2 text-xs font-medium text-accent hover:bg-accent/15'
          : 'w-7 text-ink-500 hover:bg-paper-200 hover:text-ink-900'
      ].join(' ')}
    >
      <LinkIcon width={14} height={14} />
      {published && <span>Published</span>}
      <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs font-medium text-ink-800 shadow-panel group-hover:block group-focus-visible:block">
        {label}
      </span>
    </button>
  )
}
