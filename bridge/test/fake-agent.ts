// A scripted fake ACP agent. Run as `node fake-agent.ts` with env:
//   FAKE_SCRIPT  JSON: a list of steps per prompt (prompt N runs script[N]; a flat list of steps is one prompt).
//   FAKE_OPTIONS (optional) comma list of advertised config options (default "model,effort").
//   FAKE_EFFORT_AFTER_MODEL (optional) "1": the effort option only appears once a model is set (as OpenCode does).
//   FAKE_HANG_INIT (optional) "1": never answer initialize.
//   FAKE_LOG (optional) file that also receives every stderr log line.
// Steps: {update}, {permission, exitAfterMs?}, {exit}, {error}, {writeFile}, {stderr}, {hang}, {stop, after?: {permission}} (after: a request sent once the prompt has resolved).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

type Step = Record<string, any>
const raw = JSON.parse(process.env.FAKE_SCRIPT ?? '[]') as Step[] | Step[][]
const script: Step[][] = raw.length > 0 && Array.isArray(raw[0]) ? (raw as Step[][]) : [raw as Step[]]
const advertised = (process.env.FAKE_OPTIONS ?? 'model,effort').split(',')
const SESSION = 'fake-session'

let cwd = process.cwd()
let nextId = 1000
let promptCount = 0
let model = 'default'
let effort = 'medium'
let activePrompt: { id: number; cancel: () => void } | undefined
const waiting = new Map<number, (result: any) => void>()

const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n')
const log = (line: string) => {
  process.stderr.write(line + '\n')
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, line + '\n')
}
const update = (u: object) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: u } })

function configOptions() {
  const out: object[] = []
  if (advertised.includes('model')) {
    out.push({ id: 'model', category: 'model', currentValue: model, options: ['default', 'm1', 'm2'].map((v) => ({ value: v, name: v })) })
  }
  const effortHidden = process.env.FAKE_EFFORT_AFTER_MODEL === '1' && model === 'default'
  if (advertised.includes('effort') && !effortHidden) {
    out.push({ id: 'effort', category: 'thought_level', currentValue: effort, options: ['low', 'medium', 'high'].map((v) => ({ value: v, name: v })) })
  }
  return out
}

async function permissionStep(step: Step, stopper: Promise<void>): Promise<string> {
  const reqId = nextId++
  const reply = new Promise<any>((r) => waiting.set(reqId, r))
  send({ jsonrpc: '2.0', id: reqId, method: 'session/request_permission', params: { sessionId: SESSION, ...step.permission } })
  const result = await Promise.race([reply, stopper.then(() => ({ outcome: { outcome: 'cancelled' } }))])
  waiting.delete(reqId)
  const o = result?.outcome
  return o?.outcome === 'selected' ? o.optionId : 'cancelled'
}

async function runPrompt(id: number, steps: Step[]) {
  let cancelled = false
  let release: () => void = () => {}
  const stopper = new Promise<void>((r) => (release = r))
  activePrompt = { id, cancel: () => { cancelled = true; release() } }
  for (const step of steps) {
    if (cancelled) break
    if (step.update) update(step.update)
    else if (step.stderr) log(String(step.stderr))
    else if (step.writeFile) {
      mkdirSync(dirname(join(cwd, step.writeFile)), { recursive: true })
      writeFileSync(join(cwd, step.writeFile), 'written by fake agent\n')
    }
    else if (step.exit !== undefined) process.exit(step.exit)
    else if (step.error) {
      activePrompt = undefined
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: step.error } })
      return
    } else if (step.hang) await stopper
    else if (step.permission) {
      if (step.exitAfterMs) setTimeout(() => process.exit(4), step.exitAfterMs)
      const optionId = await permissionStep(step, stopper)
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer:${optionId}` } })
    } else if (step.stop) {
      activePrompt = undefined
      send({ jsonrpc: '2.0', id, result: { stopReason: step.stop, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } })
      if (step.after?.permission) log(`late answer:${await permissionStep(step.after, stopper)}`)
      return
    }
  }
  activePrompt = undefined
  send({ jsonrpc: '2.0', id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } })
}

function handle(msg: any) {
  if (msg.method === undefined) {
    // a response to one of our requests (permission answers)
    waiting.get(msg.id)?.(msg.result)
    return
  }
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      if (process.env.FAKE_HANG_INIT === '1') return
      return reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] })
    case 'session/new':
      cwd = msg.params.cwd
      return reply({ sessionId: SESSION, configOptions: configOptions() })
    case 'session/set_config_option': {
      const { configId, value } = msg.params
      log(`set_config_option ${configId}=${value}`)
      if (configId === 'model') model = value
      if (configId === 'effort') effort = value
      return reply({ configOptions: configOptions() })
    }
    case 'session/prompt': {
      const steps = script[promptCount++] ?? []
      void runPrompt(msg.id, steps)
      return
    }
    case 'session/cancel':
      activePrompt?.cancel()
      return
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  try {
    handle(JSON.parse(line))
  } catch (err) {
    log(`fake agent error: ${err}`)
  }
})
process.stdin.on('end', () => process.exit(0))
log(`started pid=${process.pid}`)
