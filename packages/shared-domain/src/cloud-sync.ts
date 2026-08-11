const WINDOWS_RESERVED_CHARACTERS = /[:*?"<>|]/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const LOCAL_ONLY_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules'])

function invalidSyncPath(path: string): never {
  throw new Error(`Invalid sync path: ${JSON.stringify(path)}`)
}

/**
 * Return the portable, vault-relative representation used by the sync wire
 * protocol. ZenNotes vaults may move between case-sensitive and
 * case-insensitive file systems, so paths accepted here must be valid on all
 * supported platforms.
 */
export function normalizeCloudSyncPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').normalize('NFC')

  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    CONTROL_CHARACTERS.test(normalized)
  ) {
    return invalidSyncPath(path)
  }

  const segments = normalized.split('/')
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        WINDOWS_RESERVED_CHARACTERS.test(segment)
    )
  ) {
    return invalidSyncPath(path)
  }

  return normalized
}

/** A case-folded collision key; the original path remains user-visible. */
export function cloudSyncPathKey(path: string): string {
  return normalizeCloudSyncPath(path).toLowerCase()
}

/**
 * Whether a vault file is user-authored state that should cross devices.
 * Unknown files inside `.zennotes` default to local-only so a new cache or
 * credential file cannot silently enter sync.
 */
export function shouldSyncVaultPath(path: string): boolean {
  let normalized: string
  try {
    normalized = normalizeCloudSyncPath(path)
  } catch {
    return false
  }

  const lower = normalized.toLowerCase()
  const segments = lower.split('/')
  const name = lower.slice(lower.lastIndexOf('/') + 1)

  if (
    segments.some((segment) => LOCAL_ONLY_DIRECTORIES.has(segment)) ||
    name === '.ds_store' ||
    name === 'thumbs.db' ||
    name.endsWith('.tmp') ||
    name.endsWith('.bak') ||
    name.endsWith('~')
  ) {
    return false
  }

  if (!lower.startsWith('.zennotes/')) {
    return true
  }

  return (
    lower === '.zennotes/vault.json' ||
    lower.startsWith('.zennotes/comments/') ||
    lower.startsWith('.zennotes/templates/') ||
    lower.startsWith('.zennotes/workflows/')
  )
}

/** Skip large device-local trees before reading their contents. */
export function shouldTraverseCloudSyncDirectory(path: string): boolean {
  let normalized: string
  try {
    normalized = normalizeCloudSyncPath(path)
  } catch {
    return false
  }

  return !normalized
    .toLowerCase()
    .split('/')
    .some((segment) => LOCAL_ONLY_DIRECTORIES.has(segment))
}
