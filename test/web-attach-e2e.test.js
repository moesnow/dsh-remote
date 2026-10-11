// Regression tests for the two web-attach defects found by the real E2E run.
//
// truncate-destroy: a bare `new SshPool({...})` without maxOutputChars made
//   EVERY exec result a 29-char truncation marker (NaN arithmetic), which
//   silently ate the web-attach startup token AND the probe facts — the whole
//   deploy+attach chain failed with misleading symptoms while the remote side
//   was working perfectly.
// leak-on-timeout: an attach that timed out waiting for the token threw BEFORE
//   recording/cleaning the PID, so every retry leaked another remote
//   `dsh --port 0` (measured: three leftovers after three failed attaches).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncate } from '../lib/paths.js'
import { WebAttach, buildLaunchCommand, buildStopCommand } from '../lib/web-attach.js'

// ── truncate must not destroy output on a bad cap ───────────────────────────

test('truncate with a missing cap returns the string untouched (was: destroyed it)', () => {
  const s = 'P_NODE=/usr/local/bin/node\nP_NODE_V=v24.21.0\ndsh web: http://127.0.0.1:3999/?token=abc'
  // The old code: 'x'.length <= undefined === false ⇒ always "truncate";
  // slice(0, undefined) is the whole string BUT s.length - undefined is NaN, so
  // real calls produced a 29-char marker and dropped everything.
  assert.equal(truncate(s, undefined), s, 'undefined cap must disable truncation')
  assert.equal(truncate(s, NaN), s, 'NaN cap must disable truncation')
  assert.equal(truncate(s, 0), s, 'zero cap must disable truncation')
  assert.equal(truncate(s, null), s, 'null cap must disable truncation')
})

test('truncate still truncates a real cap (and the marker counts correctly)', () => {
  const s = 'x'.repeat(300)
  const out = truncate(s, 100)
  assert.ok(out.startsWith('x'.repeat(100)), 'the first 100 chars survive')
  assert.match(out, /truncated: 200 more chars/, 'the marker reports the real remainder')
  assert.equal(truncate('short', 100), 'short', 'under the cap is returned as-is')
})

// ── a timed-out attach must kill the process it started ─────────────────────

/** An exec double that records every command it is handed. */
function recordingExec() {
  const commands = []
  return {
    commands,
    exec: async (cmd, opts) => {
      commands.push(cmd)
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

test('a timed-out attach kills the remote process before throwing (was: leaked it)', async () => {
  const rec = recordingExec()
  const attach = new WebAttach({ net: { createServer: () => { throw new Error('never gets there') } } })
  // A launcher output that names a PID but never printed a token line.
  const noTokenOutput = '__DSH_PID__=4242\n__DSH_TAIL__\n(some boot output without the line)'
  // Drive open() only as far as the parse: connect via a stubbed pool.
  const pool = { connect: async () => ({ end: () => {} }), exec: rec.exec }
  await assert.rejects(
    () => attach.open({
      pool, machineId: 'm', command: 'dsh', profile: 'web', waitSeconds: 1,
      // The launch goes through pool.exec; make it return the PID-only output.
      exec: async (cmd, opts) => { rec.commands.push(cmd); return { code: 0, stdout: noTokenOutput, stderr: '' } },
    }),
    /did not report a startup token/,
  )
  // THE assertion: the stop command targeting the reported PID must have run.
  const stop = rec.commands.find((c) => c.includes('__DSH_PID__') === false && /kill/.test(c) && c.includes('4242'))
  assert.ok(stop, 'the timed-out launch must be killed before throwing (leaked PIDs measured)')
})

test('a launch that died by itself is NOT sent a stop command', async () => {
  const rec = recordingExec()
  const attach = new WebAttach({ net: { createServer: () => { throw new Error('never gets there') } } })
  const diedOutput = '__DSH_REMOTE_DIED__\n__DSH_PID__=999\n__DSH_TAIL__\n(boot crash output)'
  const pool = { connect: async () => ({ end: () => {} }), exec: rec.exec }
  await assert.rejects(
    () => attach.open({
      pool, machineId: 'm', command: 'dsh', profile: 'web', waitSeconds: 1,
      exec: async (cmd, opts) => { rec.commands.push(cmd); return { code: 0, stdout: diedOutput, stderr: '' } },
    }),
    /exited during startup/,
  )
  const stop = rec.commands.find((c) => /kill/.test(c) && c.includes('999'))
  assert.equal(stop, undefined, 'an already-dead process needs no kill (and the remote is left clean)')
})

test('buildStopCommand still targets the process group and re-verifies the cmdline', () => {
  const cmd = buildStopCommand(4242, '.dsh-remote-web-x.log')
  assert.match(cmd, /kill -- -"\$P"/, 'signals the group (setsid makes PGID==PID)')
  assert.match(cmd, /case "\$C" in \*dsh\*\)/, 're-verifies the PID still looks like dsh before killing')
  assert.match(cmd, /rm -f "\$HOME\/\.dsh-remote-web-x\.log"/, 'removes the session log')
})
