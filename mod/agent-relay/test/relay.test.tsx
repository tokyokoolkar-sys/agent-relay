import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Plugin, TestBody, TestOptions } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

import type { ActivityEntry, TaskSummary } from '../types'

const TOOL = (name: string): `mcp__agent-relay__${string}` => `mcp__agent-relay__${name}`
const TOOL_NAMES = [
  'relay_delegate',
  'relay_reply',
  'relay_answer',
  'relay_escalate',
  'relay_status',
  'relay_diff',
  'relay_merge',
  'relay_cancel',
  'relay_models',
  'relay_credits',
]
const SESSION = { cwd: 'E:/work/my repo', surface: 'terminal', isInteractive: true } as const
const DEFAULT_BRIDGE = 'E:/ataspace/aiPlayground/Communication/bridge/src/main.ts'
const PORT = 4567
const TOKEN = 'feedc0de'
const READY = { type: 'ready', port: PORT, token: TOKEN }
const BASE = `http://127.0.0.1:${PORT}`

/**
 * The test's `$` has no `state` noun, so an inline plugin reads the mod's state
 * for it: its tool answers with what each key of the mod's state holds.
 */
const PROBE: Plugin = {
  name: 'relay-probe',
  register(on) {
    on('tool.call', { tool: 'mcp__relay-probe__read' }, async $ => {
      const tasks = await $.state.get({ plugin: 'agent-relay', key: 'tasks' })
      const bridge = await $.state.get({ plugin: 'agent-relay', key: 'bridge' })
      const activity = await $.state.get({ plugin: 'agent-relay', key: 'activity' })
      const expanded = await $.state.get({ plugin: 'agent-relay', key: 'expanded' })

      return {
        result: JSON.stringify({
          tasks: tasks.value,
          bridge: bridge.value,
          activity: activity.value,
          expanded: expanded.value,
        }),
      }
    })
  },
}

type RelayState = {
  tasks?: TaskSummary[]
  bridge?: { status: string; error?: string }
  activity?: Record<string, ActivityEntry[]>
  expanded?: string | null
}

const stateOf = async ($: Engine): Promise<RelayState> =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__relay-probe__read' })).result)) as RelayState

/** Every test loads the probe beside the mod. */
const it = (name: string, body: TestBody, options: TestOptions = {}) => test(name, { plugins: [PROBE], ...options }, body)

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'cc-1',
  agent: 'commandcode',
  title: 'Add login',
  model: 'deepseek-v4',
  status: 'running',
  filesTouched: [],
  startedAt: 1,
  updatedAt: 2,
  costUsd: 0,
  waitingOnUser: false,
  branch: 'relay/cc-1',
  worktree: 'E:/work/my repo/.relay/wt/cc-1',
  ...over,
})

type Fetched = { url: string; method: string; headers: Record<string, string>; body: string | undefined }
type Reply = { status: number; body: unknown }

/** The bridge's stdout as the test scripts it: pieces pushed in, then the end. */
function pipe() {
  const queue: { stream: 'stdout' | 'stderr'; text: string }[] = []
  let wake: (() => void) | undefined
  let isClosed = false
  const rouse = () => {
    const w = wake
    wake = undefined
    w?.()
  }

  return {
    push: (text: string, stream: 'stdout' | 'stderr' = 'stdout') => {
      queue.push({ stream, text })
      rouse()
    },
    close: () => {
      isClosed = true
      rouse()
    },
    async *pieces(signal?: AbortSignal): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }> {
      signal?.addEventListener('abort', () => {
        isClosed = true
        rouse()
      })
      while (true) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (isClosed) return
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    },
  }
}

/** The engine beneath the mod, in memory: the bridge child, the network and the prompt. */
function worldOf(on: On) {
  const stdout = pipe()
  const world = {
    stdout,
    exit: { code: 0 as number | null, signal: null as string | null },
    /** When set, the child cannot start: the spawn is refused with this reason. */
    spawnDeny: undefined as string | undefined,
    spawned: [] as (readonly string[])[],
    registered: [] as { name: string; isDeferred: unknown; inputSchema: Record<string, unknown> }[],
    submitted: [] as string[],
    fetched: [] as Fetched[],
    toasts: [] as string[],
    logs: [] as string[],
    respond: (_req: Fetched): Reply => ({ status: 200, body: {} }),
    /** Writes one line of the bridge's stdout. */
    line: (obj: unknown) => stdout.push(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`),
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    world.registered.push({ name: e.name, isDeferred: e.isDeferred, inputSchema: e.inputSchema })

    return { value: { tool: TOOL(e.name) } }
  })
  on('prompt.submit', ($, e) => {
    world.submitted.push(e.text)

    return { text: e.text }
  })
  on('http.fetch', ($, e) => {
    const req: Fetched = {
      url: e.url,
      method: e.init?.method ?? 'GET',
      headers: e.init?.headers ?? {},
      body: e.init?.body,
    }
    world.fetched.push(req)
    const reply = world.respond(req)
    const value: HttpResponse = {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      text: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
    }

    return { value }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    world.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('process.spawn', async function* ($, e, next) {
    world.spawned.push(e.argv)
    if (world.spawnDeny !== undefined) return { deny: world.spawnDeny }
    for await (const piece of stdout.pieces(next.signal)) yield piece

    return { value: world.exit }
  })

  return world
}

type World = ReturnType<typeof worldOf>
/** A round trip through the engine, which lets the mod's bridge loop run on meanwhile. */
const tick = async ($: Engine) => {
  await $.tool.call({ tool: 'mcp__relay-probe__read' })
}

async function waitFor($: Engine, check: () => Promise<boolean> | boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await tick($)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Lets whatever the mod still has under way run, so a check that nothing more happened means it. */
async function settle($: Engine) {
  for (let i = 0; i < 20; i++) await tick($)
}

/** Starts the session and the bridge, up to its ready line. */
async function start($: Engine, world: World) {
  await $.session.start(SESSION)
  world.line(READY)
  await waitFor($, async () => (await stateOf($)).bridge?.status === 'up', 'the bridge to be up')
}

const tasksOf = async ($: Engine) => (await stateOf($)).tasks ?? []

describe('bridge lifecycle', () => {
  it('session.start registers the ten relay tools, eagerly, and spawns the bridge with node', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await waitFor($, () => world.spawned.length > 0, 'the spawn')

    expect(world.registered.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(world.registered.every(t => t.isDeferred === false)).toBe(true)
    expect(world.spawned).toEqual([['node', DEFAULT_BRIDGE]])
    expect((await stateOf($)).bridge).toEqual({ status: 'starting' })
    world.stdout.close()
  })

  it('the bridgePath option names the script node runs', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await waitFor($, () => world.spawned.length > 0, 'the spawn')

    expect(world.spawned).toEqual([['node', 'D:/elsewhere/main.ts']])
    world.stdout.close()
  }, { options: { bridgePath: 'D:/elsewhere/main.ts' } })

  it('the ready line brings the bridge up; lines split across pieces and non-JSON lines are handled', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    world.stdout.push('not json at all\n{"type":"rea')
    world.stdout.push(`dy","port":${PORT},"token":"${TOKEN}"}\r\n`)
    await waitFor($, async () => (await stateOf($)).bridge?.status === 'up', 'the bridge to be up')

    expect(world.logs.some(l => l.includes('not json at all'))).toBe(true)
    world.stdout.close()
  })

  it('a tool called before the ready line is denied', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    const r = await $.tool.call({ tool: TOOL('relay_status') })

    expect(r.deny).toBe('Agent relay bridge is not running (starting)')
    expect(world.fetched).toEqual([])
    world.stdout.close()
  })

  it('the loop ending sets the bridge down, toasts, and later tools are denied', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    world.exit = { code: 1, signal: null }
    world.stdout.close()
    await waitFor($, async () => (await stateOf($)).bridge?.status === 'down', 'the bridge to be down')

    const bridge = (await stateOf($)).bridge
    expect(bridge?.error).toBe('the bridge exited with code 1')
    expect(world.toasts).toContain('Agent relay bridge stopped')
    const r = await $.tool.call({ tool: TOOL('relay_status') })
    expect(r.deny).toBe('Agent relay bridge is not running (down: the bridge exited with code 1)')
  })

  it('a bridge that cannot start is down with the reason', async ($, on) => {
    const world = worldOf(on)
    world.spawnDeny = 'spawn node ENOENT'

    await $.session.start(SESSION)
    await waitFor($, async () => (await stateOf($)).bridge?.status === 'down', 'the bridge to be down')

    expect((await stateOf($)).bridge?.error).toContain('ENOENT')
    expect(world.toasts).toEqual(['Agent relay bridge stopped'])
  })

  it("the bridge's stderr goes to the debug log, line by line", async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    world.stdout.push('[server] first\n[server] sec', 'stderr')
    world.stdout.push('ond\n', 'stderr')
    await waitFor($, () => world.logs.some(l => l.includes('[server] second')), 'the stderr lines')

    expect(world.logs.filter(l => l.includes('[server]'))).toEqual([
      'agent-relay: bridge: [server] first',
      'agent-relay: bridge: [server] second',
    ])
    world.stdout.close()
  })
})

describe('events', () => {
  it('two task events for one id leave one entry with the latest status', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    world.line({ type: 'task', task: summary({ status: 'starting' }) })
    world.line({ type: 'task', task: summary({ id: 'oc-1', agent: 'opencode' }) })
    world.line({ type: 'task', task: summary({ status: 'idle', updatedAt: 9 }) })
    await waitFor($, async () => (await tasksOf($)).some(t => t.status === 'idle'), 'the second task event')

    const tasks = await tasksOf($)
    expect(tasks.map(t => [t.id, t.status])).toEqual([
      ['cc-1', 'idle'],
      ['oc-1', 'running'],
    ])
    expect(world.submitted).toEqual([])
    world.stdout.close()
  })

  it('activity is appended per task and capped at the last 200', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    for (let i = 0; i < 205; i++) {
      const entry: ActivityEntry = { at: i, kind: 'tool', text: `step ${i}` }
      world.line({ type: 'activity', taskId: 'cc-1', entry })
    }
    world.line({ type: 'activity', taskId: 'oc-1', entry: { at: 1, kind: 'thought', text: 'hm' } })
    await waitFor($, async () => ((await stateOf($)).activity ?? {})['oc-1'] !== undefined, 'the activity')

    const activity = (await stateOf($)).activity ?? {}
    expect(activity['cc-1']).toHaveLength(200)
    expect(activity['cc-1']?.[0]?.text).toBe('step 5')
    expect(activity['cc-1']?.[199]?.text).toBe('step 204')
    expect(activity['oc-1']).toHaveLength(1)
    expect(world.submitted).toEqual([])
    world.stdout.close()
  })

  it('a question wakes Claude once, naming the task, its agent and model', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    world.line({ type: 'task', task: summary({ status: 'asking' }) })
    world.line({ type: 'attention', taskId: 'cc-1', reason: 'question', text: 'Which database should I use?' })
    await waitFor($, () => world.submitted.length > 0, 'the wake')
    await settle($)

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toStartWith('[relay] cc-1')
    expect(world.submitted[0]).toBe('[relay] cc-1 (Command Code, deepseek-v4) question: Which database should I use?')
    world.stdout.close()
  })

  it('a turn end says to review; a task without a model reads "default model"', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    world.line({ type: 'task', task: summary({ id: 'oc-2', agent: 'opencode', model: undefined, status: 'idle' }) })
    world.line({ type: 'attention', taskId: 'oc-2', reason: 'turn_ended', text: 'Done: added the form.' })
    await waitFor($, () => world.submitted.length > 0, 'the wake')

    expect(world.submitted[0]).toBe(
      '[relay] oc-2 (OpenCode, default model) turn_ended: Done: added the form. Review with relay_status / relay_diff.',
    )
    world.stdout.close()
  })

  it('a long wake is cut to 600 characters with an ellipsis; the turn-end line still follows', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    world.line({ type: 'task', task: summary() })
    world.line({ type: 'attention', taskId: 'cc-1', reason: 'failed', text: 'x'.repeat(1000) })
    world.line({ type: 'attention', taskId: 'cc-1', reason: 'turn_ended', text: 'y'.repeat(1000) })
    await waitFor($, () => world.submitted.length > 1, 'the wakes')

    const [failed, ended] = world.submitted
    expect(failed).toHaveLength(600)
    expect(failed).toEndWith('x…')
    expect(ended).toEndWith('y… Review with relay_status / relay_diff.')
    expect(ended?.length).toBe(600 + ' Review with relay_status / relay_diff.'.length)
    world.stdout.close()
  })

  it("a permission wake keeps the bridge's whole text, its truncation notice included", async ($, on) => {
    const world = worldOf(on)
    const text = `Bash: ${'z'.repeat(500)}…[truncated, 900 chars — read relay_status {taskId, full:true} before approving]`

    await start($, world)
    world.line({ type: 'task', task: summary({ status: 'waiting_permission' }) })
    world.line({ type: 'attention', taskId: 'cc-1', reason: 'permission', text })
    await waitFor($, () => world.submitted.length > 0, 'the wake')

    expect(world.submitted[0]).toBe(`[relay] cc-1 (Command Code, deepseek-v4) permission: ${text}`)
    world.stdout.close()
  })
})

describe('tools', () => {
  it('relay_delegate posts to /tasks with the bearer token and returns the summary', async ($, on) => {
    const world = worldOf(on)
    world.respond = () => ({ status: 200, body: { ...summary({ status: 'starting' }), mainDirty: false } })

    await start($, world)
    const r = await $.tool.call({
      tool: TOOL('relay_delegate'),
      agent: 'commandcode',
      title: 'Add login',
      brief: 'Build the login form.',
      repoPath: 'E:/work/my repo',
      model: 'deepseek-v4',
    })

    expect(world.fetched).toHaveLength(1)
    const req = world.fetched[0]
    expect(req?.url).toBe(`${BASE}/tasks`)
    expect(req?.method).toBe('POST')
    expect(req?.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      agent: 'commandcode',
      title: 'Add login',
      brief: 'Build the login form.',
      repoPath: 'E:/work/my repo',
      model: 'deepseek-v4',
    })
    expect(r.deny).toBeUndefined()
    expect(String(r.result)).toContain('"id":"cc-1"')
    expect(String(r.result)).not.toContain('uncommitted')
    world.stdout.close()
  })

  it('relay_delegate tells Claude when the main tree has uncommitted changes', async ($, on) => {
    const world = worldOf(on)
    world.respond = () => ({ status: 200, body: { ...summary({ status: 'starting' }), mainDirty: true } })

    await start($, world)
    const r = await $.tool.call({
      tool: TOOL('relay_delegate'),
      agent: 'opencode',
      title: 't',
      brief: 'b',
      repoPath: 'E:/work/my repo',
    })

    expect(String(r.result)).toContain('uncommitted changes')
    world.stdout.close()
  })

  it("an HTTP 400 becomes a deny carrying the bridge's message", async ($, on) => {
    const world = worldOf(on)
    world.respond = () => ({ status: 400, body: { error: 'repoPath must be an absolute path', code: 'bad_request' } })

    await start($, world)
    const r = await $.tool.call({
      tool: TOOL('relay_delegate'),
      agent: 'opencode',
      title: 't',
      brief: 'b',
      repoPath: 'relative/path',
    })

    expect(r.deny).toContain('repoPath must be an absolute path')
    world.stdout.close()
  })

  it('each tool reaches its route', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    const calls: [string, Record<string, unknown>][] = [
      ['relay_reply', { taskId: 'cc-1', text: 'Use Postgres.' }],
      ['relay_reply', { taskId: 'cc-1', text: 'The user says: SQLite.', fromUser: true }],
      ['relay_answer', { taskId: 'cc-1', requestId: 'r1', optionId: 'allow', note: 'fine' }],
      ['relay_escalate', { taskId: 'cc-1', question: 'Which DB?' }],
      ['relay_status', {}],
      ['relay_status', { taskId: 'cc-1' }],
      ['relay_status', { taskId: 'cc-1', full: true }],
      ['relay_diff', { taskId: 'cc-1' }],
      ['relay_merge', { taskId: 'cc-1' }],
      ['relay_cancel', { taskId: 'cc-1' }],
      ['relay_models', { agent: 'opencode' }],
      ['relay_credits', {}],
    ]
    for (const [name, args] of calls) {
      const r = await $.tool.call({ tool: TOOL(name), ...args })
      expect(r.deny, name).toBeUndefined()
    }

    expect(world.fetched.map(f => `${f.method} ${f.url}`)).toEqual([
      `POST ${BASE}/tasks/cc-1/reply`,
      `POST ${BASE}/tasks/cc-1/reply`,
      `POST ${BASE}/tasks/cc-1/answer`,
      `POST ${BASE}/tasks/cc-1/escalate`,
      `GET ${BASE}/tasks`,
      `GET ${BASE}/tasks/cc-1`,
      `GET ${BASE}/tasks/cc-1?full=1`,
      `GET ${BASE}/tasks/cc-1/diff`,
      `POST ${BASE}/tasks/cc-1/merge`,
      `POST ${BASE}/tasks/cc-1/cancel`,
      `GET ${BASE}/agents/opencode/models?repo=${encodeURIComponent(SESSION.cwd)}`,
      `GET ${BASE}/spend`,
    ])
    const bodies = world.fetched.map(f => (f.body === undefined ? undefined : JSON.parse(f.body)))
    expect(bodies[0]).toEqual({ text: 'Use Postgres.' })
    expect(bodies[1]).toEqual({ text: 'The user says: SQLite.', fromUser: true })
    expect(bodies[2]).toEqual({ requestId: 'r1', optionId: 'allow', note: 'fine' })
    expect(bodies[3]).toEqual({ question: 'Which DB?' })
    expect(world.fetched.every(f => f.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true)
    world.stdout.close()
  })

  it('relay_status with a task id returns the pending request whole; relay_credits returns /spend as is', async ($, on) => {
    const world = worldOf(on)
    const rawInput = { command: 'npm install left-pad', note: 'q'.repeat(2000) }
    const spend = { commandcodeUsd: 0.25, opencodeUsd: 0, lastOutOfCreditsAt: 1234 }
    world.respond = req =>
      req.url.endsWith('/spend')
        ? { status: 200, body: spend }
        : {
            status: 200,
            body: {
              ...summary({ status: 'waiting_permission' }),
              pending: { requestId: 'r1', type: 'permission', title: 'Bash', rawInput, options: [] },
            },
          }

    await start($, world)
    const status = await $.tool.call({ tool: TOOL('relay_status'), taskId: 'cc-1' })
    const credits = await $.tool.call({ tool: TOOL('relay_credits') })

    expect(JSON.parse(String(status.result)).pending.rawInput).toEqual(rawInput)
    expect(JSON.parse(String(credits.result))).toEqual(spend)
    world.stdout.close()
  })

  it('a 404 and an unreachable bridge are denied with the reason', async ($, on) => {
    const world = worldOf(on)
    world.respond = () => ({ status: 404, body: { error: 'no task cc-9', code: 'no_such_task' } })

    await start($, world)
    const missing = await $.tool.call({ tool: TOOL('relay_diff'), taskId: 'cc-9' })
    expect(missing.deny).toContain('no task cc-9')

    world.respond = () => {
      throw new Error('connect ECONNREFUSED')
    }
    const down = await $.tool.call({ tool: TOOL('relay_merge'), taskId: 'cc-1' })
    expect(down.deny).toBeDefined()
    world.stdout.close()
  })

  it('a call missing a required argument is denied without reaching the bridge', async ($, on) => {
    const world = worldOf(on)

    await start($, world)
    const r = await $.tool.call({ tool: TOOL('relay_reply'), taskId: 'cc-1' })

    expect(r.deny).toContain('text')
    expect(world.fetched).toEqual([])
    world.stdout.close()
  })
})
