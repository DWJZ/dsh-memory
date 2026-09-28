/**
 * One concurrent tombstone writer.
 *
 * The log is shared by every scope, so an append takes a lock rather than
 * assuming one line is atomic on every filesystem. Real processes are the only
 * way to show the lines stay well-formed.
 *
 * Usage: `node test/fixtures/tombstone-worker.mjs <tombstonePath> <lockPath> <prefix> <count>`.
 */
import { appendTombstone } from '../../src/actions.js'

const [path, lockPath, prefix, rawCount] = process.argv.slice(2)
for (let index = 0; index < Number(rawCount); index += 1) {
  await appendTombstone({ tombstones: { path, lockPath }, lockTimeoutMs: 20000, staleLockMs: 60000 }, {
    op: 'forget',
    id: `${prefix}-${index}`,
    scope: 'user',
    project_id: null,
    deleted_at: new Date().toISOString(),
  })
}
