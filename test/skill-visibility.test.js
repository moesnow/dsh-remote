// The `dsh-remote-deploy` skill must be offered only to sessions with a remote
// context — the same rule as the rw_* tools.
//
// The skill is a playbook for installing DSH on a REMOTE machine and opens with
// `rw_deploy_probe`; a session with no remote context has no machine to install
// on and no probe to run, so listing it is the same false statement the tools'
// fence removes.
//
// dsh-skill has no `restrict()`: `collectFresh()` merges `[global, ...chainLayers
// (scope)]` and a scope's own layer unconditionally. So placement IS the gate —
// the skill is registered into the scopes of the sessions that qualify, and
// never globally.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { gateSkillByRemoteContext, registerScopedSkill } from '../lib/skill-visibility.js'

// ── helpers ────────────────────────────────────────────────────────────────

const MIRROR_CWD = '/home/dev/.dsh-remote/box-1/proj'
const LOCAL_CWD = 'C:\\Users\\me\\project'
const isMirror = (agent) => !!(agent && agent.session && agent.session.header
  ? String(agent.session.header.cwd || '').includes('dsh-remote')
  : false)

/** An agent whose skills service records registrations and their disposal. */
const makeAgent = (cwd, id = 's1') => {
  const registered = []
  const lifted = []
  const skillsService = {
    register(definition) {
      registered.push(definition)
      return () => lifted.push(definition.name)
    },
  }
  const agent = {
    id,
    session: { id, header: { cwd } },
    ctx: { get: (name) => (name === 'skills' ? skillsService : undefined) },
  }
  return { agent, registered, lifted }
}

function makeCtx({ liveAgents = [], withAgents = true, withEffect = false } = {}) {
  const listeners = new Map()
  const warnings = []
  const cleanups = []
  const ctx = {
    warnings,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return () => {}
    },
    get(name) {
      if (name === 'agents' && withAgents) return { list: () => liveAgents }
      if (name === 'skills') return { register: () => () => {} }
      return undefined
    },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
    emit(evt, agent) {
      for (const fn of listeners.get(evt) || []) fn({ agent })
    },
    unload() {
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
    },
  }
  if (withEffect) ctx.effect = (fn) => { cleanups.push(fn()); return () => {} }
  return ctx
}

const DEFINITION = { name: 'dsh-remote-deploy', content: 'body' }

// ── the gate ───────────────────────────────────────────────────────────────

test('a session with a remote context is offered the skill; a local one is not', () => {
  const remote = makeAgent(MIRROR_CWD, 'remote')
  const local = makeAgent(LOCAL_CWD, 'local')
  const ctx = makeCtx({ liveAgents: [remote.agent, local.agent] })

  const result = gateSkillByRemoteContext(ctx, DEFINITION, isMirror)

  assert.equal(result.scoped, 1)
  assert.equal(result.fallback, false)
  assert.deepEqual(remote.registered.map((s) => s.name), ['dsh-remote-deploy'])
  assert.deepEqual(local.registered, [], 'a local session must not see the deploy skill')
})

test('a session created later is gated the same way', () => {
  const ctx = makeCtx()
  gateSkillByRemoteContext(ctx, DEFINITION, isMirror)

  const remote = makeAgent(MIRROR_CWD, 'r')
  const local = makeAgent(LOCAL_CWD, 'l')
  ctx.emit('agent/created', remote.agent)
  ctx.emit('agent/created', local.agent)

  assert.equal(remote.registered.length, 1)
  assert.equal(local.registered.length, 0)
})

test('the skill is released when the plugin unloads', () => {
  // skills.register() is called through the agent's traced context, so dsh-skill
  // files the effect on the AGENT's fiber. The plugin's own disposal cannot
  // reach it, which is what would leave a stale skill in every catalog.
  const remote = makeAgent(MIRROR_CWD, 'r')
  const ctx = makeCtx({ liveAgents: [remote.agent], withEffect: true })
  gateSkillByRemoteContext(ctx, DEFINITION, isMirror)
  assert.equal(remote.lifted.length, 0)

  ctx.unload()
  assert.deepEqual(remote.lifted, ['dsh-remote-deploy'])
})

test('a disposed session keeps nothing', () => {
  const remote = makeAgent(MIRROR_CWD, 'r')
  const ctx = makeCtx({ withEffect: true })
  gateSkillByRemoteContext(ctx, DEFINITION, isMirror)
  ctx.emit('agent/created', remote.agent)
  assert.equal(remote.registered.length, 1)

  ctx.emit('agent/disposed', remote.agent)
  assert.deepEqual(remote.lifted, ['dsh-remote-deploy'])
})

test('re-offering replaces rather than stacks', () => {
  const remote = makeAgent(MIRROR_CWD, 'r')
  const ctx = makeCtx({ liveAgents: [remote.agent] })
  gateSkillByRemoteContext(ctx, DEFINITION, isMirror)
  ctx.emit('agent/created', remote.agent)
  assert.equal(remote.registered.length, 2, 're-offered')
  assert.deepEqual(remote.lifted, ['dsh-remote-deploy'], 'and the first registration was released')
})

// ── the fallback that keeps the settings card working ──────────────────────

test('a composition with no agents service falls back to a global registration', () => {
  // The settings card's "AI 排查" starts a session with no workspace; losing the
  // skill there would break the button that asks for it by name.
  const globalRegistrations = []
  const ctx = makeCtx({ withAgents: false })
  ctx.get = (name) => (name === 'skills'
    ? { register: (d) => { globalRegistrations.push(d); return () => {} } }
    : undefined)

  const result = gateSkillByRemoteContext(ctx, DEFINITION, isMirror)

  assert.equal(result.fallback, true, 'the caller must fall back to a global registration')
  assert.equal(result.scoped, 0)
  assert.deepEqual(globalRegistrations, [], 'gateSkillByRemoteContext itself registers nothing globally')
})

// ── robustness ─────────────────────────────────────────────────────────────

test('registerScopedSkill survives a missing or throwing skills service', () => {
  assert.equal(registerScopedSkill({ ctx: { get: () => undefined } }, DEFINITION), false)
  assert.equal(registerScopedSkill(undefined, DEFINITION), false)
  const boom = { ctx: { get: () => ({ register() { throw new Error('dup') } }) } }
  assert.equal(registerScopedSkill(boom, DEFINITION), false, 'a duplicate name must not throw out')
})
