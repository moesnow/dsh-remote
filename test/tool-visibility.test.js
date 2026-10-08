// The rw_* tools must be offered ONLY to a session whose workspace is a
// dsh-remote mirror.
//
// The bug this pins: every rw_* schema was registered globally and therefore
// appeared in the model's tool list for EVERY session, including a plain local
// one. For the session-bound tools that is not a missing feature but a
// guaranteed failure — requireBinding()/requireMachine() refuse a caller whose
// cwd resolves to no mirror, because there is no remote root to resolve a path
// against — so the model reached for rw_read_file to "look at a file" and burned
// a turn on an error no correct usage could avoid. For the rest (rw_info,
// rw_connect, rw_machines, rw_pick_workspace, rw_forward, rw_disconnect) there
// is simply no remote host this session is bound to, so they describe nothing
// and act on nothing. Either way the listing was a false statement.
//
// The fence is `tools.restrict({ deny })` on the agent's own scoped context,
// which is the only mechanism the harness offers (dsh-tools `view(scope)` drops
// every inherited tool a scope in the agent's chain does not admit).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { fenceAgent, fenceLocalSessions } from '../lib/tool-visibility.js'

// ── helpers ────────────────────────────────────────────────────────────────

const isMirror = (agent) => !!(agent && agent.session && agent.session.header.cwd || '').includes('dsh-remote')
const DENY = ['rw_info', 'rw_connect', 'rw_machines', 'rw_pick_workspace', 'rw_list_dir', 'rw_exec']

/** An agent whose session workspace is `cwd`, recording restrict()/dispose(). */
const makeAgent = (cwd) => {
  const calls = []
  const lifted = []
  const toolsService = {
    restrict(filter) {
      calls.push(filter)
      // dsh-tools returns the exact disposer that lifts the restriction.
      return () => lifted.push(filter)
    },
  }
  const agent = {
    session: { header: { cwd } },
    ctx: { get: (name) => (name === 'tools' ? toolsService : undefined) },
  }
  return { calls, lifted, agent, get liftCount() { return lifted.length } }
}

/** A plugin-ish ctx: captures listeners, live agents, and effect cleanups. */
const makeCtx = ({ liveAgents = [], withEffect = false } = {}) => {
  const listeners = new Map()
  const cleanups = []
  const ctx = {
    listeners,
    warnings: [],
    cleanups,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { list: () => liveAgents }
      return undefined
    },
    logger: { info: () => {}, warn: (m) => ctx.warnings.push(m) },
    emitAgentCreated(agent) {
      for (const fn of listeners.get('agent/created') || []) fn({ agent })
    },
    emitAgentDisposed(agent) {
      for (const fn of listeners.get('agent/disposed') || []) fn({ agent })
    },
    /** Run every cleanup the plugin registered, as its unload would. */
    unload() {
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
    },
  }
  if (withEffect) ctx.effect = (fn) => { cleanups.push(fn()); return () => {} }
  return ctx
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

/** An isolated DSH_HOME holding one machine and one workspace mirror. */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-vis-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    path.join(root, 'machines.json'),
    JSON.stringify({ list: [{ id: 'm1', name: 'box', host: '127.0.0.11', port: 1, username: 'dev', password: 'pw' }], currentId: 'm1' }),
  )
  const dir = path.join(root, '127.0.0.11-dev-1', 'proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, '.dsh-remote-meta.json'),
    JSON.stringify({ host: '127.0.0.11', port: 1, username: 'dev', remotePath: '/home/dev/proj' }),
  )
  return {
    home,
    mirrorCwd: dir,
    localCwd: path.join(home, 'plain-local-project'),
  }
}

async function loadPlugin(home) {
  process.env.DSH_HOME = home
  return import(`../lib/index.js?vis=${Math.random()}`)
}

/** The plugin's own ctx, extended with the agent/created + restrict plumbing. */
function makePluginCtx() {
  const registered = new Map()
  const listeners = new Map()
  return {
    effect: () => {},
    inject: () => {},
    get: (k) => (k === 'sessions' ? { get: () => null, list: () => [] } : undefined),
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
    systemPrompt: { section: () => {}, context: () => {} },
    // Mirrors the real ToolRuntime contract the fence depends on: `restrict` is
    // only legal on a SCOPED context, so the fake throws when called from the
    // plugin's own (global) context.
    tools: {
      register(t) {
        registered.set(t.name, t)
        return () => {}
      },
      restrict() {
        throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
      },
    },
    emitAgentCreated(agent) {
      for (const fn of listeners.get('agent/created') || []) fn({ agent })
    },
    registered,
  }
}

/** An agent whose tools service records what the plugin fenced. */
const scopedAgent = (cwd) => {
  const calls = []
  const toolsService = {
    restrict(filter) {
      calls.push(filter)
      return () => {}
    },
  }
  const agent = { session: { header: { cwd } }, ctx: { get: (n) => (n === 'tools' ? toolsService : undefined) } }
  agent.calls = calls
  return agent
}

/** Every `rw_*` name the plugin declares, read straight from lib/index.js. */
function declaredToolNames() {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const names = new Set()
  for (const block of src.split('defineTool({').slice(1)) {
    const name = /\bname:\s*'(rw_[a-z_]+)'/.exec(block)
    assert.ok(name, 'every defineTool({ block must declare a name')
    names.add(name[1])
  }
  return names
}

// ── coverage: nothing may escape the fence ─────────────────────────────────

test('the fence denies EVERY declared rw_* tool, not a hand-picked subset', async () => {
  const { home, mirrorCwd, localCwd } = makeHome()
  mkdirSync(localCwd, { recursive: true })
  try {
    const { apply } = await loadPlugin(home)
    const ctx = makePluginCtx()
    await apply(ctx, { ...CONFIG })

    // Tools stay registered globally: a tool in an agent's own layer cannot be
    // named by a restriction at all, so this must not change.
    const registered = [...ctx.registered.keys()].sort()
    assert.ok(registered.length >= 25, `expected the full rw_* tool set, got ${registered.length}`)

    // …and the deny list is exactly that set, so a new tool cannot slip past.
    const local = scopedAgent(localCwd)
    ctx.emitAgentCreated(local)
    assert.equal(local.calls.length, 1, 'a local session must be fenced')
    assert.deepEqual([...local.calls[0].deny].sort(), registered,
      'every registered tool must be hidden from a local session')

    // The registration set really is the whole rw_* surface declared in source.
    assert.deepEqual(registered, [...declaredToolNames()].sort(),
      'a local session must see none of the declared rw_* tools')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('a session bound to a remote mirror keeps every rw_* tool', async () => {
  const { home, mirrorCwd } = makeHome()
  try {
    const { apply } = await loadPlugin(home)
    const ctx = makePluginCtx()
    await apply(ctx, { ...CONFIG })

    const remote = scopedAgent(mirrorCwd)
    ctx.emitAgentCreated(remote)
    assert.deepEqual(remote.calls, [], 'a mirror session must not be fenced at all')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('the fence never runs on the plugin context itself', async () => {
  // tools.restrict() throws from a context-global caller by design; wired to
  // the wrong ctx the plugin would break on every load.
  const { home } = makeHome()
  try {
    const { apply } = await loadPlugin(home)
    const ctx = makePluginCtx()
    await assert.doesNotReject(() => apply(ctx, { ...CONFIG }))
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

// ── the fence itself ───────────────────────────────────────────────────────

test('fenceAgent hides the tools from a LOCAL session', () => {
  const { agent, calls } = makeAgent('C:\\Users\\me\\project')
  const dispose = fenceAgent(agent, DENY, () => false)
  assert.equal(typeof dispose, 'function', 'a restriction must hand back its disposer')
  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0].deny].sort(), [...DENY].sort())
})

test('fenceAgent leaves a session bound to a remote mirror completely alone', () => {
  const { agent, calls } = makeAgent('/home/dev/.dsh-remote/box-1/proj')
  assert.equal(fenceAgent(agent, DENY, isMirror), false)
  assert.deepEqual(calls, [], 'a remote session must keep every rw_* tool')
})

test('fenceAgent fences a session that has no cwd at all', () => {
  // A tool list we cannot justify is exactly the failure this fence prevents.
  const { agent, calls } = makeAgent(undefined)
  assert.ok(fenceAgent(agent, DENY, () => false))
  assert.equal(calls.length, 1)
})

test('fenceAgent survives a missing tools service and a throwing restrict()', () => {
  assert.equal(fenceAgent({ session: { header: { cwd: '/local' } }, ctx: { get: () => undefined } }, DENY, () => false), false)
  assert.equal(fenceAgent(undefined, DENY, () => false), false)
  const boom = {
    session: { header: { cwd: '/local' } },
    ctx: { get: () => ({ restrict() { throw new Error('nope') } }) },
  }
  const warned = []
  assert.equal(fenceAgent(boom, DENY, () => false, (m) => warned.push(m)), false)
  assert.equal(warned.length, 1, 'a failed fence is reported, not swallowed silently')
})

test('fenceLocalSessions listens for agent/created and sweeps already-live agents', () => {
  const localLive = makeAgent('/home/dev/plain')
  const remoteLive = makeAgent('/home/dev/.dsh-remote/box-1/proj')
  const ctx = makeCtx({ liveAgents: [localLive.agent, remoteLive.agent] })
  const result = fenceLocalSessions(ctx, DENY, isMirror)

  assert.equal(result.fenced, 1, 'a live local session is fenced at load; a live remote one is not')
  assert.equal(localLive.calls.length, 1, 'a plugin loaded into a running host must not wait for the next session')
  assert.deepEqual(remoteLive.calls, [])

  const fresh = makeAgent('/home/dev/plain')
  ctx.emitAgentCreated(fresh.agent)
  assert.equal(fresh.calls.length, 1)
})

// ── ownership: dsh-tools registers the restriction on the AGENT's fiber ────
//
// `tools.restrict()` is called through the agent's traced context, so its effect
// belongs to the agent's scope fiber — unloading the plugin does NOT lift it. A
// deny set from an older version would therefore survive every reload and keep
// masking tools the current version considers visible.

test('the fence is lifted when the plugin unloads', () => {
  const agent = makeAgent('/home/dev/plain')
  const ctx = makeCtx({ liveAgents: [agent.agent], withEffect: true })
  fenceLocalSessions(ctx, DENY, () => false)

  assert.equal(agent.calls.length, 1, 'the live session is fenced at load')
  assert.equal(ctx.cleanups.length, 1, 'the plugin must register exactly one cleanup effect')
  assert.equal(agent.liftCount, 0, 'the restriction is live before unload')

  ctx.unload()
  assert.equal(agent.liftCount, 1, 'unloading the plugin must lift every restriction it added')
})

test('re-fencing an agent within one load releases the superseded restriction', () => {
  const agent = makeAgent('/home/dev/plain')
  const ctx = makeCtx({ liveAgents: [agent.agent] })
  fenceLocalSessions(ctx, DENY, () => false)
  assert.equal(agent.calls.length, 1, 'the load-time sweep fences it')

  // Same agent, same load: the mask must be replaced, not stacked, so the agent
  // is never left carrying two registrations where one suffices.
  ctx.emitAgentCreated(agent.agent)
  assert.equal(agent.calls.length, 2, 'the fence is re-applied')
  assert.equal(agent.liftCount, 1, 'and the superseded restriction was lifted')
})

test('a disposed agent does not keep a registration', () => {
  const agent = makeAgent('/home/dev/plain')
  const ctx = makeCtx({ withEffect: true })
  fenceLocalSessions(ctx, DENY, () => false)
  ctx.emitAgentCreated(agent.agent)
  assert.equal(agent.calls.length, 1)

  ctx.emitAgentDisposed(agent.agent)
  assert.equal(agent.liftCount, 1, 'a disposed agent must not keep a registration')

  // …and unloading afterwards must not try to lift it a second time.
  ctx.unload()
  assert.equal(agent.liftCount, 1)
})

test('fenceLocalSessions is a no-op on a ctx with no event surface', () => {
  // Older/headless hosts may not give the plugin `ctx.on`; failing here would
  // take the whole plugin down, so it must degrade to the old behaviour.
  assert.doesNotThrow(() => fenceLocalSessions({}, DENY, () => false))
  assert.doesNotThrow(() => fenceLocalSessions({ get: () => { throw new Error('no agents service') } }, DENY, () => false))
})

// ── no remaining text promises a hidden tool ───────────────────────────────

test('the /remote command tells a local session it has no rw_* tools', async () => {
  const { home, localCwd } = makeHome()
  mkdirSync(localCwd, { recursive: true })
  try {
    const { apply } = await loadPlugin(home)
    const registered = []
    const ctx = {
      effect: () => {},
      inject: () => {},
      get: (k) => {
        if (k === 'sessions') return { get: () => null, list: () => [] }
        if (k === 'commands') {
          return { register: (c) => { if (c.name === 'remote') ctx.remoteCommand = c } }
        }
        return undefined
      },
      logger: { info: () => {}, warn: () => {} },
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: (t) => { registered.push(t.name); return () => {} }, restrict: () => { throw new Error('scoped only') } },
    }
    await apply(ctx, { ...CONFIG })

    assert.ok(ctx.remoteCommand, 'the /remote command must be registered')
    const out = ctx.remoteCommand.handler({ agent: { session: { header: { cwd: localCwd } } } })
    assert.match(out.text, /not offered the rw_\* tools at all/,
      'a local session must not be pointed at tools it cannot call')
    assert.doesNotMatch(out.text, /Use tools: rw_list_dir/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
