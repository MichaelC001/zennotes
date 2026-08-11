import type {
  CloudSyncChange,
  CloudSyncContent
} from '@zennotes/bridge-contract/cloud-sync'
import {
  normalizeCloudSyncPath,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from './cloud-sync'
import type { CloudSyncRepository } from './cloud-sync-coordinator'
import type {
  CloudSyncLocalItem,
  CloudSyncTrackedItem
} from './cloud-sync-engine'

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

export interface CloudSyncFileEntry {
  name: string
  type: 'file' | 'directory'
}

/** The minimal vault-relative filesystem surface implemented by both mobile shells. */
export interface PortableCloudSyncFileSystem {
  readdir(directory: string): Promise<CloudSyncFileEntry[]>
  stat(path: string): Promise<'file' | 'directory' | null>
  readBase64(path: string): Promise<string>
  writeText(path: string, value: string): Promise<void>
  writeBase64(path: string, value: string): Promise<void>
  deleteFile(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export class CloudSyncLocalEditConflictError extends Error {
  constructor(readonly relPath: string) {
    super(`Cloud sync stopped because ${relPath} has unsynced local edits`)
    this.name = 'CloudSyncLocalEditConflictError'
  }
}

/** Web-API implementation shared by iOS and Android Capacitor filesystems. */
export class PortableCloudSyncRepository implements CloudSyncRepository {
  constructor(private readonly fs: PortableCloudSyncFileSystem) {}

  async scan(): Promise<CloudSyncLocalItem[]> {
    const items: CloudSyncLocalItem[] = []
    await this.walk('', items)
    return items.sort((left, right) => left.path.localeCompare(right.path))
  }

  async apply(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined): Promise<void> {
    const affectedPaths = [change.path, change.previous_path, previous?.path].filter(
      (path): path is string => typeof path === 'string'
    )
    if (affectedPaths.some((path) => !shouldSyncVaultPath(path))) return

    if (change.type === 'delete') {
      const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
      const current = await this.readItemOrNull(previousPath)
      if (!current) return
      this.assertTracked(previousPath, current, previous)
      await this.fs.deleteFile(previousPath)
      return
    }

    if (change.type === 'move') {
      const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
      const nextPath = this.path(change.path)
      if (previousPath === nextPath) return

      const [source, destination] = await Promise.all([
        this.readItemOrNull(previousPath),
        this.readItemOrNull(nextPath)
      ])
      if (!source) {
        if (destination && previous && destination.content.sha256 === previous.sha256) return
        throw new CloudSyncLocalEditConflictError(previousPath)
      }
      this.assertTracked(previousPath, source, previous)
      if (destination) throw new CloudSyncLocalEditConflictError(nextPath)
      await this.fs.rename(previousPath, nextPath)
      return
    }

    if (!change.content) throw new Error(`Upsert change ${change.sequence} did not include content`)

    const previousPath = this.path(previous?.path ?? change.previous_path ?? change.path)
    const nextPath = this.path(change.path)
    const [source, destination] =
      previousPath === nextPath
        ? [await this.readItemOrNull(previousPath), null]
        : await Promise.all([
            this.readItemOrNull(previousPath),
            this.readItemOrNull(nextPath)
          ])
    const currentAtTarget = previousPath === nextPath ? source : destination

    if (currentAtTarget?.content.sha256 === change.content.sha256) {
      if (previousPath !== nextPath && source) {
        this.assertTracked(previousPath, source, previous)
        await this.fs.deleteFile(previousPath)
      }
      return
    }

    this.assertTracked(previousPath, source, previous)
    if (destination) throw new CloudSyncLocalEditConflictError(nextPath)
    await this.write(nextPath, change.content)
    if (previousPath !== nextPath && source) await this.fs.deleteFile(previousPath)
  }

  private async walk(directory: string, items: CloudSyncLocalItem[]): Promise<void> {
    const entries = await this.fs.readdir(directory)
    for (const entry of entries) {
      const relPath = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (shouldTraverseCloudSyncDirectory(relPath)) await this.walk(relPath, items)
      } else if (shouldSyncVaultPath(relPath)) {
        items.push(await this.readItem(this.path(relPath)))
      }
    }
  }

  private async readItemOrNull(path: string): Promise<CloudSyncLocalItem | null> {
    const type = await this.fs.stat(path)
    if (type === null) return null
    if (type !== 'file') throw new CloudSyncLocalEditConflictError(path)
    return this.readItem(path)
  }

  private async readItem(path: string): Promise<CloudSyncLocalItem> {
    const bytes = base64ToBytes(await this.fs.readBase64(path))
    const text = decodeText(path, bytes)
    return {
      path,
      kind: text === null ? 'binary' : 'text',
      content: {
        encoding: text === null ? 'base64' : 'utf8',
        data: text === null ? bytesToBase64(bytes) : text,
        sha256: await sha256(bytes),
        byte_length: bytes.byteLength,
        media_type: mediaType(path, text !== null)
      }
    }
  }

  private assertTracked(
    path: string,
    current: CloudSyncLocalItem | null,
    previous: CloudSyncTrackedItem | undefined
  ): void {
    if (!previous && !current) return
    if (!previous || !current || current.content.sha256 !== previous.sha256) {
      throw new CloudSyncLocalEditConflictError(path)
    }
  }

  private async write(path: string, content: CloudSyncContent): Promise<void> {
    if (content.encoding === 'utf8') {
      await this.fs.writeText(path, content.data)
      return
    }
    if (content.encoding === 'base64') {
      await this.fs.writeBase64(path, content.data)
      return
    }
    throw new Error('Encrypted cloud sync content must be decrypted before filesystem apply')
  }

  private path(value: string): string {
    return normalizeCloudSyncPath(value)
  }
}

function decodeText(path: string, bytes: Uint8Array): string | null {
  if (!TEXT_EXTENSIONS.has(extension(path))) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function mediaType(path: string, text: boolean): string {
  return MEDIA_TYPES[extension(path)] ?? (text ? 'text/plain' : 'application/octet-stream')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = Uint8Array.from(bytes).buffer
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  const binary = atob(normalized.replace(/\s/g, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
