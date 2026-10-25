import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentSpec } from './agents.ts'
import { isOutOfCredits, classifyPermission, type PermissionParams } from './policy.ts'
import { RpcPeer } from './rpc.ts'
import type { ActivityEntry, BridgeEvent, DelegateRequest, PendingRequest, TaskDetail, TaskStatus, TaskSummary, ThreadEntry } from './types.ts'
import { RelayError, commitAll, createWorktree, killTree } from './worktree.ts'

type ConfigOption = { id: string; category?: string; currentValue?: string; options?: { value: string; name: string }[] }
type Outcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }
type PendingEntry = { pending: PendingRequest; resolve: (o: Outcome) => void }

const STDERR_LINES = 20
const HANDSHAKE_TIMEOUT_MS = 60_000
const PREVIEW_CHARS = 500
const ACTIVITY_CAP = 1000
const TERMINAL: readonly TaskStatus[] = ['done', 'failed', 'cancelled', 'out_of_credits']

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
class HandshakeTimeout extends Error {}

/** First PREVIEW_CHARS of the request's input; a cut is announced so nobody approves on a partial view. */
function preview(input: unknown): string {
  const full = JSON.stringify(input ?? null)
  if (full.length <= PREVIEW_CHARS) return full
  return `${full.slice(0, PREVIEW_CHARS)}…[truncated, ${full.length} chars — read relay_status {taskId, full:true} before approving]`
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())

/**
 * One delegated task: one git worktree, one agent child process, one ACP session. The bridge's single owner of that
 * state; every change is published through `emit`. Never throws out of an event handler.
 */
export class Task {
  readonly id: string
  #spec: AgentSpec
  #req: DelegateRequest
  #emit: (e: BridgeEvent) => void
  #handshakeTimeoutMs: number
  #turnActive = false

  #status: TaskStatus = 'starting'
  #startedAt = Date.now()
  #updatedAt = this.#startedAt
  #wt: { path: string; branch: string; base: string } | undefined
  #child: ChildProcess | undefined
  #rpc: RpcPeer | undefined
  #sessionId: string | undefined
  #closed: Promise<void> = Promise.resolve()
  #stderr: string[] = []
  #stderrPartial = ''

  #model: string | undefined
  #effort: string | undefined
  #currentStep: string | undefined
  #files = new Set<string>()
  #toolKinds = new Map<string, string>()
  #cost = 0
  #turnText = ''
  #lastMessage: string | undefined
  #waitingOnUser = false
  #requestSeq = 0
  #pendings = new Map<string, PendingEntry>()

  #thread: ThreadEntry[] = []
  #activity: ActivityEntry[] = []

  constructor(opts: { id: string; spec: AgentSpec; req: DelegateRequest; emit: (e: BridgeEvent) => void; handshakeTimeoutMs?: number }) {
    this.id = opts.id
    this.#spec = opts.spec
    this.#req = opts.req
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
    // A throwing subscriber must never break task state or turn into an unhandled rejection.
    this.#emit = (e) => {
      try {
        opts.emit(e)
      } catch (err) {
        console.error(`[task ${opts.id}] emit handler threw:`, err)
      }
    }
  }

  // ---- public API -------------------------------------------------------------------------------------------

  /** Worktree, agent process, ACP handshake, model/effort, then the brief as the first prompt (not awaited). */
  async start(): Promise<void> {
    try {
      this.#wt = await createWorktree(this.#req.repoPath, this.id)
    } catch (err) {
      if (!this.#isTerminal()) this.#status = 'failed' // nothing exists yet: the caller reports the refusal, no event is published
      this.#addThread('bridge', 'error', errText(err))
      throw err
    }
    if (this.#isTerminal()) return // cancelled while the worktree was being made: never spawn
    this.#addThread('claude', 'brief', this.#req.brief)
    this.#changed()
    try {
      this.#spawn()
      await this.#handshake()
    } catch (err) {
      await this.#failFromError(err, 'agent setup failed')
      return
    }
    if (this.#isTerminal()) {
      this.#kill() // cancelled mid-handshake: do not leave the agent running
      return
    }
    this.#startTurn(this.#req.brief)
  }

  async #handshake(): Promise<void> {
    await this.#hs('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-relay', version: '0.1.0' },
    })
    if (this.#isTerminal()) return
    const created = await this.#hs<{ sessionId: string; configOptions?: ConfigOption[] }>('session/new', { cwd: this.#wt!.path, mcpServers: [] })
    this.#sessionId = created.sessionId
    let options = created.configOptions ?? []
    if (this.#isTerminal()) return
    if (this.#req.model) options = await this.#setOption('model', this.#req.model, options)
    if (this.#isTerminal()) return
    if (this.#req.effort) options = await this.#setOption('effort', this.#req.effort, options)
  }

  /** A handshake request that cannot hang forever: a silent agent fails the task instead of stalling `starting`. */
  async #hs<T>(method: string, params: unknown): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HandshakeTimeout(`${method} timed out after ${this.#handshakeTimeoutMs} ms`)), this.#handshakeTimeoutMs)
    })
    try {
      return await Promise.race([this.#rpc!.request<T>(method, params), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Sends a follow-up prompt. Only while idle; clears waitingOnUser. Resolves once the turn has started. */
  async reply(text: string, fromUser = false): Promise<void> {
    if (this.#status !== 'idle') {
      throw new RelayError('not_idle', `task ${this.id} is ${this.#status}; a reply needs it idle${this.#status === 'asking' ? ' (use answer for the pending question)' : ''}`)
    }
    this.#waitingOnUser = false
    this.#addThread(fromUser ? 'user' : 'claude', 'message', text)
    this.#startTurn(text)
  }

  /** Resolves a pending permission or question with one of its options. */
  answer(requestId: string, optionId: string, note?: string, fromUser = false): void {
    const entry = this.#pendings.get(requestId)
    if (!entry) throw new RelayError('no_such_request', `task ${this.id} has no pending request ${requestId}`)
    const option = entry.pending.options.find((o) => o.optionId === optionId)
    if (!option) throw new RelayError('bad_option', `request ${requestId} has no option ${optionId}`)
    this.#pendings.delete(requestId)
    this.#waitingOnUser = false
    this.#addThread(fromUser ? 'user' : 'claude', 'answer', note ? `${option.name} (${note})` : option.name, requestId)
    if (!this.#isTerminal()) this.#status = this.#statusForPending()
    this.#changed()
    entry.resolve({ outcome: { outcome: 'selected', optionId } })
  }

  /** Records that Claude is putting a question to the user; the task keeps waiting until someone replies/answers. */
  escalate(question: string): void {
    this.#addThread('claude', 'escalation', question)
    this.#waitingOnUser = true
    this.#changed()
  }

  async cancel(): Promise<void> {
    const wasTerminal = this.#isTerminal()
    if (!wasTerminal) {
      this.#status = 'cancelled'
      this.#waitingOnUser = false
      try {
        if (this.#sessionId) this.#rpc?.notify('session/cancel', { sessionId: this.#sessionId })
      } catch (err) {
        console.error(`[task ${this.id}] session/cancel failed:`, err)
      }
      this.#cancelPending()
      this.#changed()
    }
    this.#kill()
    await Promise.race([this.#closed, delay(5000)])
  }

  summary(): TaskSummary {
    const first = this.#pendings.values().next().value as PendingEntry | undefined
    return {
      id: this.id,
      agent: this.#spec.id,
      title: this.#req.title,
      model: this.#model,
      effort: this.#effort,
      status: this.#status,
      currentStep: this.#currentStep,
      filesTouched: [...this.#files],
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      costUsd: this.#cost,
      pending: first?.pending,
      lastMessage: this.#lastMessage,
      waitingOnUser: this.#waitingOnUser,
      branch: this.#wt?.branch ?? '',
      worktree: this.#wt?.path ?? '',
    }
  }

  detail(full: boolean): TaskDetail {
    const d: TaskDetail = { ...this.summary(), brief: this.#req.brief, thread: this.#thread.map((t) => ({ ...t })) }
    if (full) d.activity = this.#activity.map((a) => ({ ...a }))
    return d
  }

  // ---- process and handshake ----------------------------------------------------------------------------------

  #spawn(): void {
    const spec = this.#spec
    const child = spawn(spec.command, spec.args, {
      cwd: this.#wt!.path,
      env: { ...process.env, ...spec.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child = child
    this.#closed = new Promise<void>((resolveClosed) => {
      child.once('close', (code, signal) => {
        this.#flushStderr()
        resolveClosed()
        this.#onExit(code, signal)
      })
    })
    child.once('error', (err) => this.#fail(`could not start ${spec.label}: ${err.message}`))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => this.#onStderr(chunk))
    child.stderr!.on('error', () => {})
    child.stdout!.on('error', () => {})

    const rpc = new RpcPeer(child.stdin!, child.stdout!)
    this.#rpc = rpc
    rpc.onNotification((method, params) => {
      try {
        if (method === 'session/update') this.#onUpdate(params?.update)
      } catch (err) {
        console.error(`[task ${this.id}] bad session/update:`, err)
      }
    })
    rpc.onRequest(async (method, params) => {
      if (method === 'session/request_permission') return this.#onPermission(params)
      throw new Error(`unsupported client method: ${method}`)
    })
  }

  #onStderr(chunk: string): void {
    const lines = (this.#stderrPartial + chunk).split(/\r?\n/)
    this.#stderrPartial = lines.pop() ?? ''
    for (const l of lines) if (l.trim()) this.#stderr.push(l.slice(0, 500))
    if (this.#stderr.length > STDERR_LINES) this.#stderr.splice(0, this.#stderr.length - STDERR_LINES)
  }

  #stderrTail(): string {
    return this.#stderr.length > 0 ? String.fromCharCode(10) + this.#stderr.join(String.fromCharCode(10)) : ''
  }

  #flushStderr(): void {
    if (this.#stderrPartial.trim()) this.#stderr.push(this.#stderrPartial.slice(0, 500))
    this.#stderrPartial = ''
    if (this.#stderr.length > STDERR_LINES) this.#stderr.splice(0, this.#stderr.length - STDERR_LINES)
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#rpc?.close(new Error('agent exited'))
    if (this.#isTerminal()) return
    const how = code !== null ? `exit code ${code}` : `signal ${signal}`
    const tail = this.#stderrTail()
    this.#fail(`${this.#spec.label} exited unexpectedly (${how})${tail}`)
  }

  #kill(): void {
    const child = this.#child
    if (child && child.exitCode === null && child.signalCode === null) killTree(child)
  }

  /** A dying agent surfaces first as a closed stream; wait for the exit so the report carries its exit code. */
  async #failFromError(err: unknown, context: string): Promise<void> {
    const msg = errText(err)
    if (/RPC stream ended|agent exited/.test(msg)) await Promise.race([this.#closed, delay(3000)])
    if (this.#isTerminal()) return
    const tail = this.#stderrTail()
    this.#fail(`${context}: ${msg}${tail}`)
  }

  #fail(text: string): void {
    if (this.#isTerminal()) return
    this.#status = 'failed'
    this.#waitingOnUser = false
    this.#addThread('bridge', 'error', text)
    this.#cancelPending()
    this.#changed()
    this.#attention('failed', text)
    this.#kill()
  }

  async #setOption(configId: 'model' | 'effort', value: string, options: ConfigOption[]): Promise<ConfigOption[]> {
    if (!options.some((o) => o.id === configId)) {
      this.#addThread('bridge', 'error', `agent does not advertise a ${configId} option; skipped setting it to ${value}`)
      return options
    }
    try {
      const res = await this.#hs<{ configOptions?: ConfigOption[] }>('session/set_config_option', {
        sessionId: this.#sessionId,
        configId,
        type: 'id',
        value,
      })
      if (configId === 'model') this.#model = value
      else this.#effort = value
      return res?.configOptions ?? options
    } catch (err) {
      if (err instanceof HandshakeTimeout || /RPC stream ended|agent exited/.test(errText(err))) throw err // a hung or dead agent is a setup failure
      this.#addThread('bridge', 'error', `agent rejected ${configId}=${value}: ${errText(err)}`)
      return options
    }
  }

  // ---- turns ----------------------------------------------------------------------------------------------------

  /** Fire-and-forget turn: whatever goes wrong inside must fail the task, never escape as an unhandled rejection. */
  #startTurn(text: string): void {
    this.#runTurn(text).catch((err) => {
      console.error(`[task ${this.id}] turn crashed:`, err)
      this.#fail(`internal error: ${errText(err)}`)
    })
  }

  async #runTurn(text: string): Promise<void> {
    this.#turnActive = true
    this.#status = 'running'
    this.#turnText = ''
    this.#changed()
    let stopReason: string | undefined
    try {
      const res = await this.#rpc!.request<{ stopReason?: string }>('session/prompt', {
        sessionId: this.#sessionId,
        prompt: [{ type: 'text', text }],
      })
      stopReason = res?.stopReason
    } catch (err) {
      await this.#onPromptError(err)
      return
    }
    if (this.#isTerminal()) return

    const lastMessage = this.#turnText
    this.#lastMessage = lastMessage || undefined
    if (lastMessage) this.#addThread('agent', 'message', lastMessage)

    // The agent is idle now (R15): the only moment it is safe to look at its worktree.
    let refusal: string | undefined
    try {
      await commitAll(this.#wt!.path, `relay ${this.id}: ${this.#req.title}`, this.#wt!.base)
    } catch (err) {
      refusal = err instanceof RelayError ? `${err.code}: ${err.message}` : `commit_failed: ${errText(err)}`
      this.#addThread('bridge', 'error', refusal)
    }
    if (this.#isTerminal()) return

    this.#turnActive = false
    const credits = this.#spec.id === 'commandcode' && isOutOfCredits(lastMessage)
    if (credits) this.#status = 'out_of_credits'
    // a permission request that arrived late keeps its own status until it is answered
    else this.#status = this.#pendings.size === 0 ? 'idle' : this.#statusForPending()
    this.#changed()
    const body = lastMessage || `(the agent ended its turn without a message${stopReason && stopReason !== 'end_turn' ? `, stop reason ${stopReason}` : ''})`
    const text2 = refusal ? `${body}\n\nThe bridge could not commit this work: ${refusal}` : body
    this.#attention(credits ? 'out_of_credits' : 'turn_ended', text2)
    if (credits) {
      this.#cancelPending()
      this.#kill()
    }
  }

  async #onPromptError(err: unknown): Promise<void> {
    const msg = errText(err)
    if (/RPC stream ended|agent exited/.test(msg)) {
      await Promise.race([this.#closed, delay(3000)])
      if (this.#isTerminal()) return
    }
    if (this.#isTerminal()) return
    if (this.#spec.id === 'commandcode' && isOutOfCredits(msg)) {
      this.#status = 'out_of_credits'
      this.#addThread('bridge', 'error', msg)
      this.#cancelPending()
      this.#changed()
      this.#attention('out_of_credits', msg)
      this.#kill()
      return
    }
    this.#fail(msg)
  }

  // ---- permission requests ----------------------------------------------------------------------------------

  #onPermission(params: PermissionParams): Promise<Outcome> {
    if (this.#isTerminal()) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const requestId = `${this.id}-r${++this.#requestSeq}`
    const decision = classifyPermission(params, this.#wt!.path, requestId)
    if (decision.action === 'auto') {
      this.#addThread('bridge', 'decision', decision.note, requestId)
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: decision.optionId } })
    }
    const { pending } = decision
    const isQuestion = decision.action === 'question'
    this.#addThread('agent', isQuestion ? 'question' : 'permission', pending.title, requestId)
    const answered = new Promise<Outcome>((resolveOutcome) => this.#pendings.set(requestId, { pending, resolve: resolveOutcome }))
    this.#status = this.#statusForPending()
    this.#changed()
    const opts = pending.options.map((o) => `${o.optionId}: ${o.name}`).join('; ')
    const detail = isQuestion ? '' : ` [${pending.toolKind ?? 'unknown'}] ${preview(pending.rawInput)}`
    this.#attention(isQuestion ? 'question' : 'permission', `${pending.title}${detail}\nrequest ${requestId}; options: ${opts}`)
    return answered // never times out: the agent waits as long as the human needs
  }

  #statusForPending(): TaskStatus {
    const first = this.#pendings.values().next().value as PendingEntry | undefined
    if (!first) return this.#turnActive ? 'running' : 'idle'
    return first.pending.type === 'question' ? 'asking' : 'waiting_permission'
  }

  #cancelPending(): void {
    const all = [...this.#pendings.values()]
    this.#pendings.clear()
    for (const p of all) p.resolve({ outcome: { outcome: 'cancelled' } })
  }

  // ---- session/update -----------------------------------------------------------------------------------------

  #onUpdate(u: any): void {
    if (!u || typeof u !== 'object' || this.#isTerminal()) return
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? String(u.content.text ?? '') : ''
        this.#turnText += t
        this.#chunk('message', t)
        return
      }
      case 'agent_thought_chunk':
        this.#chunk('thought', u.content?.type === 'text' ? String(u.content.text ?? '') : '')
        return
      case 'tool_call':
      case 'tool_call_update':
        this.#onTool(u)
        return
      case 'usage_update': {
        const amount = u.cost?.amount
        if (typeof amount === 'number' && (u.cost.currency === undefined || u.cost.currency === 'USD')) {
          this.#cost = amount
          this.#changed()
        }
        return
      }
      default:
        return // available_commands_update and anything unknown
    }
  }

  #chunk(kind: 'thought' | 'message', text: string): void {
    if (!text) return
    const last = this.#activity.at(-1)
    if (last?.kind === kind) {
      last.text += text
      this.#emit({ type: 'activity', taskId: this.id, entry: { ...last } })
    } else this.#pushActivity({ at: Date.now(), kind, text })
  }

  #onTool(u: any): void {
    const id: string | undefined = typeof u.toolCallId === 'string' ? u.toolCallId : undefined
    if (u.kind) this.#toolKinds.set(id ?? '', u.kind)
    const kind = u.kind ?? this.#toolKinds.get(id ?? '')
    let entry = id ? this.#activity.findLast((a) => a.kind === 'tool' && a.toolCallId === id) : undefined
    if (!entry) {
      entry = { at: Date.now(), kind: 'tool', text: u.title ?? 'tool call', toolCallId: id, status: u.status }
      this.#pushActivity(entry)
    } else {
      if (u.title) entry.text = u.title
      if (u.status) entry.status = u.status
      this.#emit({ type: 'activity', taskId: this.id, entry: { ...entry } })
    }
    let changed = false
    if (u.title && u.title !== this.#currentStep) {
      this.#currentStep = u.title
      changed = true
    }
    if (kind === 'edit') {
      const paths: unknown[] = Array.isArray(u.locations) ? u.locations.map((l: any) => l?.path) : []
      if (paths.length === 0) paths.push(u.rawInput?.file_path ?? u.rawInput?.filePath ?? u.rawInput?.path)
      for (const p of paths) {
        const rel = typeof p === 'string' ? this.#relative(p) : undefined
        if (rel && !this.#files.has(rel)) {
          this.#files.add(rel)
          changed = true
        }
      }
    }
    if (changed) this.#changed()
  }

  /** Worktree-relative path with forward slashes, or undefined when it is not inside the worktree. */
  #relative(p: string): string | undefined {
    const root = this.#wt!.path
    const rel = relative(root, resolve(root, p))
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
    return rel.split(sep).join('/')
  }

  #pushActivity(entry: ActivityEntry): void {
    this.#activity.push(entry)
    if (this.#activity.length > ACTIVITY_CAP) this.#activity.splice(0, this.#activity.length - ACTIVITY_CAP)
    this.#emit({ type: 'activity', taskId: this.id, entry: { ...entry } })
  }

  // ---- bookkeeping --------------------------------------------------------------------------------------------

  #isTerminal(): boolean {
    return TERMINAL.includes(this.#status)
  }

  #addThread(from: ThreadEntry['from'], kind: ThreadEntry['kind'], text: string, requestId?: string): void {
    this.#thread.push({ at: Date.now(), from, kind, text, ...(requestId ? { requestId } : {}) })
  }

  #changed(): void {
    this.#updatedAt = Date.now()
    this.#emit({ type: 'task', task: this.summary() })
  }

  #attention(reason: Extract<BridgeEvent, { type: 'attention' }>['reason'], text: string): void {
    this.#emit({ type: 'attention', taskId: this.id, reason, text })
  }
}
