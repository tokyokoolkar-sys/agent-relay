import { exec } from 'node:child_process'
import { join } from 'node:path'
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

/** `npm root -g`, resolved once at startup by the caller. */
export function resolveNpmRoot(): Promise<string> {
  return new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which can only run through a shell; the command is a constant.
    exec('npm root -g', { windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error(`could not resolve the global npm root: ${err.message}`))
      else resolve(stdout.trim())
    })
  })
}
