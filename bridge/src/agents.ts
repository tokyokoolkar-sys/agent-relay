import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentId } from './types.ts'

export type AgentSpec = {
  id: AgentId
  short: 'oc' | 'cc'
  label: string
  command: string
  args: string[]
  env: Record<string, string>
}

export const AGENT_IDS: readonly AgentId[] = ['opencode', 'commandcode']

const OPENCODE_CONFIG = { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' } }

/** How to launch an agent's ACP server. Spawns the real binaries, never the .ps1/.cmd shims. */
export function agentSpec(id: AgentId, npmRoot: string): AgentSpec {
  const base: AgentSpec =
    id === 'opencode'
      ? {
          id,
          short: 'oc',
          label: 'OpenCode',
          command: join(npmRoot, '@opencode', 'cli', 'bin', 'opencode.exe'),
          args: ['acp'],
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_CONFIG) },
        }
      : {
          id,
          short: 'cc',
          label: 'Command Code',
          command: process.execPath,
          args: [join(npmRoot, 'command-code', 'dist', 'index.mjs'), 'acp'],
          env: {},
        }

  // Test-only: substitute the fake ACP agent while keeping the real identity.
  const fake = process.env.RELAY_FAKE_AGENT
  if (fake) return { ...base, command: process.execPath, args: [fake] }
  return base
}

/**
 * The global npm root (`npm root -g`), resolved once at startup by the caller. Never through a shell: cmd.exe would
 * look for `npm` in the current directory first, so a planted npm.cmd there would run. Instead node runs the
 * npm-cli.js that ships beside it, from the temp dir; without one, the default Windows location
 * `%APPDATA%\npm\node_modules` is assumed. `execPath` and `appData` are for tests.
 */
export function resolveNpmRoot(opts: { execPath?: string; appData?: string } = {}): Promise<string> {
  const execPath = opts.execPath ?? process.execPath
  const appData = opts.appData ?? process.env.APPDATA ?? ''
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(cli)) {
    if (appData === '') return Promise.reject(new Error(`could not resolve the global npm root: no ${cli} and no APPDATA`))
    return Promise.resolve(join(appData, 'npm', 'node_modules'))
  }
  return new Promise((resolve, reject) => {
    execFile(execPath, [cli, 'root', '-g'], { cwd: tmpdir(), windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error(`could not resolve the global npm root: ${err.message}`))
      else resolve(stdout.trim())
    })
  })
}
