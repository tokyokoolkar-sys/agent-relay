import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { validateDelegate, type TaskRegistry } from './registry.ts'
import type { AgentId } from './types.ts'
import { RelayError, isDirty } from './worktree.ts'

const MAX_BODY_BYTES = 1024 * 1024

class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const badRequest = (message: string) => new RelayError('bad_request', message)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...extra })
  res.end(text)
}

/** Reads a JSON object body (empty body = `{}`), refusing anything over 1 MiB. */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    let size = 0
    let tooBig = false
    const chunks: Buffer[] = []
    const refuse = () => {
      tooBig = true
      chunks.length = 0
      reject(new HttpError(413, 'too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`))
      // keep discarding what the client still sends so it can read the 413; then drop the connection
      setTimeout(() => req.destroy(), 5000).unref()
      res.setHeader('connection', 'close')
    }
    if (declared > MAX_BODY_BYTES) {
      refuse()
      req.resume()
      return
    }
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) return refuse()
      chunks.push(chunk)
    })
    req.on('error', (err) => reject(err))
    req.on('end', () => {
      if (tooBig) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return reject(new RelayError('bad_json', 'request body is not valid JSON'))
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return reject(badRequest('body must be a JSON object'))
      resolve(parsed as Record<string, unknown>)
    })
  })
}

function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false
  // hashing gives two buffers of equal length, which timingSafeEqual requires, without leaking the token's length
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

export async function startServer(reg: TaskRegistry): Promise<{ port: number; token: string; close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex')
  let port = 0

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DNS-rebinding guard: a browser page on another origin reaches us under its own Host name.
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'bad_host', 'unexpected Host header')

    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token)) throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token')

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    let parts: string[]
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      throw badRequest('malformed percent-encoding in the path')
    }
    const method = req.method ?? 'GET'
    const body = method === 'POST' ? await readBody(req, res) : {}
    const route = (m: string, ...shape: string[]) => m === method && shape.length === parts.length && shape.every((s, i) => s.startsWith(':') || s === parts[i])

    if (route('GET', 'spend')) return send(res, 200, reg.spend())

    if (route('GET', 'agents', ':agent', 'models')) {
      const repo = url.searchParams.get('repo') ?? process.cwd()
      return send(res, 200, await reg.models(parts[1] as AgentId, repo))
    }

    if (route('GET', 'tasks')) return send(res, 200, reg.list())

    if (route('POST', 'tasks')) {
      const request = validateDelegate(body)
      const summary = await reg.delegate(request)
      let mainDirty = false
      try {
        mainDirty = await isDirty(request.repoPath)
      } catch (err) {
        console.error('[server] could not check the main tree for changes:', err)
      }
      return send(res, 200, { ...summary, mainDirty })
    }

    if (parts[0] === 'tasks' && parts.length >= 2) {
      const id = parts[1]!
      if (route('GET', 'tasks', ':id')) return send(res, 200, reg.get(id).detail(url.searchParams.get('full') === '1'))
      if (route('GET', 'tasks', ':id', 'diff')) return send(res, 200, await reg.diff(id))
      if (route('POST', 'tasks', ':id', 'merge')) return send(res, 200, await reg.merge(id))
      if (route('POST', 'tasks', ':id', 'cancel')) {
        const task = reg.get(id)
        await task.cancel()
        return send(res, 200, task.summary())
      }
      if (route('POST', 'tasks', ':id', 'reply')) {
        const task = reg.get(id)
        if (!isText(body.text)) throw badRequest('text must be a non-empty string')
        await task.reply(body.text, optionalBool(body.fromUser, 'fromUser'))
        return send(res, 200, task.summary())
      }
      if (route('POST', 'tasks', ':id', 'answer')) {
        const task = reg.get(id)
        if (!isText(body.requestId)) throw badRequest('requestId must be a non-empty string')
        if (!isText(body.optionId)) throw badRequest('optionId must be a non-empty string')
        if (body.note !== undefined && typeof body.note !== 'string') throw badRequest('note must be a string')
        task.answer(body.requestId, body.optionId, body.note as string | undefined, optionalBool(body.fromUser, 'fromUser'))
        return send(res, 200, task.summary())
      }
      if (route('POST', 'tasks', ':id', 'escalate')) {
        const task = reg.get(id)
        if (!isText(body.question)) throw badRequest('question must be a non-empty string')
        task.escalate(body.question)
        return send(res, 200, task.summary())
      }
    }
    throw new HttpError(404, 'not_found', `no route for ${method} ${url.pathname}`)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, code: err.code })
      if (err instanceof RelayError) return send(res, err.code === 'no_such_task' ? 404 : 400, { error: err.message, code: err.code })
      console.error('[server] unexpected error:', err)
      send(res, 500, { error: 'internal error', code: 'internal' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port

  return {
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function optionalBool(v: unknown, name: string): boolean {
  if (v === undefined) return false
  if (typeof v !== 'boolean') throw badRequest(`${name} must be a boolean`)
  return v
}
