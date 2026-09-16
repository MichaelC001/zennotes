import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { withGoEnv } from './go-env.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const serverRoot = process.env.ZENNOTES_SERVER_DIR
  ? resolve(process.env.ZENNOTES_SERVER_DIR)
  : resolve(repoRoot, 'apps/server')
const binary = process.env.ZENNOTES_SERVER_BINARY
if (binary && process.env.ZENNOTES_SERVER_DIR) throw new Error('Choose ZENNOTES_SERVER_BINARY or ZENNOTES_SERVER_DIR')

const child = spawn(binary ? resolve(binary) : 'go', binary ? [] : ['run', './cmd/zennotes-server'], {
  cwd: serverRoot,
  env: withGoEnv({
    ZENNOTES_DEV: '1'
  }),
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
