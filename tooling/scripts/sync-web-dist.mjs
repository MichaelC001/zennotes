import { cp, rm, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const webDist = resolve(repoRoot, 'apps/web/dist')
const serverDist = resolve(repoRoot, 'apps/server/web/dist')

// `apps/server` runs `prepare-web` from BOTH `typecheck` and `test:run`, and
// turbo schedules those two tasks concurrently. A plain `rm` followed by `cp`
// therefore races: the second process deletes the directory while the first is
// still copying into it, and the first dies with ENOENT partway through. It
// surfaces as `turbo run typecheck test:run` failing on a machine where each
// task passes perfectly well on its own, with no connection to the change being
// built, which is the worst kind of red.
//
// Every racer copies byte-identical content, so losing the race is harmless.
// Each one stages into a private directory and swaps it into place with a
// single rename, which is atomic within a filesystem. A racer that finds the
// slot already filled keeps the winner's copy and cleans up after itself.
const stage = `${serverDist}.stage-${process.pid}`
const retired = `${serverDist}.retired-${process.pid}`

await rm(stage, { recursive: true, force: true })
await cp(webDist, stage, { recursive: true, force: true })

try {
  await rename(serverDist, retired)
} catch (err) {
  // Nothing to retire on a first run, or another racer retired it already.
  if (err.code !== 'ENOENT') throw err
}

try {
  await rename(stage, serverDist)
} catch (err) {
  // Another racer landed its copy between our two renames. Its content is
  // identical to ours, so the tree is already correct; drop our staging copy.
  if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err
  await rm(stage, { recursive: true, force: true })
}

await rm(retired, { recursive: true, force: true })
