// dsh-remote — "remote DSH web UI" attach sessions (issue #46).
//
// The user's intent behind that issue is "use the local DSH as a CLIENT for a
// DSH running on another machine": they do NOT want the remote to expose an
// inbound listener. DSH makes that impossible anyway — `dsh-web-app` hard-
// rejects `--host 0.0.0.0` (startup.js) because it would put remote code
// execution on the network, and `dsh-host-webserver` only accepts the
// 127.0.0.1/0.0.0.0 literals.
//
// So this module inverts the direction, exactly like the rest of the plugin:
// we SSH OUT, start (or reuse) a loopback-bound `dsh web` on the remote, and
// carry its socket back over our own SSH connection with a local TCP forward.
// The browser then talks to 127.0.0.1:<localPort> on this machine.
//
// Verified end-to-end on a real Linux host (dsh 0.1.5-rc.2): a bare TCP forward
// is sufficient — the SPA, its assets, AND the `/api/remote.mux` WebSocket
// upgrade all transit it (HTTP/1.1 101), with no reverse proxy and no host
// rewriting. That works because DSH binds its auth cookie to the request
// authority, so a cookie minted against `127.0.0.1:<localPort>` is exactly what
// the browser then sends back to that same authority.
//
// Three details drive the design and are worth stating once:
//
//  1. The launch token CANNOT be read from anywhere but stdout. It is a
//     `randomBytes` value held in a process-local WeakMap and printed on one
//     line (`dsh web: http://127.0.0.1:<port>/?token=…`). No file, no env var.
//     Therefore the token is captured by redirecting the remote process's
//     output to a log file and parsing that line out of it.
//  2. `--port 0` lets the remote OS pick a free port, and the same printed line
//     reports which port it chose — so we never have to guess or probe for a
//     free port on the remote.
//  3. The pairing that must survive is (token, port) from ONE launch. Reading
//     them from one line is what keeps them consistent.
//
// Everything here is read-only with respect to the remote filesystem except
// the log file it creates under the remote `$HOME`.
import net from 'node:net'

/** Remote log file per attach session; `$HOME` is expanded by the remote shell. */
const LOG_NAME = '.dsh-remote-web'

/**
 * Parse the `dsh web:` startup line out of a remote log.
 *
 * The line looks like:
 *   dsh web: http://127.0.0.1:43129/?token=Iy7FKuPSI5qJKJUFDyah4B6i8Ul6_hvspiJhiWufYt8
 * and may be followed by a LAN suffix when the remote bound 0.0.0.0 (it never
 * will here — we never pass `--host` — but tolerate it rather than break).
 *
 * @param {string} text - the remote log contents.
 * @returns {{url: string, port: number, token: string}|null} parsed facts, or
 *   null when the line has not appeared yet (still booting) or is malformed.
 */
export function parseWebStart(text) {
  if (typeof text !== 'string' || text === '') return null
  // Take the LAST match: a reused log file may hold an earlier session's line,
  // and the newest one is the one this launch produced.
  const matches = [...text.matchAll(/dsh web:\s*(http:\/\/[^\s]+)/g)]
  if (matches.length === 0) return null
  const url = matches[matches.length - 1][1]
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const port = Number(parsed.port)
  const token = parsed.searchParams.get('token') || ''
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!token) return null
  return { url, port, token }
}

/** True when the log proves the remote process died instead of booting. */
export function launchFailed(text) {
  return typeof text === 'string' && text.includes(DEAD_MARKER)
}

/** Marker the remote launcher echoes when the process exits before printing. */
const DEAD_MARKER = '__DSH_REMOTE_DIED__'
/** Marker separating the parsed line from the raw log tail for diagnostics. */
export const TAIL_MARKER = '__DSH_TAIL__'
/** Marker carrying the remote PID so the session can stop its own process. */
export const PID_MARKER = '__DSH_PID__='
/** Random ASCII tag so two attach sessions never share a remote log file. */
function randomTag() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
}

/**
 * Build the one-shot remote command that launches `dsh web` detached and waits
 * for its startup line.
 *
 * `setsid` + `nohup` + redirected stdio are all required: the SSH channel closes
 * as soon as this shell exits, and without detaching the SIGHUP would kill the
 * server we just started. The loop is bounded so a wedged remote cannot hang the
 * call past the caller's own timeout, and it reports either the parsed line or
 * the log tail — never silence.
 *
 * @param {object} spec - launch parameters.
 * @param {boolean} [spec.omitNoOpen] - drop `--no-open`. Older DSH (measured on
 *   0.1.0-rc.6) has no such flag and exits with "unknown option '--no-open'";
 *   the caller retries with this set rather than assuming a flag exists.
 * @returns {string} a POSIX shell command line (no newlines, ASCII only).
 */
export function buildLaunchCommand({ command, profile, logPath, remotePort = 0, dshHome = '', waitSeconds = 45, omitNoOpen = false }) {
  const env = dshHome ? `DSH_HOME="${dshHome}" ` : ''
  const noOpen = omitNoOpen ? '' : ' --no-open'
  const args = `--profile ${profile} --port ${Number(remotePort) || 0}${noOpen}`
  const limit = Number(waitSeconds) || 45
  // The loop is ONE shell element: `do` is a keyword and `do;` is a syntax error
  // in POSIX sh, so it must be glued to the first command of the body rather
  // than separated like the other statements.
  const loop = `while [ $i -lt ${limit} ]; do grep -q 'token=' "$LOG" 2>/dev/null && break`
    + `; kill -0 $P 2>/dev/null || { echo ${DEAD_MARKER}; break; }`
    + `; sleep 1; i=$((i+1)); done`
  return [
    `LOG="$HOME/${logPath}"`,
    `: > "$LOG"`,
    // `command -v setsid` guards hosts without util-linux (macOS); plain nohup
    // still detaches from the channel's HUP there.
    `command -v setsid >/dev/null 2>&1 && SET=setsid || SET=`,
    `${env}$SET nohup ${command} ${args} >"$LOG" 2>&1 </dev/null & P=$!`,
    `i=0`,
    loop,
    `echo "${PID_MARKER}$P"`,
    `grep -m1 'dsh web:' "$LOG" 2>/dev/null`,
    `echo ${TAIL_MARKER}`,
    `tail -20 "$LOG" 2>/dev/null`,
  ].join('; ')
}

/** Extract the remote PID from launcher output (0 when absent). */
export function parseRemotePid(output) {
  const m = /__DSH_PID__=(\d+)/.exec(String(output || ''))
  return m ? Number(m[1]) : 0
}

/**
 * Recognize a known remote-side reason the web surface could not start, and
 * return an actionable sentence for it.
 *
 * The point is to keep an operator from reading "the remote DSH did not report a
 * startup token" and concluding the *plugin* is broken. Measured cause: dsh
 * ≤ 0.1.0-rc.6 depends on `node-pty@1.1.0`, whose published tarball ships
 * darwin/win32 prebuilds but **no `linux-x64`**, so `dsh web` cannot boot on
 * Linux at all — it dies loading the native module. 0.1.5-rc.2 moved to
 * `node-pty@1.2.0-beta.15`, which does ship Linux builds.
 *
 * @param {string} output - the remote log tail.
 * @returns {string} a hint, or '' when nothing is recognized.
 */
export function explainLaunchFailure(output) {
  const text = String(output || '')
  if (/pty\.node|Failed to load native module/i.test(text)) {
    return ' The remote could not load node-pty\'s native module. Known cause: dsh <= 0.1.0-rc.6'
      + ' depends on node-pty@1.1.0, which publishes no linux-x64 prebuild, so `dsh web` cannot start'
      + ' on Linux at all. Upgrade the remote dsh to 0.1.5-rc.2 or newer (node-pty@1.2.0-beta.15 ships'
      + ' the Linux build), or point `webAttachCommand` at a newer dsh installed elsewhere.'
  }
  if (/is intentionally not supported|--host 0\.0\.0\.0/i.test(text)) {
    return ' The remote dsh refused an all-interfaces bind. Attach deliberately never passes `--host`;'
      + ' check `webAttachCommand` does not add one.'
  }
  if (/command not found|No such file or directory|not found/i.test(text)) {
    return ' The remote shell could not run the dsh command. If the remote dsh is not on the SSH login'
      + ' PATH (a version manager or private prefix), set `webAttachCommand` to its absolute path.'
  }
  return ''
}

/**
 * Build the command that stops the remote process THIS session started.
 *
 * Two things make this less obvious than it looks, both found by running it
 * against a real host:
 *   1. The log path cannot identify the process — it appears only as a shell
 *      redirect, so it is absent from argv and `pkill -f <logfile>` matches
 *      nothing (the process survived, verified live).
 *   2. The PORT cannot identify it either, because we deliberately launch with
 *      `--port 0` (the remote picks a free port, and the chosen number is only
 *      known afterwards). A `--port 0` substring match therefore never fires.
 *
 * So the recorded PID is the handle, and the kill targets its process GROUP
 * (`kill -- -PID`): the launch goes through `setsid`, making the child a
 * session/group leader whose PGID equals its PID, so the group contains exactly
 * the process tree we started — never a sibling attach session and never the
 * user's own DSH. Before signalling, the command re-verifies that the PID still
 * exists and still looks like a `dsh` process, so a recycled PID belonging to an
 * unrelated program is not killed.
 *
 * @param {number} pid - the PID reported by the launch.
 * @param {string} [logPath] - this session's log file, removed after the kill so
 *   repeated attaches do not accumulate files in the remote home.
 * @returns {string} a POSIX shell command (always exits 0, never throws).
 */
export function buildStopCommand(pid, logPath = '') {
  const p = Number(pid) || 0
  const cleanup = logPath ? `; rm -f "$HOME/${logPath}" 2>/dev/null` : ''
  if (p < 1) return `true${cleanup}`
  return `P=${p}`
    + `; if [ -d "/proc/$P" ]; then`
    + ` C=$(tr '\\0' ' ' < "/proc/$P/cmdline" 2>/dev/null);`
    + ` case "$C" in *dsh*) kill -- -"$P" 2>/dev/null || kill "$P" 2>/dev/null;; esac;`
    + ` fi${cleanup}; true`
}

/**
 * One attached remote DSH Web UI: a local listener whose sockets are carried
 * over SSH to the remote's loopback web port.
 *
 * The listener is a plain `net.Server` + `client.forwardOut` pair — the same
 * mechanism `ForwardManager` uses for user-defined forwards. It is implemented
 * here rather than through that manager because this tunnel is bound to a
 * CHOSEN pool (the machine the user picked), whereas `ForwardManager` is wired
 * to the single "active machine" pool; routing an attach through it would send
 * the tunnel to whichever machine happened to be active.
 */
export class WebAttach {
  /**
   * @param {object} opts - injected collaborators (all optional in production).
   * @param {object} [opts.net] - a `node:net`-compatible module (tests).
   * @param {number} [opts.localPortStart] - first local port to try.
   * @param {number} [opts.localPortMax] - how many ports to try before failing.
   */
  constructor(opts = {}) {
    this.net = opts.net || net
    this.localPortStart = opts.localPortStart || 3088
    this.localPortMax = opts.localPortMax || 50
    /** @type {import('node:net').Server|null} */ this.server = null
    /** @type {Set<import('node:net').Socket>} */ this.sockets = new Set()
    /** @type {object|null} */ this.client = null
    this.localPort = 0
    this.remotePort = 0
    this.token = ''
    this.tag = ''
    this.logPath = ''
    this.remotePid = 0
    this.machineId = ''
    this.command = ''
    this.startedAt = 0
  }

  /** Whether the tunnel is currently listening. */
  get active() {
    return this.server !== null
  }

  /**
   * Attach to a remote DSH Web UI.
   *
   * @param {object} spec - the attach request.
   * @param {object} spec.pool - the SshPool for the chosen machine.
   * @param {string} spec.machineId - machine id, for bookkeeping.
   * @param {string} [spec.command] - remote dsh executable (default `dsh`).
   * @param {string} [spec.profile] - DSH profile to boot (default `web`).
   * @param {string} [spec.existingUrl] - attach to an ALREADY running remote
   *   web UI instead of starting one: its `http://127.0.0.1:<port>/?token=…`.
   * @param {(cmd: string, opts?: object) => Promise<{stdout: string, code: number}>} [spec.exec]
   *   - remote exec, defaulting to `pool.exec`.
   * @returns {Promise<{url: string, localPort: number, remotePort: number}>}
   */
  async open(spec) {
    const {
      pool, machineId = '', command = 'dsh', profile = 'web',
      existingUrl = '', dshHome = '', waitSeconds = 45,
    } = spec || {}
    if (!pool) throw new Error('web-attach: a machine pool is required')
    this.machineId = String(machineId || '')
    this.command = command

    const exec = spec.exec || ((cmd, opts) => pool.exec(cmd, opts))
    // Connecting first also surfaces credential/host-key problems BEFORE we
    // start a remote process we would then have to clean up.
    this.client = await pool.connect()

    if (existingUrl) {
      const parsed = parseWebStart(`dsh web: ${existingUrl}`)
      if (!parsed) {
        throw new Error('web-attach: existing URL must look like http://127.0.0.1:<port>/?token=<token>')
      }
      this.remotePort = parsed.port
      this.token = parsed.token
    } else {
      this.tag = randomTag()
      const logPath = `${LOG_NAME}-${this.tag}.log`
      this.logPath = logPath
      const timeoutMs = Math.max(30000, (waitSeconds + 20) * 1000)
      let out = String(await this._launch(exec, { command, profile, logPath, dshHome, waitSeconds, timeoutMs }, false))
      // Older DSH (0.1.0-rc.6) has no `--no-open` and exits on the unknown flag
      // before doing anything. Retry once without it: `--no-open` is a nicety
      // (it stops the REMOTE from opening its own browser), not a requirement,
      // and a bounded single retry is safe because the first attempt provably
      // never started a server.
      if (launchFailed(out) && /unknown option/i.test(out) && /--no-open/.test(out)) {
        out = String(await this._launch(exec, { command, profile, logPath, dshHome, waitSeconds, timeoutMs }, true))
        this.omittedNoOpen = true
      }
      this.remotePid = parseRemotePid(out)
      const tail = out.split(TAIL_MARKER).slice(1).join(TAIL_MARKER).trim()
      // Both failure shapes carry the same diagnostics: the process either died
      // (its output is the whole story) or is still booting after the deadline.
      if (launchFailed(out)) {
        // The remote process is already gone — nothing to clean up.
        throw new Error('web-attach: the remote DSH exited during startup.'
          + explainLaunchFailure(tail || out)
          + ` ${tail || 'no output'}`)
      }
      const parsed = parseWebStart(out)
      if (!parsed) {
        // A timed-out launch may STILL be booting: the deadline expiring is not
        // evidence the process died. Kill it before throwing, or every retry
        // leaks another remote server (measured: three leftover `dsh --port 0`
        // processes after three failed attaches). A PID of 0 means the launcher
        // could not report one — nothing to target.
        if (this.remotePid > 0) {
          try {
            await exec(buildStopCommand(this.remotePid, logPath), { timeoutMs: 20000 })
            this.remotePid = 0
          } catch { /* the process may already be gone; a leftover is worse than a failed kill attempt only if it repeats, and the next attach replaces this session */ }
        }
        throw new Error(
          `web-attach: the remote DSH did not report a startup token within ${waitSeconds}s.`
          + ` Check that \`${command}\` exists on the remote and can boot a web profile.`
          + explainLaunchFailure(tail || out)
          + (tail ? ` Remote output: ${tail}` : ''),
        )
      }
      this.remotePort = parsed.port
      this.token = parsed.token
    }

    await this._listen()
    this.startedAt = Date.now()
    return this.describe()
  }

  /**
   * Run one launch attempt and return its raw output.
   *
   * @param {(cmd: string, opts?: object) => Promise<{stdout: string}>} exec - remote exec.
   * @param {object} d - launch parameters plus the exec timeout.
   * @param {boolean} omitNoOpen - drop `--no-open` for old DSH.
   * @returns {Promise<string>} the launcher's stdout.
   */
  async _launch(exec, d, omitNoOpen) {
    const cmd = buildLaunchCommand({ ...d, omitNoOpen })
    const res = await exec(cmd, { timeoutMs: d.timeoutMs })
    return String(res && res.stdout ? res.stdout : '')
  }

  /** Bind the local listener, advancing past ports already in use. */
  async _listen() {
    let lastError = null
    for (let i = 0; i < this.localPortMax; i++) {
      const port = this.localPortStart + i
      try {
        await this._listenOn(port)
        this.localPort = port
        return
      } catch (err) {
        lastError = err
        // Only a taken port is worth retrying; anything else (permissions,
        // an unusable interface) will not be fixed by the next number.
        if (err && err.code !== 'EADDRINUSE') break
      }
    }
    throw new Error(
      `web-attach: no free local port in ${this.localPortStart}..${this.localPortStart + this.localPortMax - 1}`
      + (lastError ? ` (${lastError.code || lastError.message})` : ''),
    )
  }

  _listenOn(port) {
    return new Promise((resolve, reject) => {
      const server = this.net.createServer((socket) => this._pipe(socket))
      const onError = (err) => {
        server.removeListener('listening', onListening)
        try { server.close() } catch { /* never listened */ }
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        // A post-bind error must not crash the host process: report and drop
        // the tunnel so the UI can show "disconnected" instead of dying.
        server.on('error', (err) => {
          this.server = null
          this.lastError = String((err && err.message) || err)
        })
        this.server = server
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // Loopback only: this endpoint reaches a full remote harness, so it must
      // never be reachable from the network even on a LAN-facing machine.
      server.listen(port, '127.0.0.1')
    })
  }

  /** Carry one local socket to the remote web port over SSH. */
  _pipe(socket) {
    if (!this.client) { try { socket.destroy() } catch { /* already gone */ } return }
    this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', this.remotePort, (err, channel) => {
      if (err) { try { socket.destroy() } catch { /* already gone */ } return }
      this.sockets.add(socket)
      socket.pipe(channel)
      channel.pipe(socket)
      const kill = () => {
        try { socket.destroy() } catch { /* already gone */ }
        try { channel.close() } catch { /* already closed */ }
        this.sockets.delete(socket)
      }
      socket.on('error', kill)
      channel.on('error', kill)
      socket.on('close', kill)
      channel.on('close', kill)
    })
  }

  /**
   * The URL to open, carrying the one-time launch token.
   *
   * The token is a credential, so it stays on loopback and is never sent
   * anywhere; DSH exchanges it for a 30-day signed cookie on the first request
   * and redirects to a clean `/`.
   */
  get url() {
    return `http://127.0.0.1:${this.localPort}/?token=${this.token}`
  }

  /** The clean URL (no token) — what the address bar shows after the exchange. */
  get cleanUrl() {
    return `http://127.0.0.1:${this.localPort}/`
  }

  /** Serializable status for the settings UI. */
  describe() {
    return {
      machineId: this.machineId,
      url: this.url,
      cleanUrl: this.cleanUrl,
      token: this.token,
      localPort: this.localPort,
      remotePort: this.remotePort,
      active: this.active,
      startedAt: this.startedAt,
      // Only a process we launched can be stopped by us; an attach onto the
      // user's own running instance is deliberately hands-off.
      managed: this.remotePid > 0,
      error: this.lastError || '',
    }
  }

  /**
   * Tear the tunnel down. The remote process is left running by default: the
   * user may be using that DSH elsewhere, and silently killing a process we did
   * not start is worse than a leftover one. `stopRemote` opts in.
   *
   * @param {object} [opts] - close options.
   * @param {boolean} [opts.stopRemote] - also terminate the remote process.
   * @param {(cmd: string) => Promise<unknown>} [opts.exec] - remote exec.
   */
  async close({ stopRemote = false, exec } = {}) {
    for (const socket of [...this.sockets]) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    this.sockets.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise((resolve) => server.close(() => resolve()))
    // Only a process we started has a recorded PID; an attach to the user's own
    // running instance must never signal anything.
    if (stopRemote && exec && this.remotePid) {
      await Promise.resolve(exec(buildStopCommand(this.remotePid, this.logPath))).catch(() => {})
    }
    this.client = null
  }
}
