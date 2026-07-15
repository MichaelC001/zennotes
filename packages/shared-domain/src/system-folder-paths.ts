import type { NoteFolder } from '@zennotes/bridge-contract/ipc'

export type SystemFolderPaths = Partial<Record<NoteFolder, string>>

export const DEFAULT_FOLDER_PATHS: Record<NoteFolder, string> = {
  inbox: 'inbox',
  quick: 'quick',
  archive: 'archive',
  trash: 'trash'
}

const FOLDER_IDS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']

const MAX_PATH_LENGTH = 128

const RESERVED_ROOT_NAMES = new Set([
  'assets',
  '.zennotes',
  'attachements',
  '_assets',
  'deleted-assets',
  'comments'
])

const INVALID_CHARS_RE = /[\\:*?"<>|#^\[\]<>]/

function normalizeSystemFolderPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > MAX_PATH_LENGTH) return null
  if (trimmed.includes('/') || trimmed.includes('\\')) return null
  if (trimmed.startsWith('/')) return null
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) return null
  if (INVALID_CHARS_RE.test(trimmed)) return null
  return trimmed
}

export function normalizeSystemFolderPaths(
  value: unknown
): SystemFolderPaths {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Partial<Record<NoteFolder, unknown>>
  const next: SystemFolderPaths = {}
  for (const key of FOLDER_IDS) {
    const p = normalizeSystemFolderPath(raw[key])
    if (p && p !== DEFAULT_FOLDER_PATHS[key]) {
      next[key] = p
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const key of FOLDER_IDS) {
      if (!next[key]) continue
      const resolved = resolveFolderPath(key, next)
      const lower = resolved.toLowerCase()
      if (RESERVED_ROOT_NAMES.has(lower)) {
        delete next[key]
        changed = true
        continue
      }
      for (const other of FOLDER_IDS) {
        if (other === key) continue
        const otherResolved = resolveFolderPath(other, next).toLowerCase()
        if (lower === otherResolved) {
          delete next[key]
          changed = true
          break
        }
      }
    }
  }
  return next
}

export function resolveFolderPath(
  folder: NoteFolder,
  overrides?: SystemFolderPaths | null
): string {
  return overrides?.[folder] ?? DEFAULT_FOLDER_PATHS[folder]
}

export function buildReverseFolderMap(
  overrides?: SystemFolderPaths | null
): Map<string, NoteFolder> {
  const map = new Map<string, NoteFolder>()
  for (const folder of FOLDER_IDS) {
    const p = resolveFolderPath(folder, overrides)
    if (p !== DEFAULT_FOLDER_PATHS[folder]) {
      map.set(p.toLowerCase(), folder)
    }
  }
  return map
}
