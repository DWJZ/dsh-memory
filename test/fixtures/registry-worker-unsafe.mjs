/**
 * Negative control for the concurrent project registration suite: the same
 * check-then-create with no lock.
 *
 * Two of these racing on one directory mint two projects, which is what the
 * registry lock exists to prevent.
 *
 * Usage: `node test/fixtures/registry-worker-unsafe.mjs <registryPath> <root> <holdMs>`.
 */
import { emptyRegistry, readRegistry } from '../../src/registry.js'
import { writeAtomic } from '../../src/jsonstore.js'
import { newProjectId } from '../../src/schema.js'

const [registryPath, root, rawHold] = process.argv.slice(2)

const registry = readRegistry(registryPath)
// The pause is the whole point: the second writer reads the same registry.
await new Promise(resolve => { setTimeout(resolve, Number(rawHold)) })
const at = new Date().toISOString()
const project_id = newProjectId()
writeAtomic(registryPath, `${JSON.stringify({
  ...emptyRegistry(),
  revision: registry.revision + 1,
  projects: [...registry.projects, {
    project_id,
    canonical_root: root,
    aliases: [],
    workspace_ids: [],
    created_at: at,
    updated_at: at,
  }],
}, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ project_id, created: true })}\n`)
