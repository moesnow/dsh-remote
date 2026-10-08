// Per-session visibility for the session-bound `rw_*` tools.
//
// THE BUG THIS FIXES
//
// Every session-bound rw_* tool resolves its target through requireBinding() /
// requireMachine() (lib/index.js). Both REFUSE a caller whose session workspace
// is a plain local directory: there is no mirror, so there is no remote root to
// resolve a path against, and falling back to the mutable active machine is
// exactly how a command reaches a host the caller never asked for (issue #25).
// That refusal is correct and must stay.
//
// What was wrong is that the tools were still ADVERTISED. The harness put every
// rw_* schema into the model's tool list for every session, so a session working
// in `C:\Users\me\project` was handed 19 tools whose every call is guaranteed to
// fail. The model does what any model does with an obvious tool: it calls
// rw_read_file to "look at a file", burns a turn on an error no correct usage can
// avoid, and often reports the file as unreadable. The tools are not a missing
// feature in a local session — advertising them is a false statement about what
// the session can do.
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
// Only the SETUP surface stays visible in a local session. rw_info / rw_connect
// / rw_machines / rw_pick_workspace are how a local session BECOMES a remote one
// — hiding them would leave a local session with no way to bind a remote
// workspace at all, which is the opposite of the fix. rw_forward and
// rw_disconnect are machine-scoped and work from anywhere.

/**
 * The rw_* tools whose target is THIS session's remote workspace.
 *
 * Kept in one place, and pinned by test/tool-visibility.test.js against the set
 * of tools in lib/index.js that actually call requireBinding()/requireMachine():
 * a new session-bound tool that is not listed here would stay visible in local
 * sessions and reintroduce this bug silently.
 *
 * @type {readonly string[]}
 */
export const SESSION_BOUND_TOOLS = Object.freeze([
  'rw_sync',
  'rw_push',
  'rw_list_dir',
  'rw_stat',
  'rw_read_file',
  'rw_write_file',
  'rw_edit',
  'rw_append',
  'rw_mkdir',
  'rw_remove',
  'rw_move',
  'rw_exec',
  'rw_search',
  'rw_download',
  'rw_upload',
  'rw_deploy_probe',
  'rw_backup',
  'rw_backup_list',
  'rw_restore',
])

/**
 * The rw_* tools that stay available in EVERY session, remote or not.
 *
 * Exported so the tests can assert the two lists partition the tool set and
 * that nothing the local setup flow needs has been fenced off.
 *
 * @type {readonly string[]}
 */
export const SESSION_WIDE_TOOLS = Object.freeze([
  'rw_info',
  'rw_connect',
  'rw_machines',
  'rw_pick_workspace',
  'rw_forward',
  'rw_disconnect',
])

/**
 * Hide {@link SESSION_BOUND_TOOLS} from one agent whose session workspace is not
 * a dsh-remote mirror.
 *
 * Best-effort by design: a failure here leaves the tools visible, which is the
 * old behaviour, and must never propagate into agent creation — a broken
 * visibility fence is not worth failing a session over.
 *
 * @param {object} agent - the agent from an `agent/created` payload.
 * @param {(cwd: string) => boolean} isRemoteCwd - whether a session cwd is a mirror.
 * @param {(msg: string) => void} [onError] - diagnostics sink.
 * @returns {boolean} whether a restriction was applied.
 */
export function fenceAgent(agent, isRemoteCwd, onError) {
  const cwd = agent && agent.session && agent.session.header
    ? agent.session.header.cwd
    : ''
  // No cwd at all is NOT a remote session, and a tool list we cannot justify is
  // exactly the failure this fence exists to prevent. `isRemoteCwd('')` answers
  // false for every binding resolver in this plugin (no path → no mirror).
  if (isRemoteCwd(cwd ? String(cwd) : '')) return false
  const tools = agent && agent.ctx && typeof agent.ctx.get === 'function'
    ? agent.ctx.get('tools')
    : undefined
  if (!tools || typeof tools.restrict !== 'function') return false
  try {
    // `restrict()` validates every name against what this scope INHERITS, and
    // the plugin registers all of them globally at apply() time — before any
    // agent can exist — so the names are always known here.
    tools.restrict({ deny: [...SESSION_BOUND_TOOLS] })
    return true
  } catch (err) {
    if (onError) onError(`could not hide the session-bound rw_* tools for ${cwd || '(no cwd)'}: ${(err && err.message) || err}`)
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
 * @param {object} ctx - the plugin context.
 * @param {(cwd: string) => boolean} isRemoteCwd - whether a session cwd is a
 *   dsh-remote mirror (`resolveMirror(...).remotePath` being non-empty).
 * @returns {{ fenced: number }} how many agents were fenced at install time.
 */
export function fenceLocalSessions(ctx, isRemoteCwd) {
  const logger = ctx && ctx.logger
  const onError = (msg) => {
    if (logger && typeof logger.warn === 'function') logger.warn(`[dsh-remote] ${msg}`)
  }
  // A fence is monotone and cheap, but applying it twice would append a second
  // identical restriction to the same scope layer; track what has been done.
  const done = new WeakSet()

  /** @returns {boolean} whether this call applied a restriction. */
  const fence = (agent) => {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return false
    if (done.has(agent)) return false
    done.add(agent)
    return fenceAgent(agent, isRemoteCwd, onError)
  }

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('agent/created', (payload) => fence(payload && payload.agent))
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
