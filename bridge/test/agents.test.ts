import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { AGENT_IDS, agentSpec, resolveNpmRoot } from '../src/agents.ts'

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
})
