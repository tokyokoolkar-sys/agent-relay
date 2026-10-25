import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { AGENT_IDS, agentSpec } from './agents.ts'
import { RpcPeer } from './rpc.ts'
import { Task } from './task.ts'
import type { AgentId, BridgeEvent, DelegateRequest, TaskSummary } from './types.ts'
import { RelayError, assertRepo, branchExists, diff, killTree, killTreeSync, merge } from './worktree.ts'

const PROBE_TIMEOUT_MS = 60_000
const BUSY: readonly string[] = ['starting', 'running', 'asking', 'waiting_permission']

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const badRequest = (message: string) => new RelayError('bad_request', message)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** Checks an untrusted request body and returns it as a DelegateRequest, or throws RelayError('bad_request'). */
export function validateDelegate(body: unknown): DelegateRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('body must be a JSON object')
  const b = body as Record<string, unknown>
  if (typeof b.agent !== 'string' || !AGENT_IDS.includes(b.agent as AgentId)) throw badRequest(`agent must be one of ${AGENT_IDS.join(', ')}`)
  if (!isText(b.title)) throw badRequest('title must be a non-empty string')
  if (!isText(b.brief)) throw badRequest('brief must be a non-empty string')
  if (!isText(b.repoPath)) throw badRequest('repoPath must be a non-empty string')
  if (!isAbsolute(b.repoPath)) throw badRequest('repoPath must be an absolute path')
  for (const k of ['model', 'effort'] as const) {
    if (b[k] !== undefined && !isText(b[k])) throw badRequest(`${k} must be a non-empty string when given`)
  }
  return { agent: b.agent as AgentId, title: b.title, brief: b.brief, repoPath: b.repoPath, model: b.model as string | undefined, effort: b.effort as string | undefined }
}

/** Owns every task of this bridge process: ids, lookup, serialised merges, spend and the per-agent model list. */
export class TaskRegistry {
  #npmRoot: string
  #emit: (e: BridgeEvent) => void
  #probeTimeoutMs: number
  #tasks = new Map<string, { task: Task; req: DelegateRequest }>()
  #seq = 0
  #closing = false
  #mergeChain: Promise<unknown> = Promise.resolve()
  #models = new Map<AgentId, Promise<unknown[]>>()
  #probes = new Set<ChildProcess>()
  #lastOutOfCreditsAt: number | undefined

  constructor(npmRoot: string, emit: (e: BridgeEvent) => void, opts: { probeTimeoutMs?: number } = {}) {
    this.#npmRoot = npmRoot
    this.#emit = emit
    this.#probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  }

  /**
   * Creates the task and returns once its worktree exists. The agent handshake and the first turn carry on in the
   * background; their progress arrives as events.
   */
  async delegate(req: DelegateRequest): Promise<TaskSummary> {
    if (this.#closing) throw new RelayError('shutting_down', 'the bridge is shutting down')
    await assertRepo(req.repoPath) // nothing is created, spawned or numbered for a path that is not a repo
    if (this.#closing) throw new RelayError('shutting_down', 'the bridge is shutting down')

    const spec = agentSpec(req.agent, this.#npmRoot)
    const id = await this.#allocateId(spec.short, req.repoPath)
    if (this.#closing) throw new RelayError('shutting_down', 'the bridge is shutting down')
    let markReady: () => void = () => {}
    const worktreeReady = new Promise<void>((r) => (markReady = r))
    const task = new Task({
      id,
      spec,
      req,
      emit: (e) => {
        if (e.type === 'task' && e.task.id === id && e.task.worktree !== '') markReady()
        if (e.type === 'attention' && e.reason === 'out_of_credits') this.#lastOutOfCreditsAt = Date.now()
        this.#emit(e)
      },
    })
    this.#tasks.set(id, { task, req })

    // start() resolves with the error (or undefined) instead of rejecting, so a late failure never goes unhandled.
    const settled = task.start().then(
      () => undefined,
      (err: unknown) => err ?? new Error('task start failed'),
    )
    const early = await Promise.race([settled.then((error) => ({ error })), worktreeReady.then(() => ({ error: undefined }))])
    if (early.error) {
      this.#tasks.delete(id)
      throw early.error
    }
    void settled.then((error) => {
      if (error) console.error(`[task ${id}] start failed:`, error)
    })
    return task.summary()
  }

  get(id: string): Task {
    return this.#entry(id).task
  }

  list(): TaskSummary[] {
    return [...this.#tasks.values()].map((e) => e.task.summary())
  }

  async diff(id: string): Promise<{ stat: string; patch: string }> {
    const { task, req } = this.#entry(id)
    const base = task.base
    const branch = task.summary().branch
    if (!base || !branch) throw new RelayError('no_worktree', `task ${id} has no worktree`)
    return diff(req.repoPath, base, branch)
  }

  /** Merges the task's branch into the main tree. One merge at a time, in request order. */
  merge(id: string): Promise<Awaited<ReturnType<typeof merge>>> {
    const run = async () => {
      const { task, req } = this.#entry(id)
      const s = task.summary()
      if (!s.branch) throw new RelayError('no_worktree', `task ${id} has no worktree`)
      if (BUSY.includes(s.status)) throw new RelayError('task_busy', `task ${id} is ${s.status}; its work is only on the branch once the turn has ended`)
      const title = s.title.replace(/\s+/g, ' ').trim()
      return merge(req.repoPath, s.branch, `relay: merge ${id} ${title}`)
    }
    const result = this.#mergeChain.then(run, run)
    this.#mergeChain = result.catch(() => {})
    return result
  }

  /**
   * Next free id for this repo. The counter is bumped synchronously before each await, so concurrent delegations never
   * see the same candidate; a candidate is skipped when an earlier bridge process left its branch or worktree behind.
   */
  async #allocateId(short: string, repo: string): Promise<string> {
    for (;;) {
      const id = `${short}-${++this.#seq}`
      if (await branchExists(repo, `relay/${id}`)) continue
      const dir = await stat(join(repo, '.relay', 'wt', id)).then(() => true, () => false)
      if (!dir) return id
    }
  }

  /** The agent's `configOptions` (model, effort, ...), from a throwaway session in `repo`. Cached per agent. */
  models(agent: AgentId, repo: string): Promise<unknown[]> {
    if (!AGENT_IDS.includes(agent)) return Promise.reject(badRequest(`unknown agent ${agent}`))
    const cached = this.#models.get(agent)
    if (cached) return cached
    if (this.#closing) return Promise.reject(new RelayError('shutting_down', 'the bridge is shutting down'))
    let isDir = false
    try {
      isDir = statSync(repo).isDirectory()
    } catch {
      /* reported below */
    }
    if (!isDir) return Promise.reject(badRequest(`repo ${repo} is not a directory`))
    const probe = this.#probe(agent, repo)
    this.#models.set(agent, probe)
    probe.catch(() => this.#models.delete(agent)) // a failure is not cached: the next call tries again
    return probe
  }

  spend(): { commandcodeUsd: number; opencodeUsd: number; lastOutOfCreditsAt?: number } {
    let commandcodeUsd = 0
    let opencodeUsd = 0
    for (const { task } of this.#tasks.values()) {
      const s = task.summary()
      if (s.agent === 'commandcode') commandcodeUsd += s.costUsd
      else opencodeUsd += s.costUsd
    }
    const out: { commandcodeUsd: number; opencodeUsd: number; lastOutOfCreditsAt?: number } = { commandcodeUsd, opencodeUsd }
    if (this.#lastOutOfCreditsAt !== undefined) out.lastOutOfCreditsAt = this.#lastOutOfCreditsAt
    return out
  }

  /** Cancels every task (kills the agents, keeps worktrees and branches) and any model probe still running. */
  async shutdown(): Promise<void> {
    this.#closing = true
    for (const child of this.#probes) killTree(child)
    await Promise.all([...this.#tasks.values()].map(({ task }) => task.cancel().catch((err) => console.error(`[task ${task.id}] cancel failed:`, err))))
  }

  /** Crash path only: synchronously kill every agent and probe process tree. Best effort, never throws. */
  killAllNow(): number {
    this.#closing = true
    let n = 0
    for (const child of this.#probes) {
      killTreeSync(child)
      n++
    }
    for (const { task } of this.#tasks.values()) {
      try {
        task.killNow()
        n++
      } catch {
        /* keep killing the others */
      }
    }
    return n
  }

  #entry(id: string) {
    const entry = this.#tasks.get(id)
    if (!entry) throw new RelayError('no_such_task', `no task ${id}`)
    return entry
  }

  async #probe(agent: AgentId, cwd: string): Promise<unknown[]> {
    const spec = agentSpec(agent, this.#npmRoot)
    const child = spawn(spec.command, spec.args, { cwd, env: { ...process.env, ...spec.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.#probes.add(child)
    const closed = new Promise<void>((r) => child.once('close', () => r()))
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (c: string) => (stderr = (stderr + c).slice(-500)))
    child.stderr!.on('error', () => {})
    child.stdout!.on('error', () => {})
    const rpc = new RpcPeer(child.stdin!, child.stdout!)
    let timer: NodeJS.Timeout | undefined
    const failure = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new Error(`could not start ${spec.label}: ${err.message}`)))
      timer = setTimeout(() => reject(new Error(`${spec.label} did not answer within ${this.#probeTimeoutMs} ms`)), this.#probeTimeoutMs)
    })
    failure.catch(() => {})
    try {
      const handshake = (async () => {
        await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'agent-relay', version: '0.1.0' },
        })
        const created = await rpc.request<{ configOptions?: unknown[] }>('session/new', { cwd, mcpServers: [] })
        return created?.configOptions ?? []
      })()
      handshake.catch(() => {})
      return await Promise.race([handshake, failure])
    } catch (err) {
      throw new RelayError('probe_failed', `could not list ${spec.label} models: ${errText(err)}${stderr ? `\n${stderr.trim()}` : ''}`)
    } finally {
      clearTimeout(timer)
      rpc.close(new Error('probe finished'))
      if (child.exitCode === null && child.signalCode === null) killTree(child)
      await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 5000).unref())])
      this.#probes.delete(child)
    }
  }
}
