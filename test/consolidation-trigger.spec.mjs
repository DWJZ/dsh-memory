/**
 * Trigger suite: the idle debounce, what cancels it, and the single-flight
 * guarantee that keeps two synchronous runs from overlapping.
 *
 * The clock is fake, so these assertions are about the lifecycle rather than
 * about how long a real timer takes to fire.
 *
 * Usage: `node test/consolidation-trigger.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createTrigger, DEFAULT_DEBOUNCE_MS } = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/trigger.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/**
 * A timer registry a test can fire by hand.
 * @returns the registry and its seams.
 */
function fakeTimers() {
  let nextHandle = 1
  const live = new Map()
  return {
    live,
    schedule(run, ms) {
      const handle = nextHandle
      nextHandle += 1
      live.set(handle, { run, ms })
      return handle
    },
    cancelSchedule(handle) {
      live.delete(handle)
    },
    /** Fire every pending timer, as a real clock eventually would. */
    async fireAll() {
      const due = [...live.entries()]
      live.clear()
      for (const [, timer] of due) await timer.run()
    },
    /** The delay the newest pending timer was given. */
    newestDelay() {
      return [...live.values()].at(-1)?.ms
    },
  }
}

/** One agent stub. */
const agent = (id, status = 'idle') => ({ session: { id }, status })

console.log('idle_starts_debounce')
{
  const timers = fakeTimers()
  const runs = []
  const trigger = createTrigger({
    task: one => runs.push(one.session.id),
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  const one = agent('session_a')
  trigger.statusChanged(one, 'idle')
  check('going idle schedules one timer', timers.live.size === 1)
  check('the debounce uses the configured delay', timers.newestDelay() === DEFAULT_DEBOUNCE_MS)
  check('the trigger reports the pending debounce', trigger.isPending(one) === true)
  check('no work happens before the timer fires', runs.length === 0)
  await timers.fireAll()
  check('the debounce runs the task once', runs.join(',') === 'session_a')
  check('the debounce is no longer pending', trigger.isPending(one) === false)
  check('the run is finished', trigger.isRunning(one) === false)
}

console.log('an idle debounce is not scheduled twice')
{
  const timers = fakeTimers()
  let runs = 0
  const trigger = createTrigger({
    task: () => { runs += 1 },
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  const one = agent('session_a')
  trigger.statusChanged(one, 'idle')
  trigger.statusChanged(one, 'idle')
  check('a repeated idle keeps one timer', timers.live.size === 1)
  await timers.fireAll()
  check('the task ran once', runs === 1)
}

console.log('running_cancels_debounce')
{
  const timers = fakeTimers()
  let runs = 0
  const trigger = createTrigger({
    task: () => { runs += 1 },
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  const one = agent('session_a')
  trigger.statusChanged(one, 'idle')
  trigger.statusChanged(one, 'running')
  check('the pending timer is cancelled', timers.live.size === 0)
  check('the trigger reports nothing pending', trigger.isPending(one) === false)
  await timers.fireAll()
  check('no work ran', runs === 0)
}

console.log('idle_debounce_runs_consolidation only while still idle')
{
  const timers = fakeTimers()
  let runs = 0
  let idle = true
  const one = agent('session_a')
  const trigger = createTrigger({
    task: () => { runs += 1 },
    isIdle: () => idle,
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  trigger.statusChanged(one, 'idle')
  idle = false
  await timers.fireAll()
  check('a timer that fires after new work does nothing', runs === 0)
  idle = true
  trigger.statusChanged(one, 'idle')
  await timers.fireAll()
  check('the next idle period does run it', runs === 1)
}

console.log('a second turn is covered by one debounce')
{
  const timers = fakeTimers()
  let runs = 0
  const trigger = createTrigger({
    task: () => { runs += 1 },
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  const one = agent('session_a')
  trigger.statusChanged(one, 'idle')
  trigger.statusChanged(one, 'running')
  trigger.statusChanged(one, 'idle')
  check('the restarted debounce leaves one timer', timers.live.size === 1)
  await timers.fireAll()
  check('both turns are covered by a single run', runs === 1)
}

console.log('one run at a time')
{
  const timers = fakeTimers()
  let runs = 0
  let release
  const gate = new Promise(resolveGate => { release = resolveGate })
  const trigger = createTrigger({
    task: async () => { runs += 1; await gate },
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  const one = agent('session_a')
  trigger.statusChanged(one, 'idle')
  const inFlight = timers.fireAll()
  check('the run is marked in flight', trigger.isRunning(one) === true)
  trigger.statusChanged(one, 'idle')
  check('an idle during a run schedules nothing', timers.live.size === 0)
  release()
  await inFlight
  check('the run ended', trigger.isRunning(one) === false)
  check('exactly one run happened', runs === 1)
  trigger.statusChanged(one, 'idle')
  check('the next idle schedules again', timers.live.size === 1)
}

console.log('a failing task does not escape or wedge the trigger')
{
  const timers = fakeTimers()
  const warnings = []
  let attempts = 0
  const trigger = createTrigger({
    task: () => { attempts += 1; throw new Error('model exploded') },
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
    logger: { warn: message => warnings.push(message) },
  })
  const one = agent('session_a')
  trigger.statusChanged(one, 'idle')
  await timers.fireAll()
  check('the failure is reported', warnings.length === 1 && warnings[0].includes('model exploded'))
  check('the agent is not left marked as running', trigger.isRunning(one) === false)
  trigger.statusChanged(one, 'idle')
  await timers.fireAll()
  check('a later idle retries', attempts === 2)
}

console.log('agents are tracked separately')
{
  const timers = fakeTimers()
  const runs = []
  const trigger = createTrigger({
    task: one => runs.push(one.session.id),
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  trigger.statusChanged(agent('session_a'), 'idle')
  trigger.statusChanged(agent('session_b'), 'idle')
  check('each agent gets its own timer', timers.live.size === 2)
  await timers.fireAll()
  check('both ran', runs.sort().join(',') === 'session_a,session_b')
}

console.log('an agent without a Session is ignored')
{
  const timers = fakeTimers()
  const trigger = createTrigger({
    task: () => { throw new Error('must not run') },
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  trigger.statusChanged({ status: 'idle' }, 'idle')
  check('no timer is scheduled', timers.live.size === 0)
  check('nothing is reported pending', trigger.isPending({ status: 'idle' }) === false)
}

console.log('dispose clears pending timers')
{
  const timers = fakeTimers()
  let runs = 0
  const trigger = createTrigger({
    task: () => { runs += 1 },
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
  })
  trigger.statusChanged(agent('session_a'), 'idle')
  trigger.statusChanged(agent('session_b'), 'idle')
  trigger.dispose()
  check('every pending timer is cancelled', timers.live.size === 0)
  await timers.fireAll()
  check('no work runs after unloading', runs === 0)
}

console.log('the timer is not a maintenance task')
{
  // The debounce is scheduled through the injected scheduler and the task is
  // only reached after it fires, so nothing sleeps inside the agent's own
  // maintenance phase.
  const timers = fakeTimers()
  const order = []
  const trigger = createTrigger({
    task: () => { order.push('task') },
    schedule: (run, ms) => { order.push(`schedule:${String(ms)}`); return timers.schedule(run, ms) },
    cancelSchedule: timers.cancelSchedule,
  })
  trigger.statusChanged(agent('session_a'), 'idle')
  check('scheduling happened without the task running', order.join(',') === `schedule:${String(DEFAULT_DEBOUNCE_MS)}`)
  await timers.fireAll()
  check('the task only runs when the timer fires', order.join(',') === `schedule:${String(DEFAULT_DEBOUNCE_MS)},task`)
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
