import { useEffect, useMemo, useState } from 'react'
import { getZenBridge, type ZenBridge } from '@zennotes/bridge-contract/bridge'
import type {
  CloudPublishAppearanceInput,
  CloudPublishAssetInput,
  CloudPublishedNote
} from '@zennotes/bridge-contract/cloud-sync'
import {
  prepareCloudPublishLogo,
  publishCloudNoteWithFeedback,
  type PublishableCloudNote
} from '../lib/cloud-publishing'
import { THEMES, type ThemeFamily } from '../lib/themes'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

const FAMILY_LABELS: Record<Exclude<ThemeFamily, 'custom'>, string> = {
  apple: 'Apple',
  gruvbox: 'Gruvbox',
  catppuccin: 'Catppuccin',
  github: 'GitHub',
  solarized: 'Solarized',
  one: 'One',
  nord: 'Nord',
  'tokyo-night': 'Tokyo Night',
  kanagawa: 'Kanagawa',
  'black-metal': 'Black Metal',
  'rose-pine': 'Rosé Pine'
}

type LogoChoice =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'replace'; logo: CloudPublishAssetInput }

export function PublishNoteModal({
  note,
  onClose,
  bridge = getZenBridge()
}: {
  note: PublishableCloudNote
  onClose: () => void
  bridge?: ZenBridge
}): JSX.Element {
  const [existing, setExisting] = useState<CloudPublishedNote | null>(null)
  const [theme, setTheme] = useState('system')
  const [logoChoice, setLogoChoice] = useState<LogoChoice>({ kind: 'keep' })
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void bridge.listCloudPublishedNotes()
      .then((notes) => {
        if (cancelled) return
        const published = notes.find((candidate) => candidate.note_path === note.path) ?? null
        setExisting(published)
        setTheme(published?.appearance?.theme ?? 'system')
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not load publishing settings.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [bridge, note.path])

  const groupedThemes = useMemo(() => {
    return Object.entries(FAMILY_LABELS).map(([family, label]) => ({
      family,
      label,
      themes: THEMES.filter((candidate) => candidate.family === family)
    }))
  }, [])

  const previewUrl = logoChoice.kind === 'replace'
    ? `data:${logoChoice.logo.mime};base64,${logoChoice.logo.base64}`
    : logoChoice.kind === 'keep'
      ? existing?.appearance?.logo_url ?? null
      : null

  const chooseLogo = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setError(null)
    try {
      setLogoChoice({ kind: 'replace', logo: await prepareCloudPublishLogo(file) })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not prepare that logo.')
    }
  }

  const publish = async (): Promise<void> => {
    setPublishing(true)
    setError(null)

    const appearance: CloudPublishAppearanceInput = {
      theme,
      ...(logoChoice.kind === 'replace'
        ? { logo: logoChoice.logo }
        : logoChoice.kind === 'remove'
          ? { logo: null }
          : {})
    }

    try {
      await publishCloudNoteWithFeedback(note, bridge, appearance)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not publish this note.')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Modal size="md" layer="modal" align="center" onClose={onClose}>
      <Modal.Header
        title={existing ? 'Update public note' : 'Publish note'}
        description="Choose how this note looks on the web. You can change these settings later without changing its link."
      />
      <Modal.Body className="space-y-5">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink-800">Theme</span>
          <select
            value={theme}
            disabled={loading || publishing}
            onChange={(event) => setTheme(event.target.value)}
            className="w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="system">Automatic light and dark</option>
            {groupedThemes.map((group) => (
              <optgroup key={group.family} label={group.label}>
                {group.themes.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.mode === 'dark' ? 'Dark' : 'Light'}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="mt-1.5 block text-xs leading-5 text-ink-500">
            Automatic follows each visitor’s device. Fixed themes keep the same appearance for everyone.
          </span>
        </label>

        <div>
          <div className="mb-2 text-sm font-medium text-ink-800">Logo</div>
          <div className="flex min-h-20 items-center gap-4 rounded-xl border border-paper-300/80 bg-paper-50/60 p-3">
            <div className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-paper-300/70 bg-paper-100">
              {previewUrl ? (
                <img src={previewUrl} alt="Published logo preview" className="max-h-12 max-w-20 object-contain" />
              ) : (
                <span className="text-xs text-ink-400">ZenNotes</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink-700">
                {previewUrl ? 'Custom logo' : 'ZenNotes logo'}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-ink-500">
                PNG, JPEG, WebP, or AVIF. Up to 1 MB and 1024 × 1024.
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-sm font-medium text-ink-800 transition-colors hover:bg-paper-200">
                  Choose image
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/avif"
                    className="sr-only"
                    disabled={publishing}
                    onChange={(event) => {
                      void chooseLogo(event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                </label>
                {previewUrl && (
                  <Button
                    variant="ghost"
                    disabled={publishing}
                    onClick={() => setLogoChoice({ kind: 'remove' })}
                  >
                    Remove
                  </Button>
                )}
                {logoChoice.kind !== 'keep' && existing?.appearance?.logo_url && (
                  <Button
                    variant="ghost"
                    disabled={publishing}
                    onClick={() => setLogoChoice({ kind: 'keep' })}
                  >
                    Keep current
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" disabled={publishing} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={loading || publishing} onClick={() => void publish()}>
          {publishing ? 'Publishing…' : existing ? 'Update note' : 'Publish note'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
