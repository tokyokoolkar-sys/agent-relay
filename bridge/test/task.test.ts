import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSpec } from '../src/agents.ts'
import { Task } from '../src/task.ts'
import type { AgentId, BridgeEvent, DelegateRequest } from '../src/types.ts'
import { cleanupRepos, git, makeRepo } from './helpers.ts'

const FAKE = join(import.meta.dirname, 'fake-agent.ts')
const ccOptions = ['allow_once', 'allow_always', 'reject_once', 'reject_always'].map((k) => ({ optionId: k, name: k, kind: k }))

const tasks: Task[] = []
const logDirs: string[] = []

const msg = (text: string) => ({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
const thought = (text: string) => ({ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } })
const usage = (amount: number) => ({ update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount, currency: 'USD' } } })

type Made = { task: Task; repo: string; events: BridgeEvent[]; wt: string; log: () => string }

async function make(scriptOrFn: unknown[] | ((wt: string) => unknown[]), opts: { agent?: AgentId; req?: Partial<DelegateRequest>; env?: Record<string, string>; handshakeTimeoutMs?: number } = {}): Promise<Made> {
  const agent = opts.agent ?? 'opencode'
  const logDir = mkdtempSync(join(tmpdir(), 'relay-fakelog-'))
  logDirs.push(logDir)
  const logFile = join(logDir, 'fake.log')
  process.env.RELAY_FAKE_AGENT = FAKE
  process.env.FAKE_LOG = logFile
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v
  const repo = await makeRepo()
  const id = agent === 'opencode' ? 'oc-1' : 'cc-1'
  const wt = join(repo, '.relay', 'wt', id)
  process.env.FAKE_SCRIPT = JSON.stringify(typeof scriptOrFn === 'function' ? scriptOrFn(wt) : scriptOrFn)
  const events: BridgeEvent[] = []
  const task = new Task({
    id,
    spec: agentSpec(agent, 'unused'),
    req: { agent, title: 'Do the thing', brief: 'please do the thing', repoPath: repo, ...opts.req },
    emit: (e) => events.push(e),
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
  })
  tasks.push(task)
  const log = () => {
    try {
      return readFileSync(logFile, 'utf8')
    } catch {
      return ''
    }
  }
  return { task, repo, events, wt, log }
}

async function waitFor(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const statuses = (events: BridgeEvent[]) => events.flatMap((e) => (e.type === 'task' ? [e.task.status] : []))
const attentions = (events: BridgeEvent[]) => events.flatMap((e) => (e.type === 'attention' ? [e] : []))
const waitStatus = (m: Made, s: string) => waitFor(() => m.task.summary().status === s, `status ${s} (is ${m.task.summary().status})`)

afterEach(async () => {
  await Promise.all(tasks.splice(0).map((t) => t.cancel().catch(() => {})))
  for (const k of ['RELAY_FAKE_AGENT', 'FAKE_SCRIPT', 'FAKE_LOG', 'FAKE_OPTIONS', 'FAKE_EFFORT_AFTER_MODEL', 'FAKE_HANG_INIT']) delete process.env[k]
  for (const d of logDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  await cleanupRepos()
})

describe('Task', () => {
  it('runs the brief and ends idle', async () => {
    const m = await make((wt) => [
      [
        thought('thinking '),
        thought('hard'),
        { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write a.txt', kind: 'edit', status: 'pending', locations: [{ path: join(wt, 'a.txt').replaceAll('/', '\\') }], rawInput: {} } },
        { writeFile: 'a.txt' },
        { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
        msg('do'),
        msg('ne'),
        { stop: 'end_turn' },
      ],
    ])
    await m.task.start()
    await waitStatus(m, 'idle')

    const s = m.task.summary()
    const seen = statuses(m.events)
    expect(seen).toContain('running')
    expect(seen.indexOf('running')).toBeLessThan(seen.lastIndexOf('idle'))
    expect(s.filesTouched).toEqual(['a.txt'])
    expect(s.currentStep).toBe('Write a.txt')
    expect(s.lastMessage).toBe('done')
    expect(s.branch).toBe('relay/oc-1')

    const files = await git(m.repo, 'show', '--name-only', '--format=', 'relay/oc-1')
    expect(files.split('\n')).toContain('a.txt')

    const att = attentions(m.events)
    expect(att).toHaveLength(1)
    expect(att[0]).toMatchObject({ reason: 'turn_ended', text: 'done' })

    const thread = m.task.detail(false).thread
    expect(thread.map((t) => `${t.from}:${t.kind}`)).toEqual(['claude:brief', 'agent:message'])

    // thought chunks coalesce into one entry, the tool call stays one entry keyed by id
    const activity = m.task.detail(true).activity!
    expect(activity.map((a) => [a.kind, a.text])).toEqual([
      ['thought', 'thinking hard'],
      ['tool', 'Write a.txt'],
      ['message', 'done'],
    ])
    expect(activity[1]).toMatchObject({ toolCallId: 't1', status: 'completed' })
  })

  it('sets model then effort', async () => {
    const m = await make([[msg('ok'), { stop: 'end_turn' }]], { req: { model: 'm1', effort: 'high' } })
    await m.task.start()
    await waitStatus(m, 'idle')
    const log = m.log()
    expect(log.indexOf('model=m1')).toBeGreaterThanOrEqual(0)
    expect(log.indexOf('model=m1')).toBeLessThan(log.indexOf('effort=high'))
    expect(m.task.summary()).toMatchObject({ model: 'm1', effort: 'high' })
  })

  it('sets effort only once the agent advertises it after the model is set', async () => {
    const m = await make([[msg('ok'), { stop: 'end_turn' }]], { req: { model: 'm1', effort: 'high' }, env: { FAKE_EFFORT_AFTER_MODEL: '1' } })
    await m.task.start()
    await waitStatus(m, 'idle')
    expect(m.log()).toContain('effort=high')
    expect(m.task.summary().effort).toBe('high')
  })

  it('skips an option the agent does not advertise and records why', async () => {
    const m = await make([[msg('ok'), { stop: 'end_turn' }]], { req: { model: 'm1', effort: 'high' }, env: { FAKE_OPTIONS: 'model' } })
    await m.task.start()
    await waitStatus(m, 'idle')
    expect(m.log()).not.toContain('effort=')
    expect(m.task.summary()).toMatchObject({ model: 'm1', effort: undefined })
    expect(m.task.detail(false).thread.some((t) => t.from === 'bridge' && t.kind === 'error' && t.text.includes('effort'))).toBe(true)
  })

  it('routes a question and waits', async () => {
    const m = await make(
      [
        [
          {
            permission: {
              toolCall: { toolCallId: 'q1', title: 'DB: pick one', kind: 'other', rawInput: { question: 'Which db?', options: ['sqlite', 'pg', 'mysql'] } },
              options: ['sqlite', 'pg', 'mysql'].map((n, i) => ({ optionId: `option_${i}`, name: n, kind: 'allow_once' })),
            },
          },
          { stop: 'end_turn' },
        ],
      ],
      { agent: 'commandcode' },
    )
    await m.task.start()
    await waitStatus(m, 'asking')
    const att = attentions(m.events)
    expect(att).toHaveLength(1)
    expect(att[0]!.reason).toBe('question')
    const pending = m.task.summary().pending!
    expect(pending.type).toBe('question')
    expect(pending.title).toBe('Which db?')

    await new Promise((r) => setTimeout(r, 200))
    expect(m.task.summary().status).toBe('asking')

    m.task.answer(pending.requestId, 'option_2')
    expect(m.task.summary().pending).toBeUndefined()
    await waitStatus(m, 'idle')
    expect(m.task.summary().lastMessage).toBe('answer:option_2')
  })

  it('holds a risky permission for Claude and cancels it when the task is cancelled', async () => {
    const m = await make([
      [
        {
          permission: {
            toolCall: { toolCallId: 'p1', title: 'Run: npm i', kind: 'execute', rawInput: { command: 'npm i' } },
            options: ccOptions,
          },
        },
        { stop: 'end_turn' },
      ],
    ])
    await m.task.start()
    await waitStatus(m, 'waiting_permission')
    expect(attentions(m.events).map((a) => a.reason)).toEqual(['permission'])
    expect(m.task.summary().pending?.type).toBe('permission')
    await m.task.cancel()
    expect(m.task.summary()).toMatchObject({ status: 'cancelled', pending: undefined })
  })

  it('auto-allows an in-worktree edit', async () => {
    const m = await make((wt) => [
      [
        {
          permission: {
            toolCall: { toolCallId: 'e1', title: `Write: ${join(wt, 'a.txt')}`, kind: 'edit', rawInput: { file_path: join(wt, 'a.txt'), content: 'x\n' }, locations: [{ path: join(wt, 'a.txt') }] },
            options: ccOptions,
          },
        },
        { stop: 'end_turn' },
      ],
    ])
    await m.task.start()
    await waitStatus(m, 'idle')
    const thread = m.task.detail(false).thread
    expect(thread.some((t) => t.kind === 'decision' && t.text.includes('auto-allowed'))).toBe(true)
    expect(m.task.summary().lastMessage).toBe('answer:allow_once')
    expect(attentions(m.events).map((a) => a.reason)).toEqual(['turn_ended'])
  })

  it('reply sends a second prompt; costUsd is the latest session-cumulative amount', async () => {
    const m = await make([
      [usage(0.001), msg('first'), { stop: 'end_turn' }],
      [usage(0.003), msg('second'), { stop: 'end_turn' }],
    ])
    await m.task.start()
    await waitStatus(m, 'idle')
    expect(m.task.summary().costUsd).toBeCloseTo(0.001, 9)
    await m.task.reply('next')
    expect(m.task.summary().status).toBe('running')
    await waitFor(() => m.task.summary().lastMessage === 'second', 'second turn')
    await waitStatus(m, 'idle')
    expect(m.task.summary().costUsd).toBeCloseTo(0.003, 9)
    const texts = m.task.detail(false).thread.map((t) => `${t.from}:${t.text}`)
    expect(texts).toEqual(['claude:please do the thing', 'agent:first', 'claude:next', 'agent:second'])
  })

  it('refuses a reply while the agent is working', async () => {
    const m = await make([[{ hang: true }]])
    await m.task.start()
    await waitStatus(m, 'running')
    await expect(m.task.reply('hello')).rejects.toMatchObject({ code: 'not_idle' })
  })

  it('agent crash fails the task with the exit code and stderr', async () => {
    const m = await make([[msg('partial'), { stderr: 'kaboom: out of memory' }, { exit: 3 }]])
    await m.task.start()
    await waitStatus(m, 'failed')
    const att = attentions(m.events)
    expect(att).toHaveLength(1)
    expect(att[0]!.reason).toBe('failed')
    expect(att[0]!.text).toContain('3')
    expect(att[0]!.text).toContain('kaboom: out of memory')
  })

  it('a prompt error fails the task with the error text', async () => {
    const m = await make([[{ error: 'model exploded' }]])
    await m.task.start()
    await waitStatus(m, 'failed')
    expect(attentions(m.events)).toMatchObject([{ reason: 'failed', text: expect.stringContaining('model exploded') }])
  })

  it('out of credits', async () => {
    const m = await make([[{ error: 'Insufficient credits for x' }]], { agent: 'commandcode' })
    await m.task.start()
    await waitStatus(m, 'out_of_credits')
    expect(attentions(m.events)).toMatchObject([{ reason: 'out_of_credits' }])
  })

  it('a Command Code turn whose final message says out of credits ends out_of_credits (opencode does not)', async () => {
    const m = await make([[msg('Insufficient credits to continue'), { stop: 'end_turn' }]], { agent: 'commandcode' })
    await m.task.start()
    await waitStatus(m, 'out_of_credits')
    expect(attentions(m.events).map((a) => a.reason)).toEqual(['out_of_credits'])
    await expect(m.task.reply('more')).rejects.toMatchObject({ code: 'not_idle' })

    const o = await make([[msg('Insufficient credits to continue'), { stop: 'end_turn' }]], { agent: 'opencode' })
    await o.task.start()
    await waitStatus(o, 'idle')
    expect(attentions(o.events).map((a) => a.reason)).toEqual(['turn_ended'])
  })

  it('escalate then reply', async () => {
    const m = await make([
      [msg('what db?'), { stop: 'end_turn' }],
      [msg('using sqlite'), { stop: 'end_turn' }],
    ])
    await m.task.start()
    await waitStatus(m, 'idle')
    m.task.escalate('pick a db?')
    expect(m.task.summary().waitingOnUser).toBe(true)
    expect(m.task.detail(false).thread.at(-1)).toMatchObject({ kind: 'escalation', text: 'pick a db?' })
    await m.task.reply('sqlite', true)
    expect(m.task.summary().waitingOnUser).toBe(false)
    expect(m.task.detail(false).thread.some((t) => t.from === 'user' && t.text === 'sqlite')).toBe(true)
    await waitFor(() => m.task.summary().lastMessage === 'using sqlite', 'second turn')
  })

  it('detail(false) has no activity; detail(true) has it', async () => {
    const m = await make([[msg('hi'), { stop: 'end_turn' }]])
    await m.task.start()
    await waitStatus(m, 'idle')
    expect('activity' in m.task.detail(false)).toBe(false)
    expect(m.task.detail(true).activity).toHaveLength(1)
    expect(m.task.detail(true).brief).toBe('please do the thing')
  })

  it('cancel kills the agent and marks the task cancelled', async () => {
    const m = await make([[{ hang: true }]])
    await m.task.start()
    await waitStatus(m, 'running')
    await m.task.cancel()
    expect(m.task.summary().status).toBe('cancelled')
    expect(attentions(m.events)).toEqual([])
  })

  it('keeps the task idle and flags the refusal when the commit is refused', async () => {
    const m = await make([[{ writeFile: 'nested/.git' }, { stop: 'end_turn' }]])
    await m.task.start()
    await waitStatus(m, 'idle')
    const att = attentions(m.events)
    expect(att).toHaveLength(1)
    expect(att[0]!.reason).toBe('turn_ended')
    expect(att[0]!.text).toContain('nested_repo')
    expect(m.task.detail(false).thread.some((t) => t.from === 'bridge' && t.kind === 'error' && t.text.startsWith('nested_repo:'))).toBe(true)
  })
  it('cancel during startup spawns no agent', async () => {
    const m = await make([[msg('never')]])
    const started = m.task.start()
    await m.task.cancel()
    await started
    await new Promise((r) => setTimeout(r, 300))
    expect(m.task.summary().status).toBe('cancelled')
    expect(m.log()).not.toContain('started pid=')
  })

  it('cancel during the handshake kills the agent', async () => {
    const m = await make([[msg('never')]], { env: { FAKE_HANG_INIT: '1' } })
    const started = m.task.start()
    await waitFor(() => m.log().includes('started pid='), 'agent start')
    const pid = Number(/started pid=(\d+)/.exec(m.log())![1])
    await m.task.cancel()
    await started
    expect(m.task.summary().status).toBe('cancelled')
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, `agent ${pid} to be gone`, 5000)
  })

  it('a late permission request holds its status and does not wedge the task', async () => {
    const m = await make([
      [
        msg('first'),
        {
          stop: 'end_turn',
          after: { permission: { toolCall: { toolCallId: 'l1', title: 'Run: ls', kind: 'execute', rawInput: { command: 'ls' } }, options: ccOptions } },
        },
      ],
      [msg('second'), { stop: 'end_turn' }],
    ])
    await m.task.start()
    await waitStatus(m, 'waiting_permission')
    await new Promise((r) => setTimeout(r, 200))
    expect(m.task.summary().status).toBe('waiting_permission')
    const pending = m.task.summary().pending!
    m.task.answer(pending.requestId, 'allow_once')
    await waitStatus(m, 'idle') // 'running' only while the post-turn commit is still in flight
    await waitFor(() => m.log().includes('late answer:allow_once'), 'agent saw the answer')
    await m.task.reply('again')
    await waitFor(() => m.task.summary().lastMessage === 'second', 'second turn')
    await waitStatus(m, 'idle')
  })

  it('fails the task when the agent never answers initialize', async () => {
    const m = await make([[msg('never')]], { env: { FAKE_HANG_INIT: '1' }, handshakeTimeoutMs: 300 })
    await m.task.start()
    await waitStatus(m, 'failed')
    const att = attentions(m.events)
    expect(att).toHaveLength(1)
    expect(att[0]!.reason).toBe('failed')
    expect(att[0]!.text).toContain('initialize timed out')
    expect(att[0]!.text).toContain('started pid=')
  })

  it('announces a truncated permission preview and keeps the full input in detail', async () => {
    const command = `echo ${'x'.repeat(900)}`
    const m = await make([[{ permission: { toolCall: { toolCallId: 'p2', title: 'Run: long', kind: 'execute', rawInput: { command } }, options: ccOptions } }, { stop: 'end_turn' }]])
    await m.task.start()
    await waitStatus(m, 'waiting_permission')
    const text = attentions(m.events)[0]!.text
    const total = JSON.stringify({ command }).length
    expect(text).toContain('truncated')
    expect(text).toContain(`${total} chars`)
    expect(text).not.toContain('x'.repeat(600))
    expect((m.task.detail(false).pending!.rawInput as { command: string }).command).toBe(command)
  })

  it('child exit while a permission is pending fails the task and clears the pending request', async () => {
    const m = await make([[{ permission: { toolCall: { toolCallId: 'p3', title: 'Run: x', kind: 'execute', rawInput: { command: 'x' } }, options: ccOptions }, exitAfterMs: 400 }]])
    await m.task.start()
    await waitStatus(m, 'waiting_permission')
    await waitStatus(m, 'failed')
    expect(m.task.summary().pending).toBeUndefined()
    const failed = attentions(m.events).filter((a) => a.reason === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.text).toContain('4')
  })

  it('survives an emit handler that throws', async () => {
    process.env.RELAY_FAKE_AGENT = FAKE
    process.env.FAKE_SCRIPT = JSON.stringify([[msg('ok'), { stop: 'end_turn' }]])
    const repo = await makeRepo()
    const task = new Task({
      id: 'oc-1',
      spec: agentSpec('opencode', 'unused'),
      req: { agent: 'opencode', title: 't', brief: 'b', repoPath: repo },
      emit: () => {
        throw new Error('subscriber bug')
      },
    })
    tasks.push(task)
    await task.start()
    await waitFor(() => task.summary().status === 'idle', 'idle')
  })
})
