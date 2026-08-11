import type {
  CloudBackupRestoreRequest,
  CloudBackupRestoreResponse,
  CloudBackupSnapshotCollection,
  CloudBackupSnapshotResponse,
  CloudPublishedNoteCollection,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccountResponse,
  CloudSyncChangeResponse,
  CloudSyncManifestResponse,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncVaultCollection,
  CloudSyncVaultResponse
} from '@zennotes/bridge-contract/cloud-sync'

export interface CloudSyncHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
}

export interface CloudSyncHttpTransport {
  request<Response>(request: CloudSyncHttpRequest): Promise<Response>
}

/** Typed API surface shared by Electron and both Capacitor shells. */
export class CloudSyncApiClient {
  constructor(private readonly http: CloudSyncHttpTransport) {}

  async listVaults(): Promise<CloudSyncVaultCollection> {
    return this.http.request({ method: 'GET', path: '/api/v1/vaults' })
  }

  async account(): Promise<CloudServiceAccountResponse> {
    return this.http.request({ method: 'GET', path: '/api/v1/account' })
  }

  async createVault(name: string): Promise<CloudSyncVaultResponse> {
    return this.http.request({ method: 'POST', path: '/api/v1/vaults', body: { name } })
  }

  async listPublishedNotes(): Promise<CloudPublishedNoteCollection> {
    return this.http.request({ method: 'GET', path: '/api/v1/shares' })
  }

  async publishNote(input: CloudPublishNoteInput): Promise<CloudPublishedNoteResult> {
    return this.http.request({
      method: 'POST',
      path: '/api/v1/shares',
      body: publishedNoteBody(input)
    })
  }

  async updatePublishedNote(
    shareId: number,
    input: CloudPublishNoteInput
  ): Promise<CloudPublishedNoteResult> {
    return this.http.request({
      method: 'PUT',
      path: `/api/v1/shares/${encodeURIComponent(String(shareId))}`,
      body: publishedNoteBody(input)
    })
  }

  async unpublishNote(shareId: number): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: `/api/v1/shares/${encodeURIComponent(String(shareId))}`
    })
  }

  async manifest(
    vaultId: string,
    options: { includeContent?: boolean; page?: number; perPage?: number } = {}
  ): Promise<CloudSyncManifestResponse> {
    const query = encodeQuery({
      include_content: options.includeContent,
      page: options.page,
      per_page: options.perPage
    })
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/manifest${query}`
    })
  }

  async changes(
    vaultId: string,
    after: number,
    limit = 100
  ): Promise<CloudSyncChangeResponse> {
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/changes${encodeQuery({ after, limit })}`
    })
  }

  async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    return this.http.request({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/mutations`,
      body
    })
  }

  async listBackups(vaultId: string): Promise<CloudBackupSnapshotCollection> {
    return this.http.request({
      method: 'GET',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups`
    })
  }

  async createBackup(vaultId: string, label?: string): Promise<CloudBackupSnapshotResponse> {
    return this.http.request({
      method: 'POST',
      path: `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups`,
      body: label === undefined ? {} : { label }
    })
  }

  async deleteBackup(vaultId: string, backupId: string): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: this.backupPath(vaultId, backupId)
    })
  }

  async createBackupRestore(
    vaultId: string,
    backupId: string,
    body: CloudBackupRestoreRequest
  ): Promise<CloudBackupRestoreResponse> {
    return this.http.request({
      method: 'POST',
      path: `${this.backupPath(vaultId, backupId)}/restores`,
      body
    })
  }

  async backupRestore(
    vaultId: string,
    backupId: string,
    restoreId: string
  ): Promise<CloudBackupRestoreResponse> {
    return this.http.request({
      method: 'GET',
      path: `${this.backupPath(vaultId, backupId)}/restores/${encodeURIComponent(restoreId)}`
    })
  }

  backupDownloadPath(vaultId: string, backupId: string): string {
    return `${this.backupPath(vaultId, backupId)}/download`
  }

  private backupPath(vaultId: string, backupId: string): string {
    return `/api/v1/vaults/${encodeURIComponent(vaultId)}/backups/${encodeURIComponent(backupId)}`
  }
}

function publishedNoteBody(input: CloudPublishNoteInput): { payload: string } | FormData {
  const { assets = [], ...note } = input
  const payload = JSON.stringify({
    ...note,
    tikz_svgs: [],
    asset_refs: assets.map((asset) => asset.ref)
  })
  if (assets.length === 0) {
    return { payload }
  }

  const form = new FormData()
  form.append('payload', payload)
  for (const asset of assets) {
    const bytes = Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0))
    form.append('assets[]', new Blob([bytes], { type: asset.mime }), asset.name)
  }
  return form
}

function encodeQuery(values: Record<string, boolean | number | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, boolean | number] =>
    ['boolean', 'number'].includes(typeof entry[1])
  )
  if (entries.length === 0) return ''
  return `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')}`
}
