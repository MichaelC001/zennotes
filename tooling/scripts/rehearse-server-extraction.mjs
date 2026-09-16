import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = process.argv[2] && resolve(process.argv[2])
if (!manifest || process.argv.length !== 3)
  throw new Error('Usage: node tooling/scripts/rehearse-server-extraction.mjs <manifest.json>')
const pin = JSON.parse(await readFile(manifest, 'utf8'))
if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(pin.archive?.file ?? ''))
  throw new Error('Expected a local web archive basename in the manifest')
const output = await mkdtemp(join(tmpdir(), 'zennotes-server-rehearsal-'))
const source = join(output, 'source')
const files = []
const originalModule = 'github.com/ZenNotes/zennotes/apps/server'
const destinationModule = 'github.com/ZenNotes/znserver'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function copySource(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = relative + entry.name
    if (['web/dist', 'bin', 'node_modules', '.git'].includes(path)) continue
    if (entry.isDirectory()) await copySource(join(directory, entry.name), `${path}/`)
    else if (
      entry.isFile() &&
      ((/\.(go|json)$/.test(path) && path !== 'package.json') ||
        ['go.mod', 'go.sum', 'README.md'].includes(path))
    ) {
      const before = await readFile(join(directory, entry.name))
      const after =
        path.endsWith('.go') || path === 'go.mod'
          ? Buffer.from(before.toString('utf8').replaceAll(originalModule, destinationModule))
          : before
      await mkdir(dirname(join(source, path)), { recursive: true })
      await writeFile(join(source, path), after)
      files.push({
        path,
        originalSha256: hash(before),
        extractedSha256: hash(after)
      })
    }
  }
}

await copySource(join(root, 'apps/server'))
await cp(join(root, 'LICENSE'), join(source, 'LICENSE'))
await cp(join(root, 'tooling/server-repository'), source, { recursive: true })
const release = JSON.parse(await readFile(join(root, 'packaging/nix/release-data.json'), 'utf8'))
const serverPackage = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'))
await writeFile(join(source, 'release.json'), JSON.stringify({ version: serverPackage.version, vendorHash: release.vendorHash }, null, 2) + '\n')
await mkdir(join(source, 'web-artifact'))
await cp(manifest, join(source, 'web-artifact', 'manifest.json'))
await cp(join(dirname(manifest), pin.archive.file), join(source, 'web-artifact', pin.archive.file))
await writeFile(
  join(output, 'provenance.json'),
  JSON.stringify(
    {
      kind: 'local-uncommitted-extraction-rehearsal',
      originalModule,
      destinationModule,
      webArtifact: pin.version,
      manifestSha256: hash(await readFile(join(source, 'web-artifact', 'manifest.json'))),
      archiveSha256: hash(await readFile(join(source, 'web-artifact', pin.archive.file))),
      files: files.sort((a, b) => a.path.localeCompare(b.path))
    },
    null,
    2
  ) + '\n'
)

function go(args) {
  const result = spawnSync('go', args, {
    cwd: source,
    stdio: 'inherit',
    env: { ...process.env, GOWORK: 'off' }
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`go ${args.join(' ')} failed; rehearsal retained at ${output}`)
}

// All commands below run from the copied source with no frontend source or npm manifest.
go(['vet', './...'])
go(['test', './...'])
go(['build', '-trimpath', '-o', join(output, 'server-api'), './cmd/zennotes-server'])
go([
  'run',
  './cmd/prepare-web',
  '-manifest',
  'web-artifact/manifest.json',
  '-output',
  'web/dist',
  ...(pin.source.dirty ? ['-allow-dirty'] : [])
])
go(['test', '-tags=embed_web', './web'])
const binary = join(
  output,
  process.platform === 'win32' ? 'zennotes-server.exe' : 'zennotes-server'
)
go(['build', '-tags=embed_web', '-trimpath', '-o', binary, './cmd/zennotes-server'])
process.stdout.write(
  JSON.stringify({ output, source, binary, webArtifact: pin.version }, null, 2) + '\n'
)
