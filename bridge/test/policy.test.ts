import { describe, expect, it } from 'vitest'
import { classifyPermission, isInside, isOutOfCredits, type PermissionParams } from '../src/policy.ts'

const WT = 'C:\\repo\\.relay\\wt\\cc-1'

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
    const p = write(`${WT}\\a.txt`, { kind: 'read' })
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
      expect(d.pending.options).toHaveLength(3)
    }
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
  it.each(['Insufficient credits for deepseek/deepseek-v4-pro.', 'Premium credits exhausted', 'Usage limit reached'])('detects %s', (t) => {
    expect(isOutOfCredits(t)).toBe(true)
  })
  it('ignores ordinary text', () => {
    expect(isOutOfCredits('all tests passed')).toBe(false)
  })
})
