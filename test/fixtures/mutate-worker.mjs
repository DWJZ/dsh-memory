/**
 * One concurrent writer for the store suite.
 *
 * A real second process is the point: an in-process simulation cannot show that
 * two harness processes sharing `$DSH_HOME` avoid a lost update.
 *
 * Usage: `node test/fixtures/mutate-worker.mjs <storePath> <lockPath> <prefix> <count> <delayMs>`.
 */
import { withStore } from '../../src/jsonstore.js'
import { memoryRecord } from './records.mjs'

const [storePath, lockPath, prefix, rawCount, rawDelay] = process.argv.slice(2)
const count = Number(rawCount)
const delayMs = Number(rawDelay)

for (let index = 0; index < count; index += 1) {
  await withStore({ storePath, lockPath, lockTimeoutMs: 20000, staleLockMs: 60000 }, (store) => {
    // A pause between read and write widens the window a lost update needs.
    return { changed: true, records: [...store.records, memoryRecord({ content: `${prefix}-${index}` })] }
  })
  if (delayMs > 0) await new Promise(resolve => { setTimeout(resolve, delayMs) })
}
