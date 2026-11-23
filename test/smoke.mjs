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
  const agent = {
    id,
    status,
    createdAt: Date.now(),
    calls: { inject: [], followup: [], logReads: 0 },
    inject(message) { this.calls.inject.push(message) },
    followup(message) { this.calls.followup.push(message) },
    session: {
      ownEvents: () => {
        agent.calls.logReads += 1
        return title ? [{ type: 'session/title', data: { title } }] : []
      },
      seq: 0,
      eventAt: () => undefined,
    },
  }
  return agent
}

/** Capture the tools one apply() registers, plus the event handlers it wires. */
function activate(config) {
  const tools = new Map()
  const handlers = new Map()
  const ctx = {
    on: (event, handler) => {
      const list = handlers.get(event) || []
      list.push(handler)
      handlers.set(event, list)
    },
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
  tools.handlers = handlers
  return tools
}

const a = fakeAgent('session-aaaa1111', 'Sender')
const b = fakeAgent('session-bbbb2222', 'Receiver')
const c = fakeAgent('session-cccc3333', 'Third')
const registry = [a, b, c]
const busDir = path.join(tmp, 'agent-bus')
const reset = () => {
  fs.rmSync(busDir, { recursive: true, force: true })
  for (const agent of registry) {
    agent.calls.inject.length = 0
    agent.calls.followup.length = 0
    agent.calls.logReads = 0
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

await check('the wrapper stays a minority of a delivered message (A2)', async () => {
  const tools = activate({})
  const body = 'x'.repeat(600)
  await tools.get('agent_bus_post').execute({ to: 'Receiver', text: body }, { agent: a })
  const payload = b.calls.followup[0].content[0].text
  const wrapper = payload.length - body.length
  const share = wrapper / payload.length
  assert.ok(share < 0.32, `wrapper is ${wrapper}/${payload.length} = ${(share * 100).toFixed(0)}% of the message`)
  console.log(`   wrapper: ${wrapper} chars around a 600-char body = ${(share * 100).toFixed(0)}%`)
  assert.match(payload, /UNTRUSTED/)
  assert.match(payload, /end agent-bus/u)
  assert.match(payload, /agent_bus_inbox/u)
})

await check('unread count, re-read by number, and explicit ack (A3)', async () => {
  const tools = activate({})
  const inbox = tools.get('agent_bus_inbox')
  const first = await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'one' }, { agent: a })
  const second = await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'two' }, { agent: a })
  assert.ok(second.n > first.n, 'message numbers must increase')

  const before = await inbox.execute({}, { agent: b })
  assert.equal(before.unread, 2)
  assert.equal(before.cursor, 0)

  // Re-reading one message must not consume it.
  const single = await inbox.execute({ message: String(first.n) }, { agent: b })
  assert.match(single.summary, /one/u)
  assert.equal(single.cursor, 0)

  const acked = await inbox.execute({ ack: true }, { agent: b })
  assert.equal(acked.unread, 0)
  assert.equal(acked.cursor, second.n)

  await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'three' }, { agent: a })
  const after = await inbox.execute({ unreadOnly: true }, { agent: b })
  assert.equal(after.unread, 1)
  assert.match(after.summary, /three/u)
  assert.doesNotMatch(after.summary, /one\b[\s\S]*two/u)
})

/** Restore a process.env key to the value it had before a test touched it. */
function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

await check('the state directory follows the profile, never a silent shared fallback (A9)', async () => {
  const saved = {
    dir: process.env.DSH_PROFILE_DIR,
    home: process.env.DSH_HOME,
    profile: process.env.DSH_PROFILE,
  }
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bus-profile-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bus-home-'))
  try {
    // Tier 1: the launcher's per-profile directory wins.
    process.env.DSH_PROFILE_DIR = other
    let tools = activate({})
    await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'x' }, { agent: a })
    assert.ok(fs.existsSync(path.join(other, 'agent-bus', `inbox-${b.id}.json`)), 'tier 1 directory was not used')
    assert.ok(!fs.existsSync(path.join(tmp, 'agent-bus', 'seq.json')), 'wrote into the test profile while another was configured')

    // Tier 2: name-only launchers still get a profile-scoped directory.
    delete process.env.DSH_PROFILE_DIR
    process.env.DSH_HOME = home
    process.env.DSH_PROFILE = 'desktop'
    tools = activate({})
    await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'y' }, { agent: a })
    assert.ok(fs.existsSync(path.join(home, 'profiles', 'desktop', 'agent-bus', 'seq.json')), 'tier 2 directory was not used')

    // Tier 3: no env at all, but the plugin row names the profile.
    delete process.env.DSH_PROFILE
    tools = activate({ profile: 'work' })
    await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'z' }, { agent: a })
    assert.ok(fs.existsSync(path.join(home, 'profiles', 'work', 'agent-bus', 'seq.json')), 'config.profile tier was not used')

    // Tier 5: no profile identity at all — shared, but reported, never hidden.
    tools = activate({})
    const status = await tools.get('agent_bus_status').execute({}, { agent: a })
    assert.match(status.summary, /没有按 profile 隔离/u)
  } finally {
    restoreEnv('DSH_PROFILE_DIR', saved.dir)
    restoreEnv('DSH_HOME', saved.home)
    restoreEnv('DSH_PROFILE', saved.profile)
    fs.rmSync(other, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})

await check('a human prompt clears both directions and the fan-out window (A10)', async () => {
  fs.mkdirSync(busDir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(busDir, 'pairs.json'), JSON.stringify({
    [`${a.id}>${b.id}`]: { depth: 2, woken: true, chainStartedAt: now },
    [`${b.id}>${a.id}`]: { depth: 2, woken: true, chainStartedAt: now },
    [`${b.id}>${c.id}`]: { depth: 1, woken: true, chainStartedAt: now },
  }), 'utf8')
  fs.writeFileSync(path.join(busDir, 'wakes.json'), JSON.stringify({ [a.id]: [{ to: b.id, at: now }] }), 'utf8')

  const tools = activate({})
  const [human] = tools.handlers.get('session/event')
  human({ id: a.id }, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } })

  const pairs = JSON.parse(fs.readFileSync(path.join(busDir, 'pairs.json'), 'utf8'))
  assert.deepEqual(Object.keys(pairs), [`${b.id}>${c.id}`], 'chains touching the human-driven session must reset in both directions')
  const wakes = JSON.parse(fs.readFileSync(path.join(busDir, 'wakes.json'), 'utf8'))
  assert.equal(wakes[a.id], undefined, 'the fan-out window must restart when the human is present')
})

await check('expired delivered mail is pruned, undelivered mail is kept (A15)', async () => {
  fs.mkdirSync(busDir, { recursive: true })
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  fs.writeFileSync(path.join(busDir, `inbox-${b.id}.json`), JSON.stringify([
    { id: 'old-delivered', n: 1, fromId: c.id, toId: b.id, text: 'stale', postedAt: old, delivered: true },
    { id: 'old-queued', n: 2, fromId: c.id, toId: b.id, text: 'keep me', postedAt: old, delivered: false },
  ]), 'utf8')

  const tools = activate({ retentionDays: 1 })
  await tools.get('agent_bus_post').execute({ to: 'Receiver', text: 'fresh', wake: false }, { agent: a })

  const kept = JSON.parse(fs.readFileSync(path.join(busDir, `inbox-${b.id}.json`), 'utf8'))
  const texts = kept.map(record => record.text)
  assert.ok(!texts.includes('stale'), 'retention must drop a delivered message older than the window')
  assert.ok(texts.includes('keep me'), 'undelivered mail must never be dropped by retention')
  assert.ok(texts.includes('fresh'))
})

await check('derived names are cached instead of re-reading a log per call (A11)', async () => {
  const tools = activate({})
  const status = tools.get('agent_bus_status')
  const readsBefore = registry.reduce((sum, agent) => sum + agent.calls.logReads, 0)
  await status.execute({}, { agent: a })
  const afterFirst = registry.reduce((sum, agent) => sum + agent.calls.logReads, 0)
  await status.execute({}, { agent: a })
  const afterSecond = registry.reduce((sum, agent) => sum + agent.calls.logReads, 0)
  assert.ok(afterFirst - readsBefore <= 3, `first status read ${afterFirst - readsBefore} logs (self plus two peers expected)`)
  assert.equal(afterSecond, afterFirst, 'a second status within the cache window must not read any log again')
  // A title change invalidates the cache, so a renamed session is not stale for a minute.
  const [event] = tools.handlers.get('session/event')
  event({ id: b.id }, { type: 'session/title', data: { title: 'Renamed' } })
  await status.execute({}, { agent: a })
  const afterRetitle = registry.reduce((sum, agent) => sum + agent.calls.logReads, 0)
  assert.ok(afterRetitle > afterSecond, 'a session/title event must drop that session\'s cached name')
})

console.log(`smoke: ${passed} checks passed`)
fs.rmSync(tmp, { recursive: true, force: true })
