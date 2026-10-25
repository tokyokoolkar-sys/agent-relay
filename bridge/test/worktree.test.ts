import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { RelayError, assertRepo, commitAll, createWorktree, diff, isDirty, merge } from '../src/worktree.ts'
import { cleanupRepos, git, makePlainDir, makeRepo } from './helpers.ts'

afterEach(cleanupRepos)

const norm = (p: string) => resolve(p).replaceAll('\\', '/').toLowerCase()

describe('assertRepo', () => {
  it('rejects a plain directory with not_a_repo', async () => {
    const dir = await makePlainDir()
    await expect(assertRepo(dir)).rejects.toMatchObject({ code: 'not_a_repo' })
    await expect(assertRepo(dir)).rejects.toBeInstanceOf(RelayError)
  })

  it('rejects a missing directory with not_a_repo', async () => {
    const dir = await makePlainDir()
    await expect(assertRepo(join(dir, 'nope'))).rejects.toMatchObject({ code: 'not_a_repo' })
  })

  it('rejects a repo without commits with no_commits', async () => {
    const dir = await makePlainDir()
    await git(dir, 'init', '-b', 'main')
    await expect(assertRepo(dir)).rejects.toMatchObject({ code: 'no_commits' })
  })

  it('accepts a repo with a commit', async () => {
    await expect(assertRepo(await makeRepo())).resolves.toBeUndefined()
  })
})

describe('createWorktree', () => {
  it('creates .relay/wt/<id> on branch relay/<id> from HEAD and excludes .relay/', async () => {
    const repo = await makeRepo()
    const head = await git(repo, 'rev-parse', 'HEAD')
    const wt = await createWorktree(repo, 'oc-1')
    expect(norm(wt.path)).toBe(norm(join(repo, '.relay', 'wt', 'oc-1')))
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true)
    expect(wt.branch).toBe('relay/oc-1')
    expect(wt.base).toBe(head)
    expect(await git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('relay/oc-1')
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.relay/')
    expect(await isDirty(repo)).toBe(false)
  })

  it('does not duplicate the exclude entry across worktrees', async () => {
    const repo = await makeRepo()
    await createWorktree(repo, 'oc-1')
    await createWorktree(repo, 'oc-2')
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((l) => l.trim() === '.relay/')).toHaveLength(1)
  })
})

describe('commitAll and diff', () => {
  it('commits once then reports nothing to commit', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    expect(await isDirty(wt.path)).toBe(false)
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    expect(await isDirty(wt.path)).toBe(true)
    expect(await commitAll(wt.path, 'add new file')).toBe(true)
    expect(await isDirty(wt.path)).toBe(false)
    expect(await commitAll(wt.path, 'again')).toBe(false)
    expect(await git(wt.path, 'log', '-1', '--format=%an <%ae>')).toBe('Agent Relay <relay@localhost>')
  })

  it('diff lists the new file in stat and patch', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await commitAll(wt.path, 'add new file')
    const d = await diff(repo, wt.base, wt.branch)
    expect(d.stat).toContain('new.txt')
    expect(d.patch).toContain('+hello')
  })
})

describe('merge', () => {
  it('merges into a clean main with a --no-ff commit', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await commitAll(wt.path, 'add new file')
    const res = await merge(repo, wt.branch, 'Merge oc-1')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.commit).toBe(await git(repo, 'rev-parse', 'HEAD'))
    expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('hello\n')
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('Merge oc-1')
    expect((await git(repo, 'log', '-1', '--format=%P')).split(' ')).toHaveLength(2)
  })

  it('refuses when the main tree is dirty', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await commitAll(wt.path, 'add new file')
    await writeFile(join(repo, 'README.md'), 'uncommitted\n')
    const res = await merge(repo, wt.branch, 'Merge oc-1')
    expect(res).toMatchObject({ ok: false, reason: 'dirty' })
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
  })

  it('reports conflicting paths and leaves main clean', async () => {
    const repo = await makeRepo()
    const a = await createWorktree(repo, 'oc-1')
    const b = await createWorktree(repo, 'oc-2')
    await writeFile(join(a.path, 'README.md'), 'line one\nfrom A\n')
    await commitAll(a.path, 'A edits')
    await writeFile(join(b.path, 'README.md'), 'line one\nfrom B\n')
    await commitAll(b.path, 'B edits')
    expect((await merge(repo, a.branch, 'Merge oc-1')).ok).toBe(true)
    const res = await merge(repo, b.branch, 'Merge oc-2')
    expect(res).toEqual({ ok: false, reason: 'conflict', paths: ['README.md'] })
    expect(await git(repo, 'status', '--porcelain')).toBe('')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('line one\nfrom A\n')
  })
})
