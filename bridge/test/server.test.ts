import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskRegistry } from '../src/registry.ts'
import { startServer } from '../src/server.ts'
import type { BridgeEvent, TaskDetail, TaskSummary } from '../src/types.ts'
import { cleanupRepos, git, makePlainDir, makeRepo } from './helpers.ts'

const FAKE = join(import.meta.dirname, 'fake-agent.ts')
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')

type Env = { reg: TaskRegistry; events: BridgeEvent[]; port: number; token: string; log: () => string }
type Res = { status: number; body: any }

const closers: (() => Promise<void> | void)[] = []
const logDirs: string[] = []

async function boot(script: unknown[] = [{ writeFile: 'a.txt' }]): Promise<Env> {
  const logDir = mkdtempSync(join(tmpdir(), 'relay-srvlog-'))
  logDirs.push(logDir)
  const logFile = join(logDir, 'fake.log')
  process.env.RELAY_FAKE_AGENT = FAKE
  process.env.FAKE_LOG = logFile
  process.env.FAKE_SCRIPT = JSON.stringify(script)
  const events: BridgeEvent[] = []
  const reg = new TaskRegistry('unused', (e) => events.push(e))
  const srv = await startServer(reg)
  closers.push(async () => {
    await srv.close()
    await reg.shutdown()
  })
  return { reg, events, port: srv.port, token: srv.token, log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '') }
}

async function call(e: Env, method: string, path: string, body?: unknown, token: string | null = e.token): Promise<Res> {
  const res = await fetch(`http://127.0.0.1:${e.port}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const status = async (e: Env, id: string) => (await call(e, 'GET', `/tasks/${id}`)).body.status as string
const waitStatus = (e: Env, id: string, s: string) => waitFor(async () => (await status(e, id)) === s, `${id} to be ${s}`)

async function delegate(e: Env, repo: string, extra: object = {}): Promise<TaskSummary & { mainDirty: boolean }> {
  const r = await call(e, 'POST', '/tasks', { agent: 'opencode', title: 'Add a', brief: 'write a.txt', repoPath: repo, ...extra })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const k of ['RELAY_FAKE_AGENT', 'FAKE_SCRIPT', 'FAKE_LOG', 'FAKE_OPTIONS', 'FAKE_EFFORT_AFTER_MODEL', 'FAKE_HANG_INIT']) delete process.env[k]
  for (const d of logDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  await cleanupRepos()
})

describe('HTTP hardening', () => {
  it('401 without or with a wrong token', async () => {
    const e = await boot()
    expect((await call(e, 'GET', '/tasks', undefined, null)).status).toBe(401)
    expect((await call(e, 'GET', '/tasks', undefined, 'nope')).status).toBe(401)
    expect((await call(e, 'GET', '/tasks', undefined, e.token.slice(0, -1) + (e.token.endsWith('0') ? '1' : '0'))).status).toBe(401)
    expect((await call(e, 'GET', '/tasks')).status).toBe(200)
  })

  it('403 when the Host header is not loopback with our port', async () => {
    const e = await boot()
    const hit = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: e.port, path: '/tasks', headers: { host, authorization: `Bearer ${e.token}` } }, (res) => {
          res.resume()
          resolve(res.statusCode!)
        })
        req.on('error', reject)
        req.end()
      })
    expect(await hit('evil.example.com')).toBe(403)
    expect(await hit(`127.0.0.1:${e.port + 1}`)).toBe(403)
    expect(await hit(`127.0.0.1:${e.port}`)).toBe(200)
    expect(await hit(`localhost:${e.port}`)).toBe(200)
  })

  it('400 bad_json, 400 bad_request, 413 for oversized bodies, 404 unknown task and route', async () => {
    const e = await boot()
    const bad = await call(e, 'POST', '/tasks', '{not json')
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('bad_json')

    const bodies = [
      {},
      { agent: 'gpt', title: 't', brief: 'b', repoPath: 'x' },
      { agent: 'opencode', title: ' ', brief: 'b', repoPath: 'x' },
      { agent: 'opencode', title: 't', brief: '', repoPath: 'x' },
      { agent: 'opencode', title: 't', brief: 'b', repoPath: 5 },
      [1],
    ]
    for (const body of bodies) {
      const r = await call(e, 'POST', '/tasks', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.body.code).toBe('bad_request')
    }

    const big = await call(e, 'POST', '/tasks', JSON.stringify({ brief: 'x'.repeat(1024 * 1024 + 10) }))
    expect(big.status).toBe(413)

    expect((await call(e, 'GET', '/tasks/oc-99')).status).toBe(404)
    expect((await call(e, 'POST', '/tasks/oc-99/cancel')).status).toBe(404)
    expect((await call(e, 'GET', '/nope')).status).toBe(404)
  })

  it('500 without a stack trace for unexpected errors', async () => {
    const e = await boot()
    ;(e.reg as any).list = () => {
      throw new Error('boom at C:\\secret\\path')
    }
    const r = await call(e, 'GET', '/tasks')
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toMatch(/boom|secret|\bat \w/)
  })
})

describe('delegation', () => {
  it('non-repo path -> 400 not_a_repo and nothing is spawned', async () => {
    const e = await boot()
    const plain = await makePlainDir()
    const r = await call(e, 'POST', '/tasks', { agent: 'opencode', title: 't', brief: 'b', repoPath: plain })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('not_a_repo')
    expect(e.reg.list()).toEqual([])
    expect(e.log()).toBe('')
    expect(e.events).toEqual([])
  })

  it('delegate, poll to idle, read the diff, merge', async () => {
    const e = await boot()
    const repo = await makeRepo()
    const t = await delegate(e, repo)
    expect(t.id).toBe('oc-1')
    expect(t.mainDirty).toBe(false)
    expect(t.branch).toBe('relay/oc-1')

    await waitStatus(e, 'oc-1', 'idle')
    const detail = (await call(e, 'GET', '/tasks/oc-1')).body as TaskDetail
    expect(detail.brief).toBe('write a.txt')
    expect(detail.activity).toBeUndefined()
    expect(((await call(e, 'GET', '/tasks/oc-1?full=1')).body as TaskDetail).activity).toBeDefined()

    const d = await call(e, 'GET', '/tasks/oc-1/diff')
    expect(d.status).toBe(200)
    expect(d.body.stat).toContain('a.txt')
    expect(d.body.patch).toContain('written by fake agent')

    const m = await call(e, 'POST', '/tasks/oc-1/merge')
    expect(m.status).toBe(200)
    expect(m.body.ok).toBe(true)
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('relay: merge oc-1 Add a')
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)

    const list = (await call(e, 'GET', '/tasks')).body as TaskSummary[]
    expect(list.map((x) => x.id)).toEqual(['oc-1'])
    expect(e.events.some((x) => x.type === 'task')).toBe(true)
  })

  it('reports mainDirty when the main tree has uncommitted changes, and merge refuses', async () => {
    const e = await boot()
    const repo = await makeRepo()
    writeFileSync(join(repo, 'README.md'), 'edited\n')
    const t = await delegate(e, repo)
    expect(t.mainDirty).toBe(true)
    await waitStatus(e, t.id, 'idle')
    const m = await call(e, 'POST', `/tasks/${t.id}/merge`)
    expect(m.status).toBe(200)
    expect(m.body).toMatchObject({ ok: false, reason: 'dirty' })
  })

  it('does not wait for the first turn before answering POST /tasks', async () => {
    const e = await boot([{ hang: true }])
    const repo = await makeRepo()
    const t = await delegate(e, repo)
    expect(['starting', 'running']).toContain(t.status)
    expect(t.worktree).not.toBe('')
  })

  it('two delegations at once: ids oc-1 and oc-2, both idle, merges are serialised', async () => {
    const e = await boot()
    const repo = await makeRepo()
    const [a, b] = await Promise.all([delegate(e, repo, { title: 'First' }), delegate(e, repo, { title: 'Second' })])
    expect([a.id, b.id].sort()).toEqual(['oc-1', 'oc-2'])
    await Promise.all([waitStatus(e, 'oc-1', 'idle'), waitStatus(e, 'oc-2', 'idle')])

    const [m1, m2] = await Promise.all([call(e, 'POST', '/tasks/oc-1/merge'), call(e, 'POST', '/tasks/oc-2/merge')])
    expect(m1.body.ok, JSON.stringify(m1.body)).toBe(true)
    expect(m2.body.ok, JSON.stringify(m2.body)).toBe(true)
    expect(m1.body.commit).not.toBe(m2.body.commit)

    // linear history: the second merge sits directly on the first
    const log = (await git(repo, 'log', '--first-parent', '--format=%H %s', '-3')).split('\n')
    expect(log[0]).toMatch(/relay: merge oc-\d /)
    expect(log[1]).toMatch(/relay: merge oc-\d /)
    expect(log[2]).toContain('initial')
    expect(log.slice(0, 2).map((l) => l.split(' ')[0]).sort()).toEqual([m1.body.commit, m2.body.commit].sort())
  })

  it('skips ids whose branch or worktree survived an earlier bridge process', async () => {
    const repo = await makeRepo()
    const first = await boot()
    await delegate(first, repo)
    await delegate(first, repo)
    await Promise.all([waitStatus(first, 'oc-1', 'idle'), waitStatus(first, 'oc-2', 'idle')])
    await closers.pop()!() // the first bridge exits; relay/oc-1, relay/oc-2 and their worktrees remain
    expect(await git(repo, 'branch', '--list', 'relay/oc-*')).toContain('relay/oc-2')

    const second = await boot()
    const t = await delegate(second, repo)
    expect(t.id).toBe('oc-3')
    await waitStatus(second, 'oc-3', 'idle')

    // a leftover directory without a branch is skipped as well
    mkdirSync(join(repo, '.relay', 'wt', 'oc-4'), { recursive: true })
    const third = await boot()
    const [a, b] = await Promise.all([delegate(third, repo), delegate(third, repo)])
    expect([a.id, b.id].sort()).toEqual(['oc-5', 'oc-6'])
  })

  it('refuses to merge a task that is still working', async () => {
    const e = await boot([{ hang: true }])
    const repo = await makeRepo()
    const t = await delegate(e, repo)
    const m = await call(e, 'POST', `/tasks/${t.id}/merge`)
    expect(m.status).toBe(400)
    expect(m.body.code).toBe('task_busy')
  })
})

describe('conversation routes', () => {
  it('answer resolves a pending question, bad ids are 400', async () => {
    const e = await boot([
      [
        {
          permission: {
            toolCall: { toolCallId: 'q1', title: 'DB: pick one', kind: 'other', rawInput: { question: 'Which db?', options: ['sqlite', 'pg'] } },
            options: ['sqlite', 'pg'].map((n, i) => ({ optionId: `option_${i}`, name: n, kind: 'allow_once' })),
          },
        },
        { stop: 'end_turn' },
      ],
    ])
    const repo = await makeRepo()
    const t = await delegate(e, repo, { agent: 'commandcode' })
    expect(t.id).toBe('cc-1')
    await waitStatus(e, 'cc-1', 'asking')
    const detail = (await call(e, 'GET', '/tasks/cc-1')).body as TaskDetail
    const pending = detail.pending!
    expect(pending.type).toBe('question')

    expect((await call(e, 'POST', '/tasks/cc-1/answer', { requestId: pending.requestId })).status).toBe(400)
    const wrong = await call(e, 'POST', '/tasks/cc-1/answer', { requestId: pending.requestId, optionId: 'nope' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.code).toBe('bad_option')

    const ok = await call(e, 'POST', '/tasks/cc-1/answer', { requestId: pending.requestId, optionId: 'option_1', fromUser: true })
    expect(ok.status).toBe(200)
    await waitStatus(e, 'cc-1', 'idle')
    const after = (await call(e, 'GET', '/tasks/cc-1')).body as TaskDetail
    expect(after.lastMessage).toBe('answer:option_1')
    expect(after.thread.some((x) => x.kind === 'answer' && x.from === 'user')).toBe(true)
  })

  it('reply needs an idle task; escalate flags waitingOnUser; cancel ends the task', async () => {
    const msg = (text: string) => ({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
    const e = await boot([[{ writeFile: 'a.txt' }], [msg('second turn')]])
    const repo = await makeRepo()
    await delegate(e, repo)
    await waitStatus(e, 'oc-1', 'idle')

    expect((await call(e, 'POST', '/tasks/oc-1/reply', {})).status).toBe(400)
    const esc = await call(e, 'POST', '/tasks/oc-1/escalate', { question: 'Is X ok?' })
    expect(esc.status).toBe(200)
    expect(esc.body.waitingOnUser).toBe(true)
    expect((await call(e, 'POST', '/tasks/oc-1/escalate', {})).status).toBe(400)

    const rep = await call(e, 'POST', '/tasks/oc-1/reply', { text: 'yes', fromUser: true })
    expect(rep.status).toBe(200)
    await waitFor(async () => (await call(e, 'GET', '/tasks/oc-1')).body.lastMessage === 'second turn', 'second turn')
    await waitStatus(e, 'oc-1', 'idle')
    expect((await call(e, 'GET', '/tasks/oc-1')).body.waitingOnUser).toBe(false)

    const cancelled = await call(e, 'POST', '/tasks/oc-1/cancel')
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('cancelled')
    const again = await call(e, 'POST', '/tasks/oc-1/reply', { text: 'hi' })
    expect(again.status).toBe(400)
    expect(again.body.code).toBe('not_idle')
  })
})

describe('spend and models', () => {
  it('GET /spend sums cost per agent', async () => {
    const usage = { update: { sessionUpdate: 'usage_update', used: 1, size: 10, cost: { amount: 0.25, currency: 'USD' } } }
    const e = await boot([[usage, { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } }]])
    const repo = await makeRepo()
    await delegate(e, repo)
    await waitStatus(e, 'oc-1', 'idle')
    const s = await call(e, 'GET', '/spend')
    expect(s.status).toBe(200)
    expect(s.body.opencodeUsd).toBeCloseTo(0.25)
    expect(s.body.commandcodeUsd).toBe(0)
    expect(s.body.lastOutOfCreditsAt).toBeUndefined()
  })

  it('stamps lastOutOfCreditsAt when a task runs out of credits', async () => {
    const text = 'Insufficient credits. Please top up your Command Code balance.'
    const e = await boot([[{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }, { error: text }]])
    const repo = await makeRepo()
    const before = Date.now()
    await delegate(e, repo, { agent: 'commandcode' })
    await waitStatus(e, 'cc-1', 'out_of_credits')
    const s = await call(e, 'GET', '/spend')
    expect(s.body.lastOutOfCreditsAt).toBeGreaterThanOrEqual(before)
  })

  it('GET /agents/:agent/models returns configOptions, caches per agent, leaves no process behind', async () => {
    const e = await boot()
    const repo = await makeRepo()
    const r = await call(e, 'GET', `/agents/opencode/models?repo=${encodeURIComponent(repo)}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.map((o: any) => o.id)).toEqual(['model', 'effort'])
    const again = await call(e, 'GET', `/agents/opencode/models?repo=${encodeURIComponent(repo)}`)
    expect(again.body).toEqual(r.body)
    expect(e.log().match(/started pid=/g)).toHaveLength(1)
    const pid = Number(/started pid=(\d+)/.exec(e.log())![1])
    await waitFor(() => !alive(pid), 'probe agent to exit')
    expect(e.reg.list()).toEqual([])

    expect((await call(e, 'GET', '/agents/gpt/models')).status).toBe(400)
  })
})

describe('main.ts', () => {
  async function startMain(extraEnv: Record<string, string> = {}) {
    const logDir = mkdtempSync(join(tmpdir(), 'relay-mainlog-'))
    logDirs.push(logDir)
    const logFile = join(logDir, 'fake.log')
    const child = spawn(process.execPath, [MAIN], {
      env: { ...process.env, RELAY_FAKE_AGENT: FAKE, FAKE_LOG: logFile, FAKE_SCRIPT: JSON.stringify([{ hang: true }]), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    closers.push(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (out += c))
    child.stderr.on('data', (c: string) => (err += c))
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
    await waitFor(() => out.includes('\n'), `ready line (stderr: ${err})`, 30_000)
    const ready = JSON.parse(out.split('\n')[0]!)
    return { child, ready, exited, stderr: () => err, lines: () => out.split('\n').filter(Boolean), logFile }
  }

  async function runShutdown(how: (m: Awaited<ReturnType<typeof startMain>>) => void) {
    const m = await startMain()
    expect(m.ready.type).toBe('ready')
    expect(typeof m.ready.port).toBe('number')
    expect(m.ready.token).toMatch(/^[0-9a-f]{32,}$/)

    const repo = await makeRepo()
    const res = await fetch(`http://127.0.0.1:${m.ready.port}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${m.ready.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'opencode', title: 't', brief: 'b', repoPath: repo }),
    })
    expect(res.status).toBe(200)
    await waitFor(() => existsSync(m.logFile) && /started pid=\d+/.test(readFileSync(m.logFile, 'utf8')), 'fake agent start', 30_000)
    const pid = Number(/started pid=(\d+)/.exec(readFileSync(m.logFile, 'utf8'))![1])
    expect(alive(pid)).toBe(true)

    how(m)
    expect(await m.exited).toBe(0)
    await waitFor(() => !alive(pid), 'agent process to be gone')

    // every stdout line is JSON; after the ready line they are BridgeEvents
    const lines = m.lines().map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('ready')
    expect(lines.length).toBeGreaterThan(1)
    for (const ev of lines.slice(1)) expect(['task', 'activity', 'attention']).toContain(ev.type)
    expect(lines.slice(1).some((ev) => ev.type === 'task' && ev.task.status === 'cancelled')).toBe(true)
    // the branch survives
    expect(await git(repo, 'branch', '--list', 'relay/oc-1')).toContain('relay/oc-1')
  }

  for (const mode of ['throw', 'reject']) {
    it(`an uncaught ${mode} kills every agent and exits 1`, async () => {
      const m = await startMain({ RELAY_TEST_CRASH: mode })
      const repo = await makeRepo()
      const res = await fetch(`http://127.0.0.1:${m.ready.port}/tasks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${m.ready.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'opencode', title: 't', brief: 'b', repoPath: repo }),
      })
      expect(res.status).toBe(200)
      await waitFor(() => existsSync(m.logFile) && /started pid=\d+/.test(readFileSync(m.logFile, 'utf8')), 'fake agent start', 30_000)
      const pid = Number(/started pid=(\d+)/.exec(readFileSync(m.logFile, 'utf8'))![1])
      expect(await m.exited).toBe(1)
      expect(alive(pid)).toBe(false)
      expect(m.stderr()).toContain('killed 1 agent process tree(s)') // the handler killed it itself, not just the closing pipe
      expect(m.stderr()).toContain(mode === 'throw' ? 'injected exception' : 'injected rejection')
    }, 60_000)
  }

  it('prints the ready line, and exits 0 with the agent gone when stdin closes', async () => {
    await runShutdown((m) => m.child.stdin.end())
  }, 60_000)

  // Windows cannot deliver SIGTERM to a child as a catchable signal (it is a hard kill), so the signal path runs on POSIX only.
  it.skipIf(process.platform === 'win32')('exits 0 with the agent gone on SIGTERM', async () => {
    await runShutdown((m) => m.child.kill('SIGTERM'))
  }, 60_000)
})
