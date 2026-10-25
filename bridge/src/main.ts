import { resolveNpmRoot } from './agents.ts'
import { TaskRegistry } from './registry.ts'
import { startServer } from './server.ts'
import type { BridgeEvent } from './types.ts'

// stdout carries only the ready line and BridgeEvents, one JSON object per line. Anything else that logs goes to stderr.
const write = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n')
console.log = console.info = console.debug = console.error

const SHUTDOWN_GRACE_MS = 15_000

// Test-only crash injection: RELAY_TEST_CRASH=throw|reject makes the bridge crash once a task's turn is running.
const crashMode = process.env.RELAY_TEST_CRASH
let registryRef: TaskRegistry | undefined

// Last resort: never leave agents running behind a dead bridge.
function crash(kind: string, err: unknown): never {
  try {
    console.error(`[bridge] ${kind}:`, err)
    const n = registryRef?.killAllNow() ?? 0
    console.error(`[bridge] killed ${n} agent process tree(s) before exiting`)
  } finally {
    process.exit(1)
  }
}
process.on('uncaughtException', (err) => crash('uncaught exception', err))
process.on('unhandledRejection', (err) => crash('unhandled rejection', err))

async function main(): Promise<void> {
  const npmRoot = await resolveNpmRoot()
  let crashed = false
  const registry = new TaskRegistry(npmRoot, (e: BridgeEvent) => {
    write(e)
    if (crashMode && !crashed && e.type === 'task' && e.task.status === 'running') {
      crashed = true
      setImmediate(() => {
        if (crashMode === 'reject') void Promise.reject(new Error('injected rejection'))
        else throw new Error('injected exception')
      })
    }
  })
  registryRef = registry
  const server = await startServer(registry)

  let shuttingDown = false
  const shutdown = async (why: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[bridge] shutting down (${why})`)
    const grace = new Promise<void>((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref())
    await Promise.race([Promise.all([server.close(), registry.shutdown()]), grace]).catch((err) => console.error('[bridge] shutdown error:', err))
    process.exit(0)
  }

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig))
  process.stdin.on('end', () => void shutdown('stdin closed'))
  process.stdin.on('close', () => void shutdown('stdin closed'))
  process.stdin.on('error', () => void shutdown('stdin error'))
  process.stdout.on('error', () => void shutdown('stdout closed'))
  process.stdin.resume()

  write({ type: 'ready', port: server.port, token: server.token })
}

main().catch((err) => {
  console.error('[bridge] fatal:', err)
  process.exit(1)
})
