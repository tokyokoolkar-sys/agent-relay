import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RpcPeer } from '../src/rpc.ts'

function pair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new RpcPeer(aToB, bToA)
  const b = new RpcPeer(bToA, aToB)
  return { a, b, aToB, bToA }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('RpcPeer', () => {
  it("request resolves with the peer's result", async () => {
    const { a, b } = pair()
    b.onRequest(async () => ({ ok: 1 }))
    await expect(a.request('x', {})).resolves.toEqual({ ok: 1 })
  })

  it('request rejects on error response', async () => {
    const { a, b } = pair()
    b.onRequest(async () => {
      throw new Error('nope')
    })
    await expect(a.request('x', {})).rejects.toThrow(/nope/)
  })

  it('notifications reach onNotification', async () => {
    const { a, b } = pair()
    const handler = vi.fn()
    b.onNotification(handler)
    a.notify('session/update', { a: 1 })
    await tick()
    expect(handler).toHaveBeenCalledWith('session/update', { a: 1 })
  })

  it('split and joined lines parse', async () => {
    const { b, aToB } = pair()
    const handler = vi.fn()
    b.onNotification(handler)
    aToB.write('{"jsonrpc":"2.0","method":"m","params":{}}\n{"jsonrpc"')
    aToB.write(':"2.0","method":"m","params":{}}\n')
    await tick()
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('close rejects pending', async () => {
    const { a, b } = pair()
    b.onRequest(() => new Promise(() => {})) // never answers
    const p = a.request('x', {})
    const reason = new Error('agent exited')
    a.close(reason)
    await expect(p).rejects.toBe(reason)
  })
})
