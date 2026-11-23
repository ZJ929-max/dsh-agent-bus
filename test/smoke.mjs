// Behavioural smoke test for the agent-bus tools.
//
// The plugin needs a Cordis context to activate, so this harness builds a fake
// one: it captures the registered tool definitions and stubs the agent registry.
// No network, no real sessions, no profile changes — the bus state directory is
// redirected to a temp folder per run.
//
// usage: node test/smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bus-test-'))
process.env.DSH_PROFILE_DIR = tmp

const { apply } = await import(pathToFileURL(path.join(root, 'index.js')).href)

let passed = 0
const check = async (name, fn) => {
  reset()
  await fn()
  passed += 1
  console.log(`ok ${name}`)
}

/** One fake live agent with the small surface the plugin touches. */
function fakeAgent(id, title, status = 'idle') {
  return {
    id,
    status,
    createdAt: Date.now(),
    calls: { inject: [], followup: [] },
    inject(message) { this.calls.inject.push(message) },
    followup(message) { this.calls.followup.push(message) },
    session: {
      ownEvents: () => (title ? [{ type: 'session/title', data: { title } }] : []),
      seq: 0,
      eventAt: () => undefined,
    },
  }
}

/** Capture the tools one apply() registers. */
function activate(config) {
  const tools = new Map()
  const ctx = {
    on: () => {},
    tools: { register: (definition) => {
      tools.set(definition.name, definition)
      return () => {}
    } },
    agents: {
      list: () => registry,
      get: (id) => registry.find(agent => String(agent.id) === String(id)),
      turnBoundaryOf: () => ({ lastTurn: 0, openTurnStartSeq: null }),
    },
    get: () => undefined,
  }
  apply(ctx, config)
  return tools
}

const a = fakeAgent('session-aaaa1111', 'Sender')
const b = fakeAgent('session-bbbb2222', 'Receiver')
const c = fakeAgent('session-cccc3333', 'Third')
const registry = [a, b, c]
const busDir = path.join(tmp, 'agent-bus')
const reset = () => {
  for (const agent of registry) {
    agent.calls.inject.length = 0
    agent.calls.followup.length = 0
  }
}

await check('default wake delivers with followup and returns a receipt', async () => {
  const tools = activate({})
  const result = await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'hello' }, { agent: a })
  assert.equal(result.ok, true)
  assert.equal(result.paused, false)
  assert.equal(result.mode, 'followup')
  assert.ok(result.messageId)
  assert.equal(b.calls.followup.length, 1)
  assert.equal(b.calls.inject.length, 0)
  assert.match(result.summary, /followup/)
})

await check('wake:false injects without starting a turn', async () => {
  const tools = activate({})
  const result = await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'fyi', wake: false }, { agent: a })
  assert.equal(result.mode, 'inject')
  assert.equal(b.calls.followup.length, 0)
  assert.equal(b.calls.inject.length, 1)
  assert.match(result.summary, /no wake/)
})

await check('hitting the hop cap returns paused instead of throwing', async () => {
  fs.mkdirSync(busDir, { recursive: true })
  fs.writeFileSync(
    path.join(busDir, 'pairs.json'),
    JSON.stringify({ [`${a.id}>${b.id}`]: { depth: 3, woken: true, chainStartedAt: Date.now() } }),
    'utf8',
  )
  const tools = activate({ maxAutoHops: 3, chainCooldownMinutes: 10 })
  const result = await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'ping' }, { agent: a })
  assert.equal(result.ok, false)
  assert.equal(result.paused, true)
  assert.equal(result.mode, 'paused')
  assert.ok(result.retryAfterMinutes >= 1)
  assert.match(result.summary, /not an error/)
  assert.equal(b.calls.followup.length, 0)
})

await check('fan-out cap returns paused instead of throwing', async () => {
  fs.rmSync(path.join(busDir, 'wakes.json'), { force: true })
  fs.rmSync(path.join(busDir, 'pairs.json'), { force: true })
  const tools = activate({ maxDeliveriesPerWindow: 1, wakeWindowMinutes: 10 })
  const first = await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'one' }, { agent: a })
  assert.equal(first.ok, true)
  const second = await tools.get('agent_bus_post').execute({ to: 'Third', text: 'two' }, { agent: a })
  assert.equal(second.ok, false)
  assert.equal(second.paused, true)
  assert.match(second.summary, /different sessions/)
})

await check('bad input still rejects (paused is not a blanket excuse)', async () => {
  const tools = activate({})
  await assert.rejects(tools.get('agent_bus_post').execute({ to: 'Nobody', text: 'x' }, { agent: a }), /no live session matches/u)
  return true
})

console.log(`smoke: ${passed} checks passed`)
fs.rmSync(tmp, { recursive: true, force: true })
