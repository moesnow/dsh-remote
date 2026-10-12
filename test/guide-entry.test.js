// The native right sidebar's guide page draws one capsule per registered guide
// entry — the「远程文件」button. In a session WITHOUT a remote workspace that
// capsule is a doorway to a tab that can only say「当前会话是本地工作区」, so it
// must not be offered at all: the button showed, and opening it only produced
// that message.
//
// The guide-entry seat is session-scoped, and the card behind it decides per
// session through /dsh-remote/resolve-mirror — the same source of truth the
// explorer tree uses. "Cannot prove remote ⇒ do not offer" (the tool-visibility
// rule): a local cwd, a failed probe or a missing session id all hide the card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SETTINGS = 'settings.section'
const GUIDE_ENTRY = 'sidebar.right.tab.guide.entry'
const CAPSULE = GUIDE_ENTRY + ':dsh-remote/explorer'
const KIND = 'dsh-remote/explorer'

// ── harness ─────────────────────────────────────────────────────────────────
// Same dependency/slot doubles as client-lifecycle.test.js, plus a React stub
// whose hooks keep state between renders (a component body is called twice to
// observe the async decision) and honour useEffect deps like the real thing.

function dependencies(initial = []) {
  const values = new Map(initial)
  const watchers = new Set()
  function reconcile(watcher) {
    const ready = watcher.names.every((name) => values.has(name))
    if (watcher.active && !ready) {
      watcher.active = false
      watcher.cleanup?.()
    } else if (!watcher.active && ready) {
      watcher.active = true
      watcher.cleanup = watcher.callback()
    }
  }
  return {
    values,
    set(name, value) {
      values.set(name, value)
      for (const watcher of watchers) reconcile(watcher)
    },
    remove(name) {
      values.delete(name)
      for (const watcher of watchers) reconcile(watcher)
    },
    inject(names, callback) {
      const watcher = { names: Array.isArray(names) ? [...names] : [names], callback, active: false }
      watchers.add(watcher)
      reconcile(watcher)
      return () => {
        watchers.delete(watcher)
        if (watcher.active) {
          watcher.active = false
          watcher.cleanup?.()
        }
      }
    },
  }
}

function createHost(seats = []) {
  const slotsAvailable = dependencies(seats.map((name) => [name, true]))
  const services = dependencies()
  const registrations = new Map()
  function scope() {
    const cleanups = []
    return {
      get(name) { return services.values.get(name) },
      effect(callback) {
        const cleanup = callback()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      inject(names, callback) {
        const dispose = services.inject(names, () => {
          const inner = scope()
          inner.effect(() => callback(inner))
          return () => inner.dispose()
        })
        cleanups.push(dispose)
        return dispose
      },
      own(cleanup) { cleanups.push(cleanup); return cleanup },
      dispose() { for (const cleanup of cleanups.splice(0).reverse()) cleanup() },
    }
  }
  const ctx = scope()
  services.set('slots', {
    inject(names, callback) { return ctx.own(slotsAvailable.inject(names, callback)) },
    register(meta, render) {
      const key = meta.key ? meta.name + ':' + meta.key : meta.name
      assert.ok(slotsAvailable.values.has(meta.name), 'registration must wait for its seat')
      assert.ok(!registrations.has(key), 'no duplicate remote contribution')
      const entry = { meta, render }
      registrations.set(key, entry)
      return () => { if (registrations.get(key) === entry) registrations.delete(key) }
    },
  })
  services.set('locale', {
    register() { return () => {} },
    bind() { return (key) => key },
  })
  return { ctx, services, slotsAvailable, registrations }
}

// A React stub with real-enough hooks: state persists across renders of the one
// component under test, effects run on demand and re-run only when their deps
// change (which is what the card's cwd signal relies on).
function statefulReact() {
  const hooks = { cursor: 0, state: {}, deps: {}, cleanups: {}, effects: [] }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) {
      const i = hooks.cursor++
      if (!(i in hooks.state)) hooks.state[i] = init
      return [hooks.state[i], (v) => { hooks.state[i] = typeof v === 'function' ? v(hooks.state[i]) : v }]
    },
    useEffect(fn, deps) {
      const i = hooks.cursor++
      const prev = hooks.deps[i]
      const same = prev !== undefined && deps !== undefined && prev.length === deps.length &&
        deps.every((d, j) => Object.is(d, prev[j]))
      hooks.deps[i] = deps
      if (!same) hooks.effects.push({ i, fn })
    },
  }
  return { React, hooks }
}

function loadClient(fetchImpl) {
  const { React, hooks } = statefulReact()
  const requests = []
  let plugin
  const localStorage = {
    getItem: () => null,
    setItem: () => {},
    get length() { return 0 },
    key: () => null,
    removeItem: () => {},
  }
  vm.runInNewContext(source, {
    window: {
      location: { protocol: 'https:' },
      localStorage,
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-remote')
          plugin = factory((name) => {
            assert.equal(name, 'react', 'bundle requires only its declared React external')
            return React
          })
        },
      },
    },
    navigator: { languages: ['en'], platform: 'Linux x86_64' },
    URL,
    console,
    fetch: async (url, options) => {
      requests.push({ url, options })
      return fetchImpl(url)
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'classic module loader receives the plugin')
  return {
    plugin,
    requests,
    hooks,
    render(entry, props) {
      hooks.cursor = 0
      hooks.effects.length = 0
      return entry.render(props)
    },
    runEffects() {
      for (const { i, fn } of hooks.effects.splice(0)) {
        if (typeof hooks.cleanups[i] === 'function') hooks.cleanups[i]()
        hooks.cleanups[i] = fn() || undefined
      }
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  }
}

const json = (body) => async () => ({ ok: true, json: async () => body })

/** Every string inside an element tree (the capsule's rendered text). */
function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

// The seat's own props: sessionId from the registration's inject, kind/title
// from the guide declaration, useTabInfo/useSessions from the host's kit.
function capsuleProps(sessionId, { cwd = '', openTab = () => {} } = {}) {
  return {
    sessionId,
    kind: KIND,
    title: '远程文件',
    useTabInfo: () => ({ tab: { actions: { openTab } } }),
    useSessions: (select) => select({ byId: cwd ? { [sessionId]: { cwd } } : {} }),
  }
}

async function mounted(fetchBody, options = {}) {
  const client = loadClient(typeof fetchBody === 'function' ? fetchBody : json(fetchBody))
  const host = createHost([SETTINGS, GUIDE_ENTRY])
  client.plugin.apply(host.ctx)
  host.services.set('sidebarRightTabs', { register: () => () => {} })
  if (options.cwd !== undefined) {
    host.services.set('sessions', { list: { getSnapshot: () => ({ byId: { s1: { cwd: options.cwd } } }) } })
  }
  const entry = host.registrations.get(CAPSULE)
  assert.ok(entry, 'the guide capsule registers under the explorer type id')
  return { ...client, host, entry }
}

// ── tests ───────────────────────────────────────────────────────────────────

test('a local session is offered no remote-files capsule at all', async () => {
  const { requests, render, runEffects, settle, entry } = await mounted({})
  assert.equal(entry.meta.inject('s1').sessionId, 's1', 'the capsule is bound to its session')
  assert.equal(render(entry, capsuleProps('s1')), null, 'nothing is offered before the probe answers')
  runEffects()
  await settle()
  assert.equal(requests.at(-1).url, '/dsh-remote/resolve-mirror?sessionId=s1')
  assert.equal(render(entry, capsuleProps('s1')), null,
    'a session without a remote workspace must not offer the capsule')
  // An unchanged session re-renders without probing again.
  const probes = requests.length
  assert.equal(render(entry, capsuleProps('s1')), null)
  runEffects()
  assert.equal(requests.length, probes, 'the probe runs per session/cwd, not per render')
})

test('a remote session gets a capsule that opens the explorer page', async () => {
  const opened = []
  const { requests, render, runEffects, settle, entry } = await mounted(
    { remotePath: '/home/os/proj' },
    { cwd: 'mirror/proj' },
  )
  const props = () => capsuleProps('s1', { cwd: 'mirror/proj', openTab: (...a) => opened.push(a) })
  render(entry, props())
  runEffects()
  await settle()
  assert.equal(requests.at(-1).url, '/dsh-remote/resolve-mirror?local=mirror%2Fproj',
    'the session cwd is what resolve-mirror maps')
  const capsule = render(entry, props())
  assert.equal(capsule.type, 'button')
  assert.equal(capsule.props.className, 'dsh-rw-guide-entry')
  assert.equal(capsule.props['data-sidebar-right-guide-entry'], KIND)
  assert.ok(textOf(capsule).includes('远程文件'), 'the capsule carries the guide entry title')
  capsule.props.onClick()
  // The call crosses the VM realm boundary (like every array here), so compare
  // fields, not object prototypes.
  assert.equal(opened.length, 1)
  assert.equal(opened[0][0], KIND, 'picking the capsule opens the explorer page')
  assert.equal(opened[0][1].replaceTab, true, 'the guide gives way to the page it opened')
})

test('a workspace attached later re-decides without reopening the guide', async () => {
  let body = {}
  const { requests, render, runEffects, settle, entry, host } = await mounted(() => json(body)(), {})
  // The session's cwd travels through the sessions service (what the probe
  // reads) — it changes when the workspace is attached.
  let sessionCwd = ''
  host.services.set('sessions', { list: { getSnapshot: () => ({ byId: { s1: { cwd: sessionCwd } } }) } })
  const props = () => capsuleProps('s1', { cwd: sessionCwd })
  render(entry, props())
  runEffects()
  await settle()
  assert.equal(render(entry, props()), null, 'no remote workspace yet, no capsule')

  // The session store notifies a new cwd — the card re-probes on that signal.
  body = { remotePath: '/home/os/proj' }
  sessionCwd = 'mirror/proj'
  const before = requests.length
  render(entry, props())
  runEffects()
  await settle()
  assert.ok(requests.length > before, 'a new cwd re-runs the probe')
  assert.equal(requests.at(-1).url, '/dsh-remote/resolve-mirror?local=mirror%2Fproj')
  const capsule = render(entry, props())
  assert.equal(capsule.type, 'button', 'the capsule appears once the session turns out remote')
})

test('a failed probe keeps the capsule hidden', async () => {
  const { render, runEffects, settle, entry } = await mounted(async () => { throw new Error('host down') })
  const props = () => capsuleProps('s1')
  render(entry, props())
  runEffects()
  await settle()
  assert.equal(render(entry, props()), null,
    'an unprovable session must not be offered the capsule')
})
