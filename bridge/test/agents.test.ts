import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_IDS, agentSpec, resolveNpmRoot } from '../src/agents.ts'

// Records how the bridge runs processes: resolving the npm root must never go through a shell.
const calls = vi.hoisted(() => ({ exec: 0, execFile: [] as { file: string; args: readonly string[]; cwd: unknown }[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const exec = ((...args: unknown[]) => {
    calls.exec++
    return (actual.exec as any)(...args)
  }) as typeof actual.exec
  const execFile = ((file: string, args: readonly string[], opts: any, ...rest: unknown[]) => {
    calls.execFile.push({ file, args, cwd: opts?.cwd })
    return (actual.execFile as any)(file, args, opts, ...rest)
  }) as typeof actual.execFile
  return { ...actual, exec, execFile }
})

const R = join('C:', 'fake', 'npm', 'node_modules')

describe('agentSpec', () => {
  afterEach(() => {
    delete process.env.RELAY_FAKE_AGENT
  })

  it('builds the OpenCode spec', () => {
    const s = agentSpec('opencode', R)
    expect(s.id).toBe('opencode')
    expect(s.short).toBe('oc')
    expect(s.command.replaceAll('\\', '/').endsWith('@opencode/cli/bin/opencode.exe')).toBe(true)
    expect(s.args).toEqual(['acp'])
    expect(JSON.parse(s.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' } })
  })

  it('builds the Command Code spec on node, never a shim', () => {
    const s = agentSpec('commandcode', R)
    expect(s.id).toBe('commandcode')
    expect(s.short).toBe('cc')
    expect(s.command).toBe(process.execPath)
    expect(s.args).toEqual([join(R, 'command-code', 'dist', 'index.mjs'), 'acp'])
    expect(s.env).toEqual({})
  })

  it('lists both agent ids', () => {
    expect([...AGENT_IDS]).toEqual(['opencode', 'commandcode'])
  })

  it('RELAY_FAKE_AGENT overrides command and args but keeps short and label', () => {
    const real = agentSpec('opencode', R)
    process.env.RELAY_FAKE_AGENT = '/some/fake-agent.ts'
    const s = agentSpec('opencode', R)
    expect(s.command).toBe(process.execPath)
    expect(s.args).toEqual(['/some/fake-agent.ts'])
    expect(s.short).toBe('oc')
    expect(s.label).toBe(real.label)
    expect(agentSpec('commandcode', R).short).toBe('cc')
  })
})

describe('resolveNpmRoot', () => {
  it('returns a non-empty trimmed npm global root', async () => {
    const root = await resolveNpmRoot()
    expect(root.length).toBeGreaterThan(0)
    expect(root).toBe(root.trim())
  })

  it("runs npm-cli.js with node's own path, no shell, from the temp dir", async () => {
    calls.exec = 0
    calls.execFile.length = 0
    await resolveNpmRoot()
    expect(calls.exec).toBe(0)
    expect(calls.execFile).toHaveLength(1)
    const [call] = calls.execFile
    expect(call!.file).toBe(process.execPath)
    expect(call!.args[0]).toBe(join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    expect(call!.args.slice(1)).toEqual(['root', '-g'])
    expect(call!.cwd).toBe(tmpdir())
  })

  it('falls back to APPDATA/npm/node_modules when node has no npm beside it, running nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-nonpm-'))
    try {
      calls.exec = 0
      calls.execFile.length = 0
      const root = await resolveNpmRoot({ execPath: join(dir, 'node.exe'), appData: join('C:', 'Users', 'u', 'AppData', 'Roaming') })
      expect(root).toBe(join('C:', 'Users', 'u', 'AppData', 'Roaming', 'npm', 'node_modules'))
      expect(calls.exec).toBe(0)
      expect(calls.execFile).toHaveLength(0)
      await expect(resolveNpmRoot({ execPath: join(dir, 'node.exe'), appData: '' })).rejects.toThrow(/npm root/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
