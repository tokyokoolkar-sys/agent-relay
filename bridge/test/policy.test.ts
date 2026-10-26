import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyPermission, isInside, isOutOfCredits, type PermissionParams } from '../src/policy.ts'
import { isDotGit } from '../src/worktree.ts'

// A real directory: the policy checks the filesystem for links, and fails closed when the worktree does not exist.
let base = ''
let WT = ''
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'policy-')))
  WT = join(base, 'wt')
  mkdirSync(join(WT, 'sub'), { recursive: true })
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const ccOptions = ['allow_once', 'allow_always', 'reject_once', 'reject_always'].map((k) => ({ optionId: k, name: k, kind: k }))
const write = (file: string, extra: Partial<PermissionParams['toolCall']> = {}): PermissionParams => ({
  sessionId: 's1',
  toolCall: { toolCallId: 'call_1', title: `Write: ${file}`, kind: 'edit', rawInput: { file_path: file, content: 'hi\n' }, locations: [{ path: file }], ...extra },
  options: ccOptions,
})

describe('classifyPermission', () => {
  it('routes the Command Code ask-user payload to a question', () => {
    const p: PermissionParams = {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'call_00_x',
        title: 'Color: Which color do you prefer for the next step?',
        kind: 'other',
        rawInput: { question: 'Which color do you prefer for the next step?', options: ['Blue', 'Green', 'Red', 'Purple'] },
      },
      options: ['Blue', 'Green', 'Red', 'Purple'].map((n, i) => ({ optionId: `option_${i}`, name: `${n}: Use ${n}.`, kind: 'allow_once' })),
    }
    const d = classifyPermission(p, WT, 'r1')
    expect(d.action).toBe('question')
    if (d.action !== 'question') return
    expect(d.pending.type).toBe('question')
    expect(d.pending.requestId).toBe('r1')
    expect(d.pending.options).toHaveLength(4)
  })

  it('does not treat a question with non option_N ids as a question', () => {
    const p: PermissionParams = {
      sessionId: 's1',
      toolCall: { toolCallId: 'c', kind: 'other', rawInput: { question: 'q' } },
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
    }
    expect(classifyPermission(p, WT, 'r').action).toBe('claude')
  })

  it('auto-allows a Command Code Write inside the worktree with the allow_once option', () => {
    const d = classifyPermission(write(`${WT}\\hello.txt`), WT, 'r')
    expect(d).toMatchObject({ action: 'auto', optionId: 'allow_once' })
  })

  it('picks the allow_once option by kind, never allow_always', () => {
    const p = write(`${WT}\\hello.txt`)
    p.options = [
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'once', name: 'Once', kind: 'allow_once' },
    ]
    expect(classifyPermission(p, WT, 'r')).toMatchObject({ action: 'auto', optionId: 'once' })
    p.options = [{ optionId: 'always', name: 'Always', kind: 'allow_always' }]
    expect(classifyPermission(p, WT, 'r').action).toBe('claude')
  })

  it('resolves relative paths against the worktree', () => {
    expect(classifyPermission(write('sub\\a.txt'), WT, 'r').action).toBe('auto')
    expect(classifyPermission(write('..\\..\\secret.txt'), WT, 'r').action).toBe('claude')
  })

  it('sends a Write outside the worktree to Claude', () => {
    const d = classifyPermission(write('C:\\elsewhere\\x.txt'), WT, 'r')
    expect(d.action).toBe('claude')
    if (d.action === 'claude') expect(d.pending.type).toBe('permission')
  })

  it('sends a request when any one of several paths is outside', () => {
    const p = write(`${WT}\\a.txt`)
    p.toolCall.locations = [{ path: `${WT}\\a.txt` }, { path: 'C:\\elsewhere\\b.txt' }]
    expect(classifyPermission(p, WT, 'r').action).toBe('claude')
    const q = write(`${WT}\\a.txt`)
    q.toolCall.rawInput = { filePath: 'C:\\elsewhere\\b.txt' }
    expect(classifyPermission(q, WT, 'r').action).toBe('claude')
    const s = write(`${WT}\\a.txt`)
    s.toolCall.rawInput = { path: 'C:\\elsewhere\\b.txt' }
    expect(classifyPermission(s, WT, 'r').action).toBe('claude')
  })

  it('fails closed on an edit or read with no path at all', () => {
    const p = write(`${WT}\\a.txt`)
    p.toolCall.locations = undefined
    p.toolCall.rawInput = { content: 'x' }
    expect(classifyPermission(p, WT, 'r').action).toBe('claude')
    p.toolCall.kind = 'read'
    expect(classifyPermission(p, WT, 'r').action).toBe('claude')
  })

  it('auto-allows a read inside the worktree', () => {
    const p = write(`${WT}\\a.txt`, { kind: 'read', rawInput: { file_path: `${WT}\\a.txt` } })
    expect(classifyPermission(p, WT, 'r').action).toBe('auto')
  })

  it('never auto-allows delete or move, nor a delete/rm intent', () => {
    expect(classifyPermission(write(`${WT}\\a.txt`, { kind: 'delete' }), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\a.txt`, { kind: 'move' }), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\a.txt`, { rawInput: { file_path: `${WT}\\a.txt`, delete: true } }), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\a.txt`, { rawInput: { file_path: `${WT}\\a.txt`, rm: true } }), WT, 'r').action).toBe('claude')
  })

  it('never auto-allows a path with a .git component, even inside the worktree', () => {
    expect(classifyPermission(write(`${WT}\\.git\\config`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\sub\\.GIT\\hooks\\x`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\sub\\.git.\\hooks\\x`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}/sub/.git /x`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\.gitignore`), WT, 'r').action).toBe('auto')
  })

  it.each([
    ['new_path', 'C:\\elsewhere\\moved.txt'],
    ['destination', 'C:\\elsewhere\\d.txt'],
    ['paths', ['C:\\elsewhere\\d.txt']],
    ['edits', [{ file_path: 'C:\\elsewhere\\d.txt' }]],
    ['cwd', 'C:\\elsewhere'],
    ['operation', 'delete'],
    ['notebook_path', 'C:\\elsewhere\\n.ipynb'],
  ])('escalates an edit carrying the unlisted rawInput key %s', (key, value) => {
    const f = join(WT, 'a.txt')
    expect(classifyPermission(write(f, { rawInput: { file_path: f, content: 'x', [key]: value } }), WT, 'r').action).toBe('claude')
  })

  it('escalates a read carrying an edit-only key', () => {
    const f = join(WT, 'a.txt')
    expect(classifyPermission(write(f, { kind: 'read', rawInput: { file_path: f, content: 'x' } }), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(f, { kind: 'read', rawInput: { file_path: f, offset: 1, limit: 5 } }), WT, 'r').action).toBe('auto')
  })

  it('escalates, without throwing, on malformed shapes', () => {
    const f = join(WT, 'a.txt')
    const bad = (mutate: (p: any) => void) => {
      const p: any = write(f)
      mutate(p)
      const d = classifyPermission(p, WT, 'r')
      expect(d.action).toBe('claude')
    }
    bad((p) => (p.toolCall.rawInput = 'file_path'))
    bad((p) => (p.toolCall.rawInput = null))
    bad((p) => (p.toolCall.rawInput = [f]))
    bad((p) => (p.toolCall.locations = f))
    bad((p) => (p.toolCall.locations = [{ nope: f }]))
    bad((p) => (p.toolCall.locations = [null]))
    bad((p) => (p.toolCall.locations = [{ path: 5 }]))
    bad((p) => (p.options = undefined))
    bad((p) => (p.options = 'allow_once'))
    bad((p) => (p.toolCall = undefined))
    bad((p) => (p.toolCall.rawInput = { file_path: 5 }))
    expect(classifyPermission(undefined as any, WT, 'r').action).toBe('claude')
    expect(classifyPermission({} as any, WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(f), undefined as any, 'r').action).toBe('claude')
  })

  it('escalates NTFS aliases of .git and other aliasing spellings', () => {
    for (const rel of ['.git::$DATA', '.git::$INDEX_ALLOCATION\\config', 'GIT~1\\config', 'sub\\git~2\\x', 'sub\\.git.\\x', 'sub\\.GIT \\x']) {
      expect(classifyPermission(write(`${WT}\\${rel}`), WT, 'r').action, rel).toBe('claude')
    }
    expect(classifyPermission(write(`${WT}\\sub\\a.txt::$DATA`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\sub\\a.txt:stream`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\LONGFI~1.txt`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`file://${WT}/a.txt`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write('C:foo.txt'), WT, 'r').action).toBe('claude')
  })

  it('escalates a path reached through a junction pointing outside the worktree, and allows a normal nested dir', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(WT, 'j'), 'junction')
    expect(classifyPermission(write(join(WT, 'j', 'x.txt')), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write('j/x.txt'), WT, 'r').action).toBe('claude')
    // an existing file reached through the link, and the link itself
    writeFileSync(join(outside, 'e.txt'), 'x')
    expect(classifyPermission(write(join(WT, 'j', 'e.txt')), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(join(WT, 'j')), WT, 'r').action).toBe('claude')
    // normal nested directory, existing and not yet existing
    expect(classifyPermission(write(join(WT, 'sub', 'x.txt')), WT, 'r').action).toBe('auto')
    expect(classifyPermission(write(join(WT, 'sub', 'new', 'deeper', 'x.txt')), WT, 'r').action).toBe('auto')
  })

  it('fails closed when the worktree does not exist', () => {
    const gone = join(base, 'nope')
    expect(classifyPermission(write(join(gone, 'a.txt')), gone, 'r').action).toBe('claude')
  })

  it('sends the OpenCode shell payload to Claude', () => {
    const p: PermissionParams = {
      sessionId: 's2',
      toolCall: { toolCallId: 't', title: 'git status', kind: 'execute', rawInput: { command: 'git status', cwd: 'C:/repo/.relay/wt/oc-1' } },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    }
    const d = classifyPermission(p, 'C:\\repo\\.relay\\wt\\oc-1', 'r9')
    expect(d.action).toBe('claude')
    if (d.action === 'claude') {
      expect(d.pending).toMatchObject({ requestId: 'r9', type: 'permission', title: 'git status', toolKind: 'execute' })
      // the "always allow" option is never offered to Claude
      expect(d.pending.options.map((o) => o.optionId)).toEqual(['once', 'reject'])
    }
  })

  it('strips allow_always but keeps reject_always from a Command Code permission sent to Claude', () => {
    const p: PermissionParams = {
      sessionId: 's1',
      toolCall: { toolCallId: 't', title: 'Bash: npm test', kind: 'execute', rawInput: { command: 'npm test' } },
      options: ccOptions,
    }
    const d = classifyPermission(p, WT, 'r')
    expect(d.action).toBe('claude')
    if (d.action === 'claude') expect(d.pending.options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once', 'reject_always'])
  })

  it('keeps every answer of a Command Code question (option_N, all allow_once)', () => {
    const p: PermissionParams = {
      sessionId: 's1',
      toolCall: { toolCallId: 'q', title: 'Q', kind: 'other', rawInput: { question: 'Which?' } },
      options: ['a', 'b', 'c'].map((n, i) => ({ optionId: `option_${i}`, name: n, kind: 'allow_once' })),
    }
    const d = classifyPermission(p, WT, 'r')
    expect(d.action).toBe('question')
    if (d.action === 'question') expect(d.pending.options.map((o) => o.optionId)).toEqual(['option_0', 'option_1', 'option_2'])
  })

  it('escalates an edit or a read of an existing file that has another hard link; plain files still auto-allow', () => {
    const outside = join(base, 'outside-hl')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
    linkSync(join(outside, 'secret.txt'), join(WT, 'hl.txt'))
    expect(classifyPermission(write(join(WT, 'hl.txt')), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(join(WT, 'hl.txt'), { kind: 'read', rawInput: { file_path: join(WT, 'hl.txt') } }), WT, 'r').action).toBe('claude')
    writeFileSync(join(WT, 'plain.txt'), 'x')
    expect(classifyPermission(write(join(WT, 'plain.txt')), WT, 'r').action).toBe('auto')
    expect(classifyPermission(write(join(WT, 'plain.txt'), { kind: 'read', rawInput: { file_path: join(WT, 'plain.txt') } }), WT, 'r').action).toBe('auto')
  })

  it('refuses a raw path with a .. component, even one that stays inside', () => {
    expect(classifyPermission(write('sub/../a.txt'), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}\\sub\\..\\a.txt`), WT, 'r').action).toBe('claude')
    expect(classifyPermission(write(`${WT}/sub/../a.txt`), WT, 'r').action).toBe('claude')
  })

  it('auto-allows inside a worktree whose own path has an 8.3-style component (USERNA~1); still escalates one below it', () => {
    const shortWt = join(base, 'USERNA~1', 'wt')
    mkdirSync(join(shortWt, 'sub'), { recursive: true })
    expect(classifyPermission(write(join(shortWt, 'sub', 'a.txt')), shortWt, 'r').action).toBe('auto')
    expect(classifyPermission(write('sub/a.txt'), shortWt, 'r').action).toBe('auto')
    expect(classifyPermission(write(join(shortWt, 'LONGFI~1.txt')), shortWt, 'r').action).toBe('claude')
    expect(classifyPermission(write(join(shortWt, 'GIT~1', 'config')), shortWt, 'r').action).toBe('claude')
  })
})

describe.runIf(process.platform === 'win32')('isInside (win32)', () => {
  it('is case-insensitive and normalises separators', () => {
    expect(isInside('c:/Repo/.relay/wt/oc-1/a.txt', 'C:\\repo\\.relay\\wt\\oc-1')).toBe(true)
  })
  it('resolves .. segments', () => {
    expect(isInside('C:/repo/.relay/wt/oc-1/../../secret', 'C:/repo/.relay/wt/oc-1')).toBe(false)
  })
  it('requires a separator boundary', () => {
    expect(isInside('C:\\wt-evil\\a', 'C:\\wt')).toBe(false)
    expect(isInside('C:\\wt\\a', 'C:\\wt')).toBe(true)
    expect(isInside('C:\\wt', 'C:\\wt')).toBe(true)
  })
})

describe('isOutOfCredits', () => {
  it.each(['Insufficient credits for deepseek/deepseek-v4-pro.', 'Premium credits exhausted', 'Usage limit reached', 'usage limit for your plan'])('detects %s', (t) => {
    expect(isOutOfCredits(t)).toBe(true)
  })
  it.each(['all tests passed', 'Rate limit exceeded, retry in 20s', 'out of credits', 'quota exceeded'])('ignores %s', (t) => {
    expect(isOutOfCredits(t)).toBe(false)
  })
})

describe('isDotGit', () => {
  it.each(['.git', '.GIT', '.git.', '.git ', '.git::$DATA', '.git::$INDEX_ALLOCATION', '.Git:x', 'GIT~1', 'git~12', 'GIT~1.'])('matches %s', (n) => {
    expect(isDotGit(n)).toBe(true)
  })
  it.each(['.gitignore', '.github', 'git', 'git~', 'a.git', 'GIT~x', ''])('does not match %s', (n) => {
    expect(isDotGit(n)).toBe(false)
  })
})
