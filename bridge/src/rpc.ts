import type { Readable, Writable } from 'node:stream'

type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void }
type RequestHandler = (method: string, params: any) => Promise<unknown>
type NotificationHandler = (method: string, params: any) => void

/** Newline-delimited JSON-RPC 2.0 peer over a pair of streams (the ACP wire format). */
export class RpcPeer {
  #stdin: Writable
  #nextId = 1
  #pending = new Map<number | string, Pending>()
  #buffer = ''
  #closed: Error | undefined
  #requestHandler: RequestHandler | undefined
  #notificationHandler: NotificationHandler | undefined

  constructor(stdin: Writable, stdout: Readable) {
    this.#stdin = stdin
    // A dead child's stdin emits EPIPE as an 'error' event; close() handles the fallout.
    stdin.on('error', () => {})
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => this.#onData(chunk))
    stdout.on('end', () => this.close(new Error('RPC stream ended')))
    stdout.on('error', (err: Error) => this.close(err))
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return
    this.#send({ jsonrpc: '2.0', method, params })
  }

  onRequest(h: RequestHandler): void {
    this.#requestHandler = h
  }

  onNotification(h: NotificationHandler): void {
    this.#notificationHandler = h
  }

  close(reason: Error): void {
    if (this.#closed) return
    this.#closed = reason
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const p of pending) p.reject(reason)
  }

  #send(message: object): void {
    this.#stdin.write(JSON.stringify(message) + '\n')
  }

  #onData(chunk: string): void {
    this.#buffer += chunk
    let nl: number
    while ((nl = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, nl).trim()
      this.#buffer = this.#buffer.slice(nl + 1)
      if (line) this.#onLine(line)
    }
  }

  #onLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return // non-JSON output (logs, banners) is ignored
    }
    if (typeof msg !== 'object' || msg === null) return

    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) void this.#handleRequest(msg.id, msg.method, msg.params)
      else this.#notificationHandler?.(msg.method, msg.params)
      return
    }

    if (msg.id !== undefined && msg.id !== null) {
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? `RPC error ${msg.error.code}`))
      else p.resolve(msg.result)
    }
  }

  async #handleRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.#requestHandler) {
      this.#respond({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    try {
      const result = await this.#requestHandler(method, params)
      this.#respond({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#respond({ jsonrpc: '2.0', id, error: { code: -32603, message } })
    }
  }

  #respond(message: object): void {
    if (!this.#closed) this.#send(message)
  }
}
