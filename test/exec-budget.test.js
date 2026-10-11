// rw_exec 执行预算回归（"20 秒超时"修复）：默认预算取 execTimeoutMs 而非
// commandTimeoutMs；per-call timeoutMs 生效且钳制；exec.signal 传到 SSH 层；
// 超时给出可执行的下一步。SSH 网络出口换成观测桩，其余都走真实代码。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshPool } from '../lib/pool.js'

/** Isolated DSH_HOME with one machine + one workspace mirror (the session cwd). */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-exec-budget-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    path.join(root, 'machines.json'),
    JSON.stringify({
      list: [{ id: 'm1', name: 'box', host: '127.0.0.11', port: 1, username: 'dev', password: 'pw' }],
      currentId: '',
    }),
  )
  const cwd = path.join(root, '127.0.0.11-dev-1', 'proj')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    path.join(cwd, '.dsh-remote-meta.json'),
    JSON.stringify({ host: '127.0.0.11', port: 1, username: 'dev', remotePath: '/home/dev/proj' }),
  )
  return { home, cwd }
}

function makeCtx() {
  const tools = new Map()
  return {
    ctx: {
      effect: () => {},
      inject: () => {},
      get: () => undefined,
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
  }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '',
  commandTimeoutMs: 1500, // 探测预算：刻意与执行预算不同，才能钉住"不再共用"
  execTimeoutMs: 120000,
  execMaxTimeoutMs: 1800000,
  connectTimeoutMs: 1200, maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

/** Load apply() against an isolated home; hand back the registered rw_* tools. */
async function loadTools(home) {
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?execbudget=${Math.random()}`)
  const { ctx, tools } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { mod, tools }
}

/** Replace the SSH network surface with an observing stub. Restores on exit. */
function stubSsh(record) {
  const originals = {
    connect: SshPool.prototype.connect,
    detect: SshPool.prototype.detect,
    exec: SshPool.prototype.exec,
  }
  SshPool.prototype.connect = async () => { throw new Error('network disabled in tests') }
  SshPool.prototype.detect = async function () {
    this.platform = 'posix'
    this.shellMode = 'native'
    this.gitBashPath = ''
  }
  SshPool.prototype.exec = async (command, opts) => {
    record.calls.push({ command, opts })
    return record.reply ? record.reply() : { code: 0, stdout: 'ok\n', stderr: '' }
  }
  return () => Object.assign(SshPool.prototype, originals)
}

const execFor = (cwd, extra = {}) => ({ agent: { session: { header: { cwd } } }, ...extra })

test('the rw_exec budget comes from execTimeoutMs, never from commandTimeoutMs', async () => {
  const { home, cwd } = makeHome()
  const record = { calls: [] }
  const restore = stubSsh(record)
  try {
    const { tools } = await loadTools(home)
    const run = tools.get('rw_exec')
    assert.ok(run, 'rw_exec must be registered')

    await run.execute({ command: 'make build' }, execFor(cwd))
    const used = record.calls.at(-1).opts.timeoutMs
    assert.equal(used, CONFIG.execTimeoutMs,
      `rw_exec must budget from execTimeoutMs (${CONFIG.execTimeoutMs}), got ${used}`)
    assert.notEqual(used, CONFIG.commandTimeoutMs,
      'rw_exec must NOT share the probe budget (that is the 20s-timeout regression)')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the per-call timeoutMs is honored and clamped into [1s, execMaxTimeoutMs]', async () => {
  const { home, cwd } = makeHome()
  const record = { calls: [] }
  const restore = stubSsh(record)
  try {
    const { tools } = await loadTools(home)
    const run = tools.get('rw_exec')
    const budgetOf = async (timeoutMs) => {
      const args = timeoutMs === undefined ? { command: 'make build' } : { command: 'make build', timeoutMs }
      await run.execute(args, execFor(cwd))
      return record.calls.at(-1).opts.timeoutMs
    }

    assert.equal(await budgetOf(45000), 45000, 'an explicit budget within range is used verbatim')
    assert.equal(await budgetOf(3_600_000), CONFIG.execMaxTimeoutMs, 'above the ceiling → clamped to the ceiling')
    assert.equal(await budgetOf(5), 1000, 'below the floor → clamped to 1s')
    assert.equal(await budgetOf(0), CONFIG.execTimeoutMs, '0 means "unset", not "no timeout"')
    assert.equal(await budgetOf(undefined), CONFIG.execTimeoutMs, 'omitted → the default budget')
    // 非整数由 schema 层直接拒绝（比静默换算更早、更明确）。
    await assert.rejects(() => budgetOf('not-a-number'), /must be an integer/)
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('exec.signal reaches the SSH layer (cancel/steer must stop the remote command)', async () => {
  const { home, cwd } = makeHome()
  const record = { calls: [] }
  const restore = stubSsh(record)
  try {
    const { tools } = await loadTools(home)
    const ac = new AbortController()
    await tools.get('rw_exec').execute({ command: 'make build' }, execFor(cwd, { signal: ac.signal }))
    assert.equal(record.calls.at(-1).opts.signal, ac.signal,
      'the caller\'s AbortSignal must be handed to pool.exec, else a cancelled turn leaves the command running')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a timeout answers with an actionable next step, not just "timed out"', async () => {
  const { home, cwd } = makeHome()
  const record = {
    calls: [],
    reply: () => ({ code: -1, signal: 'TIMEOUT', stdout: 'partial build log\n', stderr: '' }),
  }
  const restore = stubSsh(record)
  try {
    const { tools } = await loadTools(home)
    const { text } = await tools.get('rw_exec').execute({ command: 'make build' }, execFor(cwd))

    assert.match(text, /partial build log/, 'the partial output must survive the timeout')
    assert.match(text, /command timed out after 120000ms and was killed/,
      'the model must know the command is dead and the output is partial')
    assert.match(text, /retry with timeoutMs: 600000/,
      'the message must name the exact budget to retry with — a bare "timed out" is what caused blind retries')
    assert.match(text, /nohup/, 'work that outlives the ceiling needs a detach escape hatch')
    assert.match(text, /rw_read_file/, 'the detach escape hatch must say how to poll the result')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the retry suggestion never exceeds the ceiling and says so', async () => {
  const { home, cwd } = makeHome()
  const record = {
    calls: [],
    reply: () => ({ code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' }),
  }
  const restore = stubSsh(record)
  try {
    const { tools } = await loadTools(home)
    // 预算顶到上限时，建议值必须停在上限并明说，否则模型会去要一个永远无效的更大值。
    const { text } = await tools.get('rw_exec').execute({ command: 'make', timeoutMs: 1800000 }, execFor(cwd))
    assert.match(text, /command timed out after 1800000ms/)
    assert.match(text, /retry with timeoutMs: 1800000 \(the ceiling\)/)
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an aborted run reports cancellation instead of a fake exit code', async () => {
  const { home, cwd } = makeHome()
  const record = {
    calls: [],
    reply: () => ({ code: -1, signal: 'ABORTED', stdout: '', stderr: '' }),
  }
  const restore = stubSsh(record)
  try {
    const { tools } = await loadTools(home)
    const { text } = await tools.get('rw_exec').execute({ command: 'make' }, execFor(cwd))
    assert.match(text, /cancelled — the remote command was stopped/)
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_exec declares a positive timeoutMs (the policy only guards tools that declare one)', async () => {
  // @deepseek-ai/dsh-tool-call-timeout-policy 对**没有** timeoutMs 的工具完全不设防
  // （`if (timeoutMs === void 0) return next()`）。声明值取上限：per-call 预算可能
  // 合法地超过默认预算，按默认值申报会把这类结果顶成光秃秃的 TOOL_TIMEOUT。
  const mod = await import('../lib/index.js?execbudget-schema=1')
  const resolved = typeof mod.Config === 'function' ? new mod.Config({}) : mod.Config
  assert.ok(Number.isFinite(resolved.execTimeoutMs) && resolved.execTimeoutMs > 0,
    `schema default for execTimeoutMs must be a positive number, got ${resolved.execTimeoutMs}`)
  assert.ok(Number.isFinite(resolved.execMaxTimeoutMs) && resolved.execMaxTimeoutMs > 0,
    `schema default for execMaxTimeoutMs must be a positive number, got ${resolved.execMaxTimeoutMs}`)

  const { home } = makeHome()
  const restore = stubSsh({ calls: [] })
  try {
    const { tools } = await loadTools(home)
    const run = tools.get('rw_exec')
    assert.ok(Number.isFinite(run.timeoutMs) && run.timeoutMs > 0,
      `rw_exec.timeoutMs must be a positive number (the policy validates it), got ${run.timeoutMs}`)
    assert.equal(run.timeoutMs, CONFIG.execMaxTimeoutMs, 'the declaration must be the ceiling, not the default budget')
    assert.ok(run.parameters.properties.timeoutMs, 'rw_exec must accept a per-call timeoutMs')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})
