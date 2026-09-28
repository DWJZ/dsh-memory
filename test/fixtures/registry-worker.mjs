/**
 * One concurrent project registration, using the real locked path.
 *
 * Usage: `node test/fixtures/registry-worker.mjs <registryPath> <lockPath> <root>`.
 */
import { resolveOrRegisterProject } from '../../src/registry.js'

const [registryPath, lockPath, root] = process.argv.slice(2)
const { project, created } = await resolveOrRegisterProject(
  { registryPath, lockPath, lockTimeoutMs: 20000, staleLockMs: 60000 },
  root,
)
process.stdout.write(`${JSON.stringify({ project_id: project.project_id, created })}\n`)
