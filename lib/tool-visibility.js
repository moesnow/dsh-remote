// Per-session visibility for the `rw_*` tools.
//
// THE RULE
//
// A session is offered the `rw_*` tools ONLY when its workspace is a dsh-remote
// mirror. Every one of them describes or operates on a REMOTE host reached
// through that mirror; from a plain local directory they are either
// guaranteed to fail (the session-bound ones, which resolve their target
// through requireBinding()/requireMachine() and refuse a caller with no mirror
// because there is no remote root to resolve a path against) or simply have
// nothing to describe and nothing to act on (rw_info / rw_machines /
// rw_connect / rw_pick_workspace / rw_forward / rw_disconnect).
//
// Either way, advertising them to a local session is a false statement about
// what the session can do. The 19 session-bound ones cost real accuracy: the
// model sees an obvious tool ("look at a file" -> rw_read_file), calls it,
// burns a turn on an error no correct usage can avoid, and often reports the
// file as unreadable.
//
// WHY restrict() AND NOT SOMETHING ELSE
//
// The harness has exactly one visibility mechanism for this, and it is the one
// the dsh-agent guidance names: `ctx.tools.restrict({ deny })` on an agent's
// scoped context. dsh-tools assembles each agent's tool list from
// `view(agent).visible`, which drops any inherited tool a scope in the agent's
// chain does not admit — so a deny registered through `agent.ctx` removes the
// schema from the model-facing list AND from lookup AND from dispatch, all at
// once, with no chance of the three disagreeing.
//
// Two properties of that API shape this file:
//
//  1. The tools MUST stay registered globally (the `for (const t of tools)` loop
//     in lib/index.js). A tool registered through `agent.ctx` lands in that
//     scope's OWN layer, which `view()` adds unconditionally and `restrict()`
//     cannot even name — agent-scoped registration would make these tools
//     permanently unhideable.
//  2. The restriction is per AGENT, and a top-level session has exactly one
//     agent, so per-agent is per-session. A session's `header.cwd` is immutable
//     for the life of its agent (the workspace attach path validates it against
//     the stored header and rejects a change), so deciding once at
//     `agent/created` cannot go stale mid-session.
//
// WHY THE NAMES ARE PASSED IN, NOT HARDCODED HERE
//
// There used to be a split between "session-bound" tools and a "setup surface"
// that stayed visible everywhere. That split is gone: the rule is now simply
// "every `rw_*` tool needs a mirror-bound session", so a hand-maintained list
// would be a second copy of "the tools registered a few lines above" — free to
// drift, and free to go stale the moment a 26th tool is added. The caller
// passes the names it just registered, so coverage cannot be forgotten.
//
// A local session still reaches everything: the settings page (设置 → 远程工作区)
// registers a machine and picks a workspace, and the sidebar can open a session
// in the resulting mirror. Those are host-side paths, not tools.

/**
 * Hide `denyNames` from one agent whose session workspace is not a
 * dsh-remote mirror.
 *
 * Best-effort by design: a failure here leaves the tools visible, which is the
 * old behaviour, and must never propagate into agent creation — a broken
 * visibility fence is not worth failing a session over.
 *
 * @param {object} agent - the agent from an `agent/created` payload.
 * @param {readonly string[]} denyNames - the tool names to hide.
 * @param {(cwd: string) => boolean} isRemoteCwd - whether a session cwd is a mirror.
 * @param {(msg: string) => void} [onError] - diagnostics sink.
 * @returns {(() => void)|false} the disposer that lifts the restriction, or
 *   false when none was applied. The caller MUST keep it: dsh-tools registers
 *   the restriction on the agent's scope fiber, so nothing else will lift it.
 */
export function fenceAgent(agent, denyNames, isRemoteCwd, onError) {
  const cwd = agent && agent.session && agent.session.header
    ? agent.session.header.cwd
    : ''
  // No cwd at all is NOT a mirror-bound session, and a tool list we cannot
  // justify is exactly the failure this fence exists to prevent.
  // `isRemoteCwd('')` answers false for every binding resolver in this plugin
  // (no path -> no mirror).
  if (isRemoteCwd(cwd ? String(cwd) : '')) return false
  const tools = agent && agent.ctx && typeof agent.ctx.get === 'function'
    ? agent.ctx.get('tools')
    : undefined
  if (!tools || typeof tools.restrict !== 'function' || denyNames.length === 0) return false
  try {
    // `restrict()` validates every name against what this scope INHERITS, and
    // the plugin registers all of them globally at apply() time — before any
    // agent can exist — so the names are always known here.
    const dispose = tools.restrict({ deny: [...denyNames] })
    return typeof dispose === 'function' ? dispose : true
  } catch (err) {
    if (onError) onError(`could not hide the rw_* tools for ${cwd || '(no cwd)'}: ${(err && err.message) || err}`)
    return false
  }
}

/**
 * Fence every session whose workspace is not a remote mirror.
 *
 * Installs the `agent/created` listener AND sweeps the agents that are already
 * live, because a plugin loaded into a running host (HMR, a late install, an
 * auto-update hot swap) never sees `agent/created` for sessions that already
 * exist — those would keep the misleading tool list until they are restarted.
 *
 * OWNERSHIP. `tools.restrict()` is called through the agent's traced context, so
 * dsh-tools registers the restriction on the AGENT's scope fiber — not on this
 * plugin's fiber. Unloading the plugin therefore does NOT lift it, and a deny
 * set from a previous version would survive every reload and keep masking
 * tools the current one considers visible. The disposer `restrict()` hands back
 * is kept per agent and run both when that agent is re-fenced and when this
 * plugin unloads, so the plugin leaves each agent exactly as it found it.
 *
 * @param {object} ctx - the plugin context.
 * @param {readonly string[]} denyNames - the tool names to hide outside a mirror.
 * @param {(cwd: string) => boolean} isRemoteCwd - whether a session cwd is a
 *   dsh-remote mirror (`resolveMirror(...).remotePath` being non-empty).
 * @returns {{ fenced: number }} how many already-live agents were fenced.
 */
export function fenceLocalSessions(ctx, denyNames, isRemoteCwd) {
  const logger = ctx && ctx.logger
  const onError = (msg) => {
    if (logger && typeof logger.warn === 'function') logger.warn(`[dsh-remote] ${msg}`)
  }
  // A Map (not a WeakSet) because the per-agent disposer must be both retrievable
  // for re-fencing and ITERABLE on unload. Entries are dropped on agent/disposed,
  // so it cannot outlive the sessions it tracks.
  const disposers = new Map()

  const release = (agent) => {
    const dispose = disposers.get(agent)
    if (!dispose) return
    disposers.delete(agent)
    try { dispose() } catch (err) { onError(`could not lift the previous rw_* fence: ${(err && err.message) || err}`) }
  }

  /** @returns {boolean} whether this call applied a restriction. */
  const fence = (agent) => {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return false
    // Re-fencing replaces the old mask instead of stacking on it, so a reload
    // cannot leave a superseded deny set behind.
    release(agent)
    const dispose = fenceAgent(agent, denyNames, isRemoteCwd, onError)
    if (!dispose) return false
    if (typeof dispose === 'function') disposers.set(agent, dispose)
    return true
  }

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('agent/created', (payload) => fence(payload && payload.agent))
    ctx.on('agent/disposed', (payload) => { if (payload && payload.agent) release(payload.agent) })
  }

  // Lift everything we added when the plugin goes away (see OWNERSHIP above).
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const agent of [...disposers.keys()]) release(agent)
    }, 'dsh-remote.tool-visibility')
  }

  let fenced = 0
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) if (fence(agent)) fenced++
    }
  } catch (err) {
    onError(`could not sweep live agents for remote-workspace binding: ${(err && err.message) || err}`)
  }
  return { fenced }
}
