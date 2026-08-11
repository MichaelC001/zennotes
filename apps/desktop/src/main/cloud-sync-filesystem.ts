import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import type { CloudSyncChange, CloudSyncContent } from '@zennotes/bridge-contract/cloud-sync'
import {
  normalizeCloudSyncPath,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from '@zennotes/shared-domain/cloud-sync'
import {
  CloudSyncCoordinator,
  type CloudSyncRemote,
  type CloudSyncRepository,
  type CloudSyncStateStore
} from '@zennotes/shared-domain/cloud-sync-coordinator'
import type {
  CloudSyncLocalItem,
  CloudSyncState,
  CloudSyncTrackedItem
} from '@zennotes/shared-domain/cloud-sync-engine'

const TEXT_EXTENSIONS = new Set([
  '.base',
  '.css',
  '.csv',
  '.excalidraw',
  '.htm',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])

const MEDIA_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

export class CloudSyncLocalEditConflictError extends Error {
  constructor(readonly relPath: string) {
    super(`Cloud sync stopped because ${relPath} has unsynced local edits`)
    this.name = 'CloudSyncLocalEditConflictError'
  }
}

export class DesktopCloudSyncRepository implements CloudSyncRepository {
  constructor(private readonly root: string) {}

  async scan(): Promise<CloudSyncLocalItem[]> {
    const items: CloudSyncLocalItem[] = []
    await this.walk(this.root, '', items)
    return items.sort((left, right) => left.path.localeCompare(right.path))
  }

  async apply(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined): Promise<void> {
    const affectedPaths = [change.path, change.previous_path, previous?.path].filter(
      (path): path is string => typeof path === 'string'
    )
    if (affectedPaths.some((path) => !shouldSyncVaultPath(path))) return

    if (change.type === 'upsert') {
      if (!change.content) throw new Error(`Upsert change ${change.sequence} did not include content`)
      await this.assertUnchanged(previous?.path ?? change.path, previous)
      await this.write(change.path, decodeContent(change.content))
      return
    }

    const previousPath = previous?.path ?? change.previous_path ?? change.path
    await this.assertUnchanged(previousPath, previous)

    if (change.type === 'delete') {
      await fs.rm(this.resolve(previousPath), { force: true })
      return
    }

    const source = this.resolve(previousPath)
    const destination = this.resolve(change.path)
    if (source === destination) return
    await fs.mkdir(path.dirname(destination), { recursive: true })

    if (await exists(destination)) throw new CloudSyncLocalEditConflictError(change.path)
    await fs.rename(source, destination)
  }

  private async walk(
    absoluteDirectory: string,
    relativeDirectory: string,
    items: CloudSyncLocalItem[]
  ): Promise<void> {
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(absoluteDirectory, entry.name)

      if (entry.isDirectory() && shouldTraverseCloudSyncDirectory(relPath)) {
        await this.walk(absolutePath, relPath, items)
      } else if (entry.isFile() && shouldSyncVaultPath(relPath)) {
        const bytes = await fs.readFile(absolutePath)
        items.push({
          path: normalizeCloudSyncPath(relPath),
          kind: isText(relPath, bytes) ? 'text' : 'binary',
          content: encodeContent(relPath, bytes)
        })
      }
    }
  }

  private resolve(relPath: string): string {
    const normalized = normalizeCloudSyncPath(relPath)
    const root = path.resolve(this.root)
    const absolutePath = path.resolve(root, ...normalized.split('/'))

    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Cloud sync path escapes vault: ${relPath}`)
    }

    return absolutePath
  }

  private async assertUnchanged(
    relPath: string,
    previous: CloudSyncTrackedItem | undefined
  ): Promise<void> {
    const absolutePath = this.resolve(relPath)

    try {
      const bytes = await fs.readFile(absolutePath)
      if (!previous || sha256(bytes) !== previous.sha256) {
        throw new CloudSyncLocalEditConflictError(relPath)
      }
    } catch (error) {
      if (isMissingFileError(error) && !previous) return
      throw error
    }
  }

  private async write(relPath: string, bytes: Buffer): Promise<void> {
    const destination = this.resolve(relPath)
    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const handle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
    )

    try {
      await handle.writeFile(bytes)
      try {
        await handle.sync()
      } catch {
        // Some network filesystems cannot fsync. Atomic rename still prevents partial reads.
      }
    } finally {
      await handle.close()
    }

    try {
      await fs.rename(temporaryPath, destination)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true })
      throw error
    }
  }
}

export class DesktopCloudSyncStateStore implements CloudSyncStateStore {
  constructor(private readonly directory: string) {}

  async load(vaultId: string): Promise<CloudSyncState | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath(vaultId), 'utf8')) as unknown
      return isCloudSyncState(parsed, vaultId) ? parsed : null
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) return null
      throw error
    }
  }

  async save(state: CloudSyncState): Promise<void> {
    const target = this.statePath(state.vault_id)
    const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' })

    try {
      await fs.rename(temporaryPath, target)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true })
      throw error
    }
  }

  private statePath(vaultId: string): string {
    return path.join(this.directory, `${sha256(Buffer.from(vaultId))}.json`)
  }
}

export function createDesktopCloudSyncCoordinator(options: {
  root: string
  stateDirectory: string
  vaultId: string
  remote: CloudSyncRemote
}): CloudSyncCoordinator {
  return new CloudSyncCoordinator(
    options.vaultId,
    options.remote,
    new DesktopCloudSyncRepository(options.root),
    new DesktopCloudSyncStateStore(options.stateDirectory),
    { itemId: randomUUID, operationId: randomUUID }
  )
}

function encodeContent(relPath: string, bytes: Buffer): CloudSyncContent {
  const text = isText(relPath, bytes)
  return {
    encoding: text ? 'utf8' : 'base64',
    data: text ? bytes.toString('utf8') : bytes.toString('base64'),
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
    media_type: mediaType(relPath, text)
  }
}

function decodeContent(content: CloudSyncContent): Buffer {
  if (content.encoding === 'utf8') return Buffer.from(content.data, 'utf8')
  if (content.encoding === 'base64') return Buffer.from(content.data, 'base64')
  throw new Error('Encrypted cloud sync content must be decrypted before filesystem apply')
}

function isText(relPath: string, bytes: Buffer): boolean {
  if (!TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function mediaType(relPath: string, text: boolean): string {
  return MEDIA_TYPES[path.extname(relPath).toLowerCase()] ??
    (text ? 'text/plain' : 'application/octet-stream')
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

function isCloudSyncState(value: unknown, vaultId: string): value is CloudSyncState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<CloudSyncState>
  return (
    state.version === 1 &&
    state.vault_id === vaultId &&
    typeof state.cursor === 'number' &&
    state.cursor >= 0 &&
    Boolean(state.items) &&
    typeof state.items === 'object' &&
    !Array.isArray(state.items)
  )
}
