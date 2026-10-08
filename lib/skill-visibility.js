// Per-session visibility for the `dsh-remote-deploy` skill.
//
// WHY THIS NEEDS A DIFFERENT MECHANISM THAN THE TOOLS
//
// dsh-skill has no `restrict()`. Its registry has `register`/`registerProvider`
// and no allow/deny mask at all: `collectFresh()` builds a catalog out of
// `[global, ...chainLayers(scope)]`, and a scope's own layer is merged
// unconditionally, exactly like dsh-tools' own-layer rule. So for skills,
// WHERE a registration is filed IS the visibility — the only way to show one to
// some sessions and not others is to register it into those sessions' scopes.
//
// That is the inverse of the tools, which must stay registered globally so they
// remain nameable by a restriction. Here the global registration is the thing to
// avoid: it would put the skill in every catalog, local sessions included.
//
// WHY IT MATTERS
//
// The skill is a playbook for installing DSH on a REMOTE machine and tells the
// model to open with `rw_deploy_probe`. In a session with no remote context
// there is no remote machine to install on and no probe to run, so listing it is
// the same false statement the rw_* fence removes — and it is the last surface
// still mentioning remote work once the tools are gone.
//
// FALLBACK
//
// A composition with no `agents` service cannot be gated per session. Rather than
// silently lose the skill (which would break the settings card's AI triage), the
// caller keeps a global registration for that case. A missing skill only costs
// the AI fallback; the deterministic deploy path is unaffected either way.

import { createAgentEffectTracker, onAgentCreated } from './agent-effects.js'

/**
 * Register `definition` into one agent's scope, so only sessions that inherit
 * that scope (this agent and its subagents) see the skill.
 *
 * @param {object} agent - the agent to register into.
 * @param {object} definition - the skill definition to register.
 * @returns {(() => void)|false} the disposer, or false on failure.
 */
export function registerScopedSkill(agent, definition) {
  const skills = agent && agent.ctx && typeof agent.ctx.get === 'function'
    ? agent.ctx.get('skills')
    : undefined
  if (!skills || typeof skills.register !== 'function') return false
  try {
    const dispose = skills.register(definition)
    return typeof dispose === 'function' ? dispose : true
  } catch (err) {
    return false
  }
}

/**
 * Offer `definition` only to sessions that have a remote context.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} definition - the skill definition to offer.
 * @param {(agent: object) => boolean} hasRemoteContext - the per-session test.
 * @param {{ fallback: boolean }} result - mutated with what actually happened:
 *   `scoped` counts agents the skill was offered to at load, `fallback` is true
 *   when the composition cannot gate per session and the skill was registered
 *   globally instead.
 * @returns {{ scoped: number, fallback: boolean }} the same object.
 */
export function gateSkillByRemoteContext(ctx, definition, hasRemoteContext, result = {}) {
  result.scoped = 0
  result.fallback = false

  const logger = ctx && ctx.logger
  const onError = (msg) => {
    if (logger && typeof logger.warn === 'function') logger.warn(`[dsh-remote] ${msg}`)
  }

  const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (!agents || typeof agents.list !== 'function') {
    // No agents service: nothing to gate on, and the settings card's AI triage
    // would lose its skill. Register globally rather than drop it.
    result.fallback = true
    return result
  }

  const tracker = createAgentEffectTracker(ctx, onError)

  /** A local session must NOT be offered the skill, so nothing to unbind there. */
  const offer = (agent) => {
    if (!agent) return false
    if (hasRemoteContext(agent)) {
      return tracker.bind(agent, () => registerScopedSkill(agent, definition))
    }
    // A session that lost (or never had) a remote context must not keep a
    // registration made when it had one.
    tracker.release(agent)
    return false
  }

  onAgentCreated(ctx, offer)

  try {
    for (const agent of agents.list()) if (offer(agent)) result.scoped++
  } catch (err) {
    onError(`could not sweep live agents for the ${definition.name} skill: ${(err && err.message) || err}`)
    result.fallback = true
  }
  return result
}
