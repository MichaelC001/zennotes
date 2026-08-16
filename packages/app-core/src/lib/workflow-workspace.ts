/** Whether this renderer is paired with a host that can keep workflow files
 * and run journals in the vault. Remote desktop workspaces remain read-only
 * until their Electron bridge delegates these calls to the remote server. */
export function canManageWorkflows(
  runtime: 'desktop' | 'web',
  workspaceMode: 'local' | 'remote',
  capabilities: { supportsWorkflows?: boolean }
): boolean {
  if (workspaceMode === 'remote') return false
  return runtime === 'desktop' || capabilities.supportsWorkflows === true
}
