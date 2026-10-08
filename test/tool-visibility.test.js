// A session whose workspace is NOT a remote mirror must not be offered the
// session-bound rw_* tools.
//
// The bug this pins: every rw_* schema was registered globally and therefore
// appeared in the model's tool list for EVERY session, including a plain local
// one — where each of those tools is guaranteed to fail, because
// requireBinding()/requireMachine() refuse a caller with no mirror. The model
// reached for rw_read_file to look at a file and burned a turn on an error no
// correct usage could avoid.
//
// The fence is `tools.restrict({ deny })` on the agent's own scoped context,
// which is the only mechanism the harness offers (dsh-tools `view(scope)` drops
// every inherited tool a scope in the agent's chain does not admit).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  SESSION_BOUND_TOOLS,
  SESSION_WIDE_TOOLS,
  fenceAgent,
  fenceLocalSessions,
} from '../lib/tool-visibility.js'

// ── helpers ────────────────────────────────────────────────────────────────

/** An agent whose session workspace is `cwd`, recording every restrict() call. */
const makeAgent = (cwd) => {
  const calls = []
  const toolsService = {
    restrict(filter) {
      calls.push(filter)
      return () => {}
    },
  }
  return {
    calls,
    agent: {
      session: { header: { cwd } },
      ctx: { get: (name) => (name === 'tools' ? toolsService : undefined) },
    },
  }
}

/** A plugin-ish ctx: captures `agent/created` listeners and live agents. */
const makeCtx = ({ liveAgents = [] } = {}) => {
  const listeners = new Map()
  const warnings = []
  return {
    listeners,
    warnings,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { list: () => liveAgents }
      return undefined
    },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
    emitAgentCreated(agent) {
      for (const fn of listeners.get('agent/created') || []) fn({ agent })
    },
  }
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
  const agentTools = []
  const ctx = {
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
    // Mirrors the real ToolRuntime contract that the fence depends on:
    // `restrict` is only legal on a SCOPED context, so the fake throws when
    // called from the plugin's own (global) context.
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
    agentTools,
    registered,
  }
  return ctx
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

// ── the two lists partition the tool set, and the partition is the right one ──

test('the session-bound list is exactly the set of tools that refuse a local caller', () => {
  // Derive the truth from the source: a tool is session-bound iff its execute
  // body resolves through requireBinding()/requireMachine(). A new session-bound
  // tool added without updating lib/tool-visibility.js would reintroduce the bug
  // silently, so this is pinned against the file rather than a copy of the list.
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const blocks = src.split('defineTool({')
  const tools = new Map()
  for (const block of blocks.slice(1)) {
    const name = /\bname:\s*'(rw_[a-z_]+)'/.exec(block)
    assert.ok(name, 'every defineTool({ block must declare a name')
    tools.set(name[1], /require(?:Binding|Machine)\(exec\b/.test(block))
  }

  assert.equal(tools.size, 25, `expected 25 rw_* tools in lib/index.js, found ${tools.size}`)
  const derived = [...tools].filter(([, bound]) => bound).map(([n]) => n).sort()
  assert.deepEqual([...SESSION_BOUND_TOOLS].sort(), derived,
    'SESSION_BOUND_TOOLS must match the tools that call requireBinding/requireMachine')

  const wide = [...tools.keys()].filter((n) => !SESSION_BOUND_TOOLS.includes(n)).sort()
  assert.deepEqual([...SESSION_WIDE_TOOLS].sort(), wide,
    'SESSION_WIDE_TOOLS must be exactly the tools that stay visible everywhere')

  // No overlap, and nothing outside the rw_* namespace is fenced.
  for (const n of SESSION_BOUND_TOOLS) assert.ok(tools.has(n), `${n} is not a real tool`)
  for (const n of SESSION_BOUND_TOOLS) assert.ok(!SESSION_WIDE_TOOLS.includes(n), `${n} appears in both lists`)
})

test('the setup flow a local session needs is never fenced', () => {
  // Hiding these would leave a local session with no way to become a remote one.
  for (const n of ['rw_info', 'rw_connect', 'rw_machines', 'rw_pick_workspace', 'rw_forward', 'rw_disconnect']) {
    assert.ok(SESSION_WIDE_TOOLS.includes(n), `${n} must stay available in every session`)
    assert.ok(!SESSION_BOUND_TOOLS.includes(n))
  }
})

// ── the fence itself ───────────────────────────────────────────────────────

test('fenceAgent hides the session-bound tools from a LOCAL session', () => {
  const { agent, calls } = makeAgent('C:\\Users\\me\\project')
  const fenced = fenceAgent(agent, () => false)
  assert.equal(fenced, true)
  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0].deny].sort(), [...SESSION_BOUND_TOOLS].sort())
})

test('fenceAgent leaves a session bound to a remote mirror completely alone', () => {
  const { agent, calls } = makeAgent('/home/dev/.dsh-remote/box-1/proj')
  assert.equal(fenceAgent(agent, (cwd) => cwd.includes('dsh-remote')), false)
  assert.deepEqual(calls, [], 'a remote session must keep every rw_* tool')
})

test('fenceAgent fences a session that has no cwd at all', () => {
  // A tool list we cannot justify is exactly the failure this fence prevents.
  const { agent, calls } = makeAgent(undefined)
  assert.equal(fenceAgent(agent, () => false), true)
  assert.equal(calls.length, 1)
})

test('fenceAgent survives a missing tools service and a throwing restrict()', () => {
  assert.equal(fenceAgent({ session: { header: { cwd: '/local' } }, ctx: { get: () => undefined } }, () => false), false)
  assert.equal(fenceAgent(undefined, () => false), false)
  const boom = {
    session: { header: { cwd: '/local' } },
    ctx: { get: () => ({ restrict() { throw new Error('nope') } }) },
  }
  const warned = []
  assert.equal(fenceAgent(boom, () => false, (m) => warned.push(m)), false)
  assert.equal(warned.length, 1, 'a failed fence is reported, not swallowed silently')
})

test('fenceLocalSessions listens for agent/created and sweeps already-live agents', () => {
  const localLive = makeAgent('/home/dev/plain')
  const remoteLive = makeAgent('/home/dev/.dsh-remote/box-1/proj')
  const ctx = makeCtx({ liveAgents: [localLive.agent, remoteLive.agent] })
  const result = fenceLocalSessions(ctx, (cwd) => cwd.includes('dsh-remote'))

  assert.equal(result.fenced, 1, 'a live local session is fenced at load; a live remote one is not')
  assert.equal(localLive.calls.length, 1, 'a plugin loaded into a running host must not wait for the next session')
  assert.deepEqual(remoteLive.calls, [])

  const fresh = makeAgent('/home/dev/plain')
  ctx.emitAgentCreated(fresh.agent)
  assert.equal(fresh.calls.length, 1)

  // Fencing is idempotent per agent: a second edge must not stack restrictions.
  ctx.emitAgentCreated(fresh.agent)
  assert.equal(fresh.calls.length, 1)
})

test('fenceLocalSessions is a no-op on a ctx with no event surface', () => {
  // Older/headless hosts may not give the plugin `ctx.on`; failing here would
  // take the whole plugin down, so it must degrade to the old behaviour.
  assert.doesNotThrow(() => fenceLocalSessions({}, () => false))
  assert.doesNotThrow(() => fenceLocalSessions({ get: () => { throw new Error('no agents service') } }, () => false))
})

// ── end-to-end through the real apply() ────────────────────────────────────

test('a local session gets no rw_* workspace tools; a mirror session gets all of them', async () => {
  const { home, mirrorCwd, localCwd } = makeHome()
  mkdirSync(localCwd, { recursive: true })
  try {
    const { apply } = await loadPlugin(home)
    const ctx = makePluginCtx()
    await apply(ctx, { ...CONFIG })

    // Tools are still registered GLOBALLY — a tool registered into an agent's
    // own layer cannot be named by a restriction, so this must not change.
    assert.ok(ctx.registered.get('rw_exec'), 'rw_exec must stay registered globally')
    assert.ok(ctx.registered.get('rw_read_file'))

    const local = scopedAgent(localCwd)
    const remote = scopedAgent(mirrorCwd)
    ctx.emitAgentCreated(local)
    ctx.emitAgentCreated(remote)

    assert.equal(local.calls.length, 1, 'a local session must be fenced')
    assert.deepEqual([...local.calls[0].deny].sort(), [...SESSION_BOUND_TOOLS].sort())
    assert.equal(remote.calls.length, 0, 'a mirror session must not be fenced at all')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('the fence never runs on the plugin context itself', async () => {
  // tools.restrict() throws from a context-global caller by design; if the fence
  // were wired to the wrong ctx the plugin would break on every load.
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
