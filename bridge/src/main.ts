import { resolveNpmRoot } from './agents.ts'
import { TaskRegistry } from './registry.ts'
import { startServer } from './server.ts'
import type { BridgeEvent } from './types.ts'

// stdout carries only the ready line and BridgeEvents, one JSON object per line. Anything else that logs goes to stderr.
const write = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n')
console.log = console.info = console.debug = console.error

const SHUTDOWN_GRACE_MS = 15_000

async function main(): Promise<void> {
  const npmRoot = await resolveNpmRoot()
  const registry = new TaskRegistry(npmRoot, (e: BridgeEvent) => write(e))
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
