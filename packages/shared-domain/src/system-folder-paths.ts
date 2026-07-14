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
  const trimmed = value.trim().replace(/\\/g, '/')
  if (!trimmed) return null
  if (trimmed.length > MAX_PATH_LENGTH) return null
  if (trimmed.startsWith('/')) return null
  const parts = trimmed.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return null
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
  if (!hasValidPaths(next)) return {}
  return next
}

function hasValidPaths(paths: SystemFolderPaths): boolean {
  const values = Object.values(paths)
  if (new Set(values).size !== values.length) return false
  for (const p of values) {
    const top = p.split('/')[0]
    if (RESERVED_ROOT_NAMES.has(top)) return false
    for (const other of values) {
      if (other === p) continue
      if (other === top || other.startsWith(top + '/')) return false
      const otherTop = other.split('/')[0]
      if (p === otherTop || p.startsWith(otherTop + '/')) return false
    }
  }
  return true
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
    const top = p.split('/')[0]
    if (top !== DEFAULT_FOLDER_PATHS[folder]) {
      map.set(top.toLowerCase(), folder)
    }
  }
  return map
}
