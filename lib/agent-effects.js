// Ownership of effects this plugin creates THROUGH an agent's scoped context.
//
// THE TRAP
//
// Services reached through an agent's traced context (`agent.ctx.get('tools')`,
// `agent.ctx.get('skills')`) run their registration with `this.ctx` set to the
// AGENT's context, so `ScopedLayers.effect()` files the effect on the agent's
// scope fiber — NOT on this plugin's fiber. Unloading the plugin therefore never
// reaches it. A contribution registered that way outlives the plugin that made
// it: a superseded deny list keeps masking tools, and a superseded skill stays in
// the catalog of every session, with no handle anywhere to remove it.
//
// THE RULE
//
// Anything registered through an agent scope is OURS to remove. The disposer the
// service hands back is kept per agent and released when the agent is re-bound,
// when the agent is disposed, and when this plugin unloads — so the plugin
// leaves each agent exactly as it found it.

/**
 * Track the per-agent disposers of scoped registrations and guarantee they are
 * released, on all three of their exit paths.
 *
 * @param {object} ctx - the plugin context.
 * @param {(msg: string) => void} [onError] - diagnostics sink.
 * @returns {{
 *   bind: (agent: object, create: () => (() => void)|false) => boolean,
 *   release: (agent: object) => void,
 *   count: () => number,
 * }}
 */
export function createAgentEffectTracker(ctx, onError) {
  // A Map (not a WeakSet): the per-agent disposer must be retrievable for
  // re-binding AND iterable on unload. Entries are dropped on agent/disposed, so
  // it cannot outlive the sessions it tracks.
  const disposers = new Map()

  const release = (agent) => {
    const dispose = disposers.get(agent)
    if (!dispose) return
    disposers.delete(agent)
    try { dispose() } catch (err) { report(`could not release a scoped registration: ${(err && err.message) || err}`) }
  }

  const report = (msg) => { if (typeof onError === 'function') onError(msg) }

  /**
   * Run `create` and remember whatever disposer it produced, releasing the
   * registration this agent already had first.
   *
   * @param {object} agent - the agent the registration targets.
   * @param {() => (() => void)|false} create - performs the scoped registration.
   * @returns {boolean} whether a registration is now live for this agent.
   */
  const bind = (agent, create) => {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return false
    // Replace rather than stack: a superseded registration would otherwise keep
    // applying alongside its replacement.
    release(agent)
    const dispose = create()
    if (!dispose) return false
    if (typeof dispose !== 'function') return true
    disposers.set(agent, dispose)
    return true
  }

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('agent/disposed', (payload) => { if (payload && payload.agent) release(payload.agent) })
  }

  // Lift everything we added when the plugin goes away (see THE TRAP).
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const agent of [...disposers.keys()]) release(agent)
    }, 'dsh-remote.agent-effects')
  }

  return { bind, release, count: () => disposers.size }
}

/**
 * Attach a listener that runs `bind` for every agent created from now on.
 *
 * @param {object} ctx - the plugin context.
 * @param {(agent: object) => void} bind - the per-agent binder to invoke.
 */
export function onAgentCreated(ctx, bind) {
  if (ctx && typeof ctx.on === 'function') ctx.on('agent/created', (payload) => bind(payload && payload.agent))
}
