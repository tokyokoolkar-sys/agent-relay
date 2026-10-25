import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GIT_TIMEOUT_MS, RelayError, assertRepo, commitAll, createWorktree, diff, isDirty, merge, resolveGit } from '../src/worktree.ts'
import { cleanupRepos, git, makePlainDir, makeRepo } from './helpers.ts'

const failMergeAbort = vi.hoisted(() => ({ on: false }))
const hangGit = vi.hoisted(() => ({ on: false, timeouts: [] as unknown[] }))

// Pass-through wrapper so tests can make `git merge --abort` fail, or make git hang, on demand.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((file: string, args: string[], ...rest: any[]) => {
    if (hangGit.on) {
      // Stand-in for a git that never finishes: a sleeping node process, run with the caller's options except
      // for a tiny timeout, so the real kill-on-timeout path runs.
      const [opts, cb] = rest as [Record<string, unknown>, (...a: any[]) => void]
      hangGit.timeouts.push(opts.timeout)
      return (actual.execFile as any)(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { ...opts, timeout: 300 }, cb)
    }
    if (failMergeAbort.on && args.includes('--abort')) {
      const cb = rest.at(-1) as (err: Error, stdout: string, stderr: string) => void
      queueMicrotask(() => cb(Object.assign(new Error('simulated'), { code: 128 }), '', 'fatal: simulated abort failure'))
      return undefined as never
    }
    return (actual.execFile as any)(file, args, ...rest)
  }) as typeof actual.execFile
  return { ...actual, execFile }
})

afterEach(async () => {
  failMergeAbort.on = false
  hangGit.on = false
  await cleanupRepos()
})

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
    expect(await commitAll(wt.path, 'add new file', wt.base)).toBe(true)
    expect(await isDirty(wt.path)).toBe(false)
    expect(await commitAll(wt.path, 'again', wt.base)).toBe(false)
    expect(await git(wt.path, 'log', '-1', '--format=%an <%ae>')).toBe('Agent Relay <relay@localhost>')
  })

  it('diff lists the new file in stat and patch', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await commitAll(wt.path, 'add new file', wt.base)
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
    await commitAll(wt.path, 'add new file', wt.base)
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
    await commitAll(wt.path, 'add new file', wt.base)
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
    await commitAll(a.path, 'A edits', a.base)
    await writeFile(join(b.path, 'README.md'), 'line one\nfrom B\n')
    await commitAll(b.path, 'B edits', b.base)
    expect((await merge(repo, a.branch, 'Merge oc-1')).ok).toBe(true)
    const res = await merge(repo, b.branch, 'Merge oc-2')
    expect(res).toEqual({ ok: false, reason: 'conflict', paths: ['README.md'] })
    expect(await git(repo, 'status', '--porcelain')).toBe('')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('line one\nfrom A\n')
  })
})

const fwd = (p: string) => p.replaceAll('\\', '/')

describe('hostile worktree', () => {
  it('rejects a tampered worktree .git pointer', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const other = await mkdtemp(join(tmpdir(), 'relay-evil-'))
    try {
      await rm(join(wt.path, '.git')) // hidden on Windows, so replace rather than overwrite
      await writeFile(join(wt.path, '.git'), `gitdir: ${fwd(other)}\n`)
      await writeFile(join(wt.path, 'new.txt'), 'x\n')
      await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'worktree_tampered' })
      await expect(isDirty(wt.path)).rejects.toMatchObject({ code: 'worktree_tampered' })
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('rejects a worktree whose .git was replaced by a directory', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await rm(join(wt.path, '.git'))
    await git(wt.path, 'init')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'worktree_tampered' })
  })

  it('ignores a configured fsmonitor and repository hooks', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const dir = await mkdtemp(join(tmpdir(), 'relay-marks-'))
    try {
      const fmMarker = join(dir, 'fsmonitor-ran')
      const hookMarker = join(dir, 'hook-ran')
      const script = join(dir, 'touch.js')
      await writeFile(script, `require('node:fs').writeFileSync(process.argv[2], 'x'); process.stdout.write('\\0')`)
      await git(repo, 'config', 'core.fsmonitor', `"${fwd(process.execPath)}" "${fwd(script)}" "${fwd(fmMarker)}"`)
      await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${fwd(hookMarker)}"\n`)
      await writeFile(join(wt.path, 'new.txt'), 'hello\n')
      expect(await commitAll(wt.path, 'add new file', wt.base)).toBe(true)
      expect(existsSync(fmMarker)).toBe(false)
      expect(existsSync(hookMarker)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a failing git merge --abort instead of returning conflict', async () => {
    const repo = await makeRepo()
    const a = await createWorktree(repo, 'oc-1')
    const b = await createWorktree(repo, 'oc-2')
    await writeFile(join(a.path, 'README.md'), 'line one\nfrom A\n')
    await commitAll(a.path, 'A edits', a.base)
    await writeFile(join(b.path, 'README.md'), 'line one\nfrom B\n')
    await commitAll(b.path, 'B edits', b.base)
    await merge(repo, a.branch, 'Merge oc-1')
    failMergeAbort.on = true
    await expect(merge(repo, b.branch, 'Merge oc-2')).rejects.toMatchObject({ code: 'merge_abort_failed' })
    failMergeAbort.on = false
    await git(repo, 'merge', '--abort')
  })

  it('returns unquoted paths for non-ASCII file names in conflicts', async () => {
    const repo = await makeRepo()
    const name = 'café.txt'
    await writeFile(join(repo, name), 'base\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-m', 'add cafe')
    const a = await createWorktree(repo, 'oc-1')
    const b = await createWorktree(repo, 'oc-2')
    await writeFile(join(a.path, name), 'A\n')
    await commitAll(a.path, 'A', a.base)
    await writeFile(join(b.path, name), 'B\n')
    await commitAll(b.path, 'B', b.base)
    await merge(repo, a.branch, 'm1')
    expect(await merge(repo, b.branch, 'm2')).toEqual({ ok: false, reason: 'conflict', paths: [name] })
  })
})

describe('embedded repositories, git resolution, hooks, textconv', () => {
  const fs = () => import('node:fs/promises')

  it('refuses a nested repo with a clean filter and never runs the filter', async () => {
    const { mkdir } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const dir = await mkdtemp(join(tmpdir(), 'relay-marks-'))
    try {
      const marker = join(dir, 'filter-ran')
      const script = join(dir, 'touch.js')
      await writeFile(script, `require('node:fs').writeFileSync(process.argv[2], 'x'); process.stdout.write(require('node:fs').readFileSync(0))`)
      const nested = join(wt.path, 'sub', 'nested')
      await mkdir(nested, { recursive: true })
      await git(nested, 'init', '-b', 'main')
      await git(nested, 'config', 'user.name', 'Evil')
      await git(nested, 'config', 'user.email', 'evil@localhost')
      await git(nested, 'commit', '--allow-empty', '-m', 'init')
      await git(nested, 'config', 'filter.x.clean', `"${fwd(process.execPath)}" "${fwd(script)}" "${fwd(marker)}"`)
      await writeFile(join(nested, '.gitattributes'), 'f filter=x\n')
      await writeFile(join(nested, 'f'), 'payload\n')
      await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo', message: expect.stringContaining('sub/nested/.git') })
      await expect(isDirty(wt.path)).resolves.toBeTypeOf('boolean')
      expect(existsSync(marker)).toBe(false)
      expect(await git(wt.path, 'ls-files', '-s')).not.toContain('160000')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a nested .git file as well as a directory', async () => {
    const { mkdir } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await mkdir(join(wt.path, 'deep'))
    await writeFile(join(wt.path, 'deep', '.git'), 'gitdir: ../elsewhere\n')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo' })
  })

  it('finds git by absolute path from PATH and ignores a planted git.exe in the worktree', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const exe = resolveGit()
    expect(/(^|[\\/])git(\.exe)?$/i.test(exe)).toBe(true)
    expect(existsSync(exe)).toBe(true)
    expect(norm(exe).startsWith(`${norm(wt.path)}/`)).toBe(false)
    expect(resolve(exe)).toBe(exe)
    // A real (small) executable that is not git: if it were launched in place of git, commitAll would fail.
    if (process.platform === 'win32') await copyFile(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'whoami.exe'), join(wt.path, 'git.exe'))
    else await writeFile(join(wt.path, 'git.exe'), 'not an executable')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    expect(await commitAll(wt.path, 'add files', wt.base)).toBe(true)
    expect(await git(wt.path, 'show', '--stat', '--format=', 'HEAD')).toContain('git.exe')
  })

  it('runs no hooks of any kind (post-commit, post-merge)', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const dir = await mkdtemp(join(tmpdir(), 'relay-marks-'))
    try {
      for (const hook of ['pre-commit', 'post-commit', 'post-merge', 'prepare-commit-msg', 'commit-msg', 'pre-merge-commit']) {
        await writeFile(join(repo, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${fwd(join(dir, hook))}"\n`)
      }
      await writeFile(join(wt.path, 'new.txt'), 'hello\n')
      expect(await commitAll(wt.path, 'add new file', wt.base)).toBe(true)
      expect((await merge(repo, wt.branch, 'Merge oc-1')).ok).toBe(true)
      for (const hook of ['pre-commit', 'post-commit', 'post-merge', 'prepare-commit-msg', 'commit-msg', 'pre-merge-commit']) {
        expect(existsSync(join(dir, hook)), hook).toBe(false)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('diff does not run textconv drivers', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const dir = await mkdtemp(join(tmpdir(), 'relay-marks-'))
    try {
      const marker = join(dir, 'textconv-ran')
      const script = join(dir, 'touch.js')
      await writeFile(script, `require('node:fs').writeFileSync(process.argv[2], 'x'); process.stdout.write(require('node:fs').readFileSync(process.argv[3]))`)
      await git(repo, 'config', 'diff.x.textconv', `"${fwd(process.execPath)}" "${fwd(script)}" "${fwd(marker)}"`)
      await writeFile(join(repo, '.gitattributes'), '*.txt diff=x\n')
      await writeFile(join(wt.path, 'new.txt'), 'hello\n')
      await commitAll(wt.path, 'add new file', wt.base)
      const d = await diff(repo, wt.base, wt.branch)
      expect(d.patch).toContain('+hello')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a case-variant .GIT entry', async () => {
    const { mkdir } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await mkdir(join(wt.path, 'sub'))
    await writeFile(join(wt.path, 'sub', '.GIT'), 'gitdir: ../elsewhere\n')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo' })
  })

  it('refuses a junction pointing outside the worktree and stages nothing from it', async () => {
    const { mkdir, symlink } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const outside = await mkdtemp(join(tmpdir(), 'relay-outside-'))
    const link = join(wt.path, 'j')
    try {
      await writeFile(join(outside, 'secret.txt'), 'top secret\n')
      await symlink(outside, link, 'junction')
      await writeFile(join(wt.path, 'new.txt'), 'hello\n')
      await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'directory_link', message: expect.stringContaining('j') })
      expect(await git(wt.path, 'ls-files')).not.toContain('secret.txt')
      expect(await git(wt.path, 'ls-tree', '-r', '--name-only', wt.branch)).not.toContain('secret.txt')
      // once the link is gone, an ordinary directory commits fine
      await rm(link, { recursive: true, force: true })
      await mkdir(join(wt.path, 'real'))
      await writeFile(join(wt.path, 'real', 'a.txt'), 'a\n')
      expect(await commitAll(wt.path, 'ok', wt.base)).toBe(true)
    } finally {
      await rm(link, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

/** A submodule in the base commit, with its git dir at `<common-dir>/modules/sub` (as `git submodule` lays it out). */
async function repoWithSubmodule() {
  const { mkdir } = await import('node:fs/promises')
  const repo = await makeRepo()
  const modules = join(repo, '.git', 'modules', 'sub')
  await mkdir(dirname(modules))
  const src = await makePlainDir()
  await git(src, 'init', '-b', 'main', `--separate-git-dir=${modules}`)
  await git(src, '-c', 'user.name=S', '-c', 'user.email=s@localhost', 'commit', '--allow-empty', '-m', 'sub')
  const subSha = await git(src, 'rev-parse', 'HEAD')
  await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${subSha},sub`)
  await git(repo, 'commit', '-m', 'add submodule gitlink')
  const wt = await createWorktree(repo, 'oc-1')
  await mkdir(join(wt.path, 'sub'), { recursive: true })
  return { repo, wt, src, modules, subSha }
}

describe('submodules are judged against the base commit', () => {
  it('refuses a gitlink the agent committed itself (moved HEAD), via the scan and via the post-add backstop', async () => {
    const { mkdir } = await import('node:fs/promises')
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const evil = join(wt.path, 'evil')
    await mkdir(evil)
    await git(evil, 'init', '-b', 'main')
    await git(evil, '-c', 'user.name=E', '-c', 'user.email=e@localhost', 'commit', '--allow-empty', '-m', 'evil')
    // the agent stages and commits the embedded repo with its own git, moving the worktree's HEAD
    await git(wt.path, 'add', 'evil')
    await git(wt.path, '-c', 'user.name=E', '-c', 'user.email=e@localhost', 'commit', '-m', 'agent commit')
    expect(await git(wt.path, 'ls-tree', 'HEAD', 'evil')).toContain('160000 commit')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo', message: expect.stringContaining('evil/.git') })
    // with the repo removed the scan sees nothing, but the gitlink is still in HEAD and the index
    await rm(join(evil, '.git'), { recursive: true, force: true })
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo', message: expect.stringContaining('evil') })
  })

  it('allows a base submodule checked out through a gitfile into <common-dir>/modules/', async () => {
    const { wt, modules, subSha } = await repoWithSubmodule()
    await writeFile(join(wt.path, 'sub', '.git'), `gitdir: ${fwd(modules)}\n`)
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    expect(await commitAll(wt.path, 'add new file', wt.base)).toBe(true)
    expect(await git(wt.path, 'ls-tree', 'HEAD', 'sub')).toContain(`160000 commit ${subSha}`)
  })

  it('refuses a .git directory at a base gitlink path', async () => {
    const { wt } = await repoWithSubmodule()
    await git(join(wt.path, 'sub'), 'init', '-b', 'main')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo', message: expect.stringContaining('sub/.git') })
  })

  it('refuses a gitfile at a base gitlink path that points outside <common-dir>/modules/', async () => {
    const { wt } = await repoWithSubmodule()
    const elsewhere = await makePlainDir()
    await git(elsewhere, 'init', '-b', 'main')
    await writeFile(join(wt.path, 'sub', '.git'), `gitdir: ${fwd(join(elsewhere, '.git'))}\n`)
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo', message: expect.stringContaining('sub/.git') })
  })

  it('refuses a base submodule whose checked-out sha moved away from base', async () => {
    const { wt, src, modules } = await repoWithSubmodule()
    await writeFile(join(wt.path, 'sub', '.git'), `gitdir: ${fwd(modules)}\n`)
    await git(src, '-c', 'user.name=S', '-c', 'user.email=s@localhost', 'commit', '--allow-empty', '-m', 'moved')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'nested_repo', message: expect.stringContaining('sub') })
  })

  it('rejects a base that is not a full sha', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await expect(commitAll(wt.path, 'nope', 'HEAD')).rejects.toMatchObject({ code: 'bad_base' })
    await expect(commitAll(wt.path, 'nope', '--output=x')).rejects.toMatchObject({ code: 'bad_base' })
  })
})

describe('directory links, ignored trees, timeouts', () => {
  const fs = () => import('node:fs/promises')

  it('refuses cyclic junctions quickly, without following them', async () => {
    const { mkdir, symlink } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const a = join(wt.path, 'a')
    await mkdir(a)
    await writeFile(join(a, 'f.txt'), 'x\n')
    await symlink(a, join(a, 'b'), 'junction')
    await symlink(a, join(a, 'c'), 'junction') // two cycles: git add -A would grow exponentially
    const started = Date.now()
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'directory_link', message: expect.stringMatching(/a\/b.*a\/c|a\/c.*a\/b/) })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await git(wt.path, 'ls-files')).not.toContain('a/')
  })

  it('refuses a junction whose target is inside the worktree', async () => {
    const { mkdir, symlink } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await mkdir(join(wt.path, 'real'))
    await writeFile(join(wt.path, 'real', 'a.txt'), 'a\n')
    await symlink(join(wt.path, 'real'), join(wt.path, 'alias'), 'junction')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'directory_link', message: expect.stringContaining('alias') })
  })

  it('refuses a file symlink pointing outside the worktree', async () => {
    const { symlink } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const outside = await makePlainDir()
    await writeFile(join(outside, 'secret.txt'), 'top secret\n')
    try {
      await symlink(join(outside, 'secret.txt'), join(wt.path, 'leak.txt'), 'file')
    } catch (err) {
      // file symlinks need Developer Mode or elevation on Windows
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return
      throw err
    }
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'link_outside_worktree', message: expect.stringContaining('leak.txt') })
  })

  it('skips gitignored directories entirely: links and repos inside node_modules/ are not refused or committed', async () => {
    const { mkdir, symlink } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const outside = await makePlainDir()
    await writeFile(join(outside, 'secret.txt'), 'top secret\n')
    await writeFile(join(wt.path, '.gitignore'), 'node_modules/\n')
    const nm = join(wt.path, 'node_modules')
    await mkdir(join(nm, 'pkg'), { recursive: true })
    await writeFile(join(nm, 'pkg', 'index.js'), 'module.exports = 1\n')
    await symlink(outside, join(nm, 'linked'), 'junction')
    await symlink(nm, join(nm, 'pkg', 'cycle'), 'junction')
    await git(join(nm, 'pkg'), 'init', '-b', 'main')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    expect(await commitAll(wt.path, 'add new file', wt.base)).toBe(true)
    const tree = await git(wt.path, 'ls-tree', '-r', '--name-only', 'HEAD')
    expect(tree).toContain('new.txt')
    expect(tree).toContain('.gitignore')
    expect(tree).not.toContain('node_modules')
    expect(tree).not.toContain('secret.txt')
  })

  it('still scans an ignored directory that holds tracked files (git add enters it)', async () => {
    const { mkdir, symlink } = await fs()
    const repo = await makeRepo()
    await mkdir(join(repo, 'vendor'))
    await writeFile(join(repo, 'vendor', 'kept.txt'), 'kept\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-m', 'vendor')
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, '.gitignore'), 'vendor/\n')
    const outside = await makePlainDir()
    await symlink(outside, join(wt.path, 'vendor', 'linked'), 'junction')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'directory_link', message: expect.stringContaining('vendor/linked') })
  })

  // ':' cannot appear in Windows file names, so this can only be exercised elsewhere.
  it.skipIf(process.platform === 'win32')('handles directory names that look like pathspec magic', async () => {
    const { mkdir, symlink } = await fs()
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, '.gitignore'), 'ignored/\n')
    await mkdir(join(wt.path, ':(exclude)x'))
    await symlink(join(wt.path, ':(exclude)x'), join(wt.path, ':(exclude)x', 'loop'), 'dir')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'directory_link' })
  })

  it('kills a git call that does not finish and rejects with git_timeout', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    hangGit.timeouts.length = 0
    hangGit.on = true
    const started = Date.now()
    await expect(isDirty(wt.path)).rejects.toMatchObject({ code: 'git_timeout' })
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'git_timeout' })
    hangGit.on = false
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(GIT_TIMEOUT_MS).toBe(120_000)
    expect(hangGit.timeouts.length).toBeGreaterThan(0)
    expect(hangGit.timeouts.every((t) => t === GIT_TIMEOUT_MS)).toBe(true)
  })
})
