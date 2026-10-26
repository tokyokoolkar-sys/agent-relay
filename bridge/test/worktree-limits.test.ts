// Hardlinks, staged symlinks, agent state folders, the merge precondition and worktree removal.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { branchExists, commitAll, createWorktree, merge, removeWorktree } from '../src/worktree.ts'
import { cleanupRepos, git, makePlainDir, makeRepo } from './helpers.ts'

afterEach(async () => {
  await cleanupRepos()
})

/** Creates a file symlink, or returns false where the OS refuses (file symlinks need Developer Mode on Windows). */
async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file')
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  }
}

describe('hardlinks', () => {
  it('refuses a new file that is a hardlink to a file elsewhere, and restores the index', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const outside = await makePlainDir()
    await writeFile(join(outside, 'secret.txt'), 'top secret\n')
    await link(join(outside, 'secret.txt'), join(wt.path, 'h.txt'))
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'hardlink', message: expect.stringContaining('h.txt') })
    expect(await git(wt.path, 'diff', '--cached', '--name-only')).toBe('')
    expect(await git(wt.path, 'log', '--format=%s', `${wt.base}..${wt.branch}`)).toBe('')
  })

  it('refuses a hardlink before staging anything: its content never reaches the object store', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const outside = await makePlainDir()
    await writeFile(join(outside, 'secret.txt'), 'never hashed into the repo\n')
    const sha = await git(outside, 'hash-object', 'secret.txt')
    await link(join(outside, 'secret.txt'), join(wt.path, 'h.txt'))
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'hardlink' })
    await expect(git(repo, 'cat-file', '-e', sha)).rejects.toThrow()
  })

  it('refuses a tracked file swapped for a hardlink', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    const outside = await makePlainDir()
    await writeFile(join(outside, 'secret.txt'), 'top secret\n')
    await rm(join(wt.path, 'README.md'))
    await link(join(outside, 'secret.txt'), join(wt.path, 'README.md'))
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'hardlink', message: expect.stringContaining('README.md') })
  })
})

describe('staged symlinks', () => {
  it('refuses a dangling symlink whose link text points outside the worktree', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    if (!(await trySymlink(join('..', '..', '..', '..', 'nowhere', 'x.txt'), join(wt.path, 'dangle')))) return
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'link_outside_worktree', message: expect.stringContaining('dangle') })
    expect(await git(wt.path, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('judges the link text, also when the link is checked out as a plain file (core.symlinks=false)', async () => {
    const repo = await makeRepo()
    // a link the user committed in base (mode 120000), pointing outside the repo
    await writeFile(join(repo, 'linktext.tmp'), '../shared/docs')
    const sha = await git(repo, 'hash-object', '-w', 'linktext.tmp')
    await rm(join(repo, 'linktext.tmp'))
    await git(repo, 'update-index', '--add', '--cacheinfo', `120000,${sha},ext`)
    await git(repo, 'commit', '-m', 'link to shared docs')
    await git(repo, 'config', 'core.symlinks', 'false')
    const wt = await createWorktree(repo, 'oc-1')
    expect(await readFile(join(wt.path, 'ext'), 'utf8')).toBe('../shared/docs') // a plain file holding the link text

    // base's own link, unchanged, is the user's: other work still commits
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    expect(await commitAll(wt.path, 'add new file', wt.base)).toBe(true)

    // the agent rewrites the text: git stages it as a link (120000) again, now pointing somewhere else outside
    await writeFile(join(wt.path, 'ext'), '../../../../../Windows/System32')
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'link_outside_worktree', message: expect.stringContaining('ext') })
  })

  it('commits a symlink whose relative link text stays inside the worktree', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await mkdir(join(wt.path, 'sub'))
    if (!(await trySymlink('README.md', join(wt.path, 'readme-link')))) return
    await trySymlink(join('..', 'README.md'), join(wt.path, 'sub', 'up-link'))
    expect(await commitAll(wt.path, 'link', wt.base)).toBe(true)
    expect(await git(wt.path, 'ls-tree', 'HEAD', 'readme-link')).toContain('120000')
    expect(await git(wt.path, 'ls-tree', 'HEAD', 'sub/up-link')).toContain('120000')
  })

  /** A worktree whose base has a link `l` checked out as a plain file (core.symlinks=false): writing `l` sets link text. */
  async function linkAsPlainFile() {
    const repo = await makeRepo()
    await writeFile(join(repo, 'linktext.tmp'), 'README.md')
    const sha = await git(repo, 'hash-object', '-w', 'linktext.tmp')
    await rm(join(repo, 'linktext.tmp'))
    await git(repo, 'update-index', '--add', '--cacheinfo', `120000,${sha},l`)
    await git(repo, 'commit', '-m', 'a link')
    await git(repo, 'config', 'core.symlinks', 'false')
    return createWorktree(repo, 'oc-1')
  }

  it.each([
    ['an absolute path into the worktree itself', (wt: string) => join(wt, 'README.md')],
    ['a drive path', () => 'C:/Windows/win.ini'],
    ['a drive-relative path', () => 'C:win.ini'],
    ['a POSIX absolute path', () => '/etc/passwd'],
    ['a UNC path', () => '\\\\server\\share\\x'],
    ['a device path', () => '\\\\?\\C:\\x'],
    ['a relative path that climbs out', () => '../../../../x'],
  ])('refuses link text that is %s', async (_what, text) => {
    const wt = await linkAsPlainFile()
    await writeFile(join(wt.path, 'l'), text(wt.path))
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'link_outside_worktree', message: expect.stringContaining('l') })
  })

  it.each([['.git'], ['sub/.GIT/config'], ['sub/GIT~1/config'], ['LONGFI~1.TXT'], ['a.txt:stream']])('refuses link text naming %s below the worktree', async (text) => {
    const wt = await linkAsPlainFile()
    await writeFile(join(wt.path, 'l'), text)
    await expect(commitAll(wt.path, 'nope', wt.base)).rejects.toMatchObject({ code: 'suspicious_link', message: expect.stringContaining('l') })
  })

  it('accepts link text that stays inside after climbing within the worktree', async () => {
    const wt = await linkAsPlainFile()
    await writeFile(join(wt.path, 'l'), 'sub/../README.md')
    expect(await commitAll(wt.path, 'ok', wt.base)).toBe(true)
  })
})

describe('agent state folders', () => {
  it('leaves .commandcode/ out of the commit and reports it', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await mkdir(join(wt.path, '.commandcode', 'taste'), { recursive: true })
    await writeFile(join(wt.path, '.commandcode', 'taste', 'taste.md'), 'taste\n')
    await writeFile(join(wt.path, 'work.txt'), 'work\n')
    const leftOut: string[][] = []
    expect(await commitAll(wt.path, 'work', wt.base, (dirs) => leftOut.push(dirs))).toBe(true)
    const tree = await git(wt.path, 'ls-tree', '-r', '--name-only', 'HEAD')
    expect(tree).toContain('work.txt')
    expect(tree).not.toContain('.commandcode')
    expect(leftOut).toEqual([['.commandcode/']])

    // nothing but agent state changed: nothing to commit, and no error
    await writeFile(join(wt.path, '.commandcode', 'taste', 'more.md'), 'more\n')
    expect(await commitAll(wt.path, 'again', wt.base)).toBe(false)
  })

  it('commits changes under .opencode/ when the base commit tracks files there', async () => {
    const repo = await makeRepo()
    await mkdir(join(repo, '.opencode'))
    await writeFile(join(repo, '.opencode', 'agent.md'), 'v1\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-m', 'project opencode config')
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, '.opencode', 'agent.md'), 'v2\n')
    await writeFile(join(wt.path, '.opencode', 'new.md'), 'new\n')
    const leftOut: string[][] = []
    expect(await commitAll(wt.path, 'config', wt.base, (dirs) => leftOut.push(dirs))).toBe(true)
    const tree = await git(wt.path, 'ls-tree', '-r', '--name-only', 'HEAD')
    expect(tree).toContain('.opencode/agent.md')
    expect(tree).toContain('.opencode/new.md')
    expect(await git(wt.path, 'show', 'HEAD:.opencode/agent.md')).toBe('v2')
    expect(leftOut).toEqual([])
  })
})

describe('merge precondition', () => {
  it('merges although the main tree has untracked files', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await commitAll(wt.path, 'add new file', wt.base)
    await writeFile(join(repo, 'scratch.txt'), 'mine, untracked\n')
    expect((await merge(repo, wt.branch, 'Merge oc-1')).ok).toBe(true)
    expect(await readFile(join(repo, 'scratch.txt'), 'utf8')).toBe('mine, untracked\n')
    expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('hello\n')
  })

  it('an untracked file the merge would overwrite fails it plainly: nothing to abort, the file kept', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await commitAll(wt.path, 'add new file', wt.base)
    await writeFile(join(repo, 'new.txt'), 'mine\n')
    await expect(merge(repo, wt.branch, 'Merge oc-1')).rejects.toMatchObject({ code: 'merge_failed', message: expect.stringContaining('new.txt') })
    expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('mine\n')
  })
})

describe('removeWorktree', () => {
  it('deletes the worktree, keeps the branch, and never follows a junction out', async () => {
    const repo = await makeRepo()
    const wt = await createWorktree(repo, 'oc-1')
    await writeFile(join(wt.path, 'new.txt'), 'hello\n')
    await commitAll(wt.path, 'add new file', wt.base)
    await writeFile(join(wt.path, 'uncommitted.txt'), 'x\n')
    const outside = await makePlainDir()
    await mkdir(join(outside, 'keep'))
    await writeFile(join(outside, 'keep', 'precious.txt'), 'precious\n')
    await symlink(join(outside, 'keep'), join(wt.path, 'j'), 'junction')
    await removeWorktree(repo, wt.path)
    expect(existsSync(wt.path)).toBe(false)
    expect(await branchExists(repo, 'relay/oc-1')).toBe(true)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('oc-1')
    expect(await readFile(join(outside, 'keep', 'precious.txt'), 'utf8')).toBe('precious\n')
  })
})
