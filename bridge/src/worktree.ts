import { execFile } from 'node:child_process'
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export class RelayError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RelayError'
    this.code = code
  }
}

type GitResult = { code: number; stdout: string; stderr: string }

const IDENTITY = ['-c', 'user.name=Agent Relay', '-c', 'user.email=relay@localhost', '-c', 'commit.gpgsign=false']

let emptyHooksDir: Promise<string> | undefined

/** An empty directory used as core.hooksPath so no repository hook ever runs inside the bridge. */
function noHooksDir(): Promise<string> {
  emptyHooksDir ??= mkdtemp(join(tmpdir(), 'relay-nohooks-')).then((d) => d.replaceAll('\\', '/'))
  return emptyHooksDir
}

const sameFile = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/**
 * Agents can write inside their worktree, including its `.git` pointer file. If `dir` is a relay worktree
 * (`<repo>/.relay/wt/<name>`), verify that pointer still names `<repo>/.git/worktrees/<name>` and return the
 * trusted git dir. Returns undefined for any other directory (the main tree).
 */
async function trustedWorktreeGitDir(dir: string): Promise<string | undefined> {
  const wt = resolve(dir)
  const wtParent = dirname(wt)
  const relayDir = dirname(wtParent)
  if (basename(wtParent) !== 'wt' || basename(relayDir) !== '.relay') return undefined
  const repo = dirname(relayDir)

  const tampered = (why: string) => new RelayError('worktree_tampered', `refusing to run git in ${wt}: ${why}`)
  const common = await execGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common.code !== 0) throw new RelayError('git_failed', `could not locate the git dir of ${repo}: ${common.stderr.trim()}`)
  const expected = await realpath(join(common.stdout.trim(), 'worktrees', basename(wt))).catch(() => undefined)
  if (!expected) throw tampered('no matching administrative directory in the main repository')

  const pointer = join(wt, '.git')
  const st = await lstat(pointer).catch(() => undefined)
  if (!st?.isFile()) throw tampered('.git is not a regular file')
  const match = /^gitdir:\s*(.+?)\s*$/.exec((await readFile(pointer, 'utf8')).trim())
  if (!match) throw tampered('.git has no gitdir pointer')
  const actual = await realpath(resolve(wt, match[1]!)).catch(() => undefined)
  if (!actual || !sameFile(actual, expected)) throw tampered(`.git points to ${match[1]}, expected ${expected}`)
  return expected
}

/** Bare git invocation: no shell, hardened config and environment, exit code reported rather than thrown. */
function execGit(cwd: string, args: string[]): Promise<GitResult> {
  return noHooksDir().then(
    (hooks) =>
      new Promise<GitResult>((resolvePromise) => {
        const full = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`, '-c', 'core.quotePath=false', ...args]
        execFile(
          'git',
          full,
          { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
          (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
            resolvePromise({ code, stdout, stderr: err && typeof err.code !== 'number' ? `${err.message}\n${stderr}` : stderr })
          },
        )
      }),
  )
}

/**
 * Runs git in `cwd`. Inside a relay worktree the git dir is pinned explicitly (after verifying the `.git`
 * pointer), so nothing the agent wrote there can redirect git. Never rejects on a non-zero exit: callers
 * inspect `code` (stderr noise like CRLF warnings is not failure).
 */
async function run(cwd: string, args: string[]): Promise<GitResult> {
  const gitDir = await trustedWorktreeGitDir(cwd)
  return execGit(cwd, gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${resolve(cwd)}`, ...args] : args)
}

/** Like run, but throws a RelayError when git exits non-zero. */
async function must(cwd: string, args: string[]): Promise<string> {
  const r = await run(cwd, args)
  if (r.code !== 0) throw new RelayError('git_failed', `git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  return r.stdout
}

export async function assertRepo(repo: string): Promise<void> {
  const inside = await run(repo, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new RelayError('not_a_repo', `${repo} is not a git repository`)
  }
  const head = await run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head.code !== 0) throw new RelayError('no_commits', `${repo} has no commits yet; make an initial commit first`)
}

async function excludeRelayDir(repo: string): Promise<void> {
  const rel = (await must(repo, ['rev-parse', '--git-path', 'info/exclude'])).trim()
  const file = resolve(repo, rel)
  const existing = await readFile(file, 'utf8').catch(() => '')
  if (existing.split(/\r?\n/).some((l) => l.trim() === '.relay/')) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}.relay/\n`)
}

export async function createWorktree(repo: string, taskId: string): Promise<{ path: string; branch: string; base: string }> {
  const base = (await must(repo, ['rev-parse', 'HEAD'])).trim()
  const branch = `relay/${taskId}`
  const path = join(repo, '.relay', 'wt', taskId)
  await excludeRelayDir(repo)
  await must(repo, ['worktree', 'add', '-b', branch, path, base])
  return { path, branch, base }
}

/** Throws RelayError('worktree_tampered') when `dir` is a relay worktree whose `.git` pointer was altered. */
export async function isDirty(dir: string): Promise<boolean> {
  return (await must(dir, ['status', '--porcelain'])).trim() !== ''
}

/** Stages and commits everything as Agent Relay. Returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await must(dir, ['add', '-A'])
  if (!(await isDirty(dir))) return false
  await must(dir, [...IDENTITY, 'commit', '--no-verify', '-m', message])
  return true
}

export async function diff(repo: string, base: string, branch: string): Promise<{ stat: string; patch: string }> {
  const flags = ['diff', '--no-color', '--no-ext-diff']
  const [stat, patch] = await Promise.all([
    must(repo, [...flags, '--stat', base, branch, '--']),
    must(repo, [...flags, base, branch, '--']),
  ])
  return { stat, patch }
}

export async function merge(
  repo: string,
  branch: string,
  message: string,
): Promise<{ ok: true; commit: string } | { ok: false; reason: 'dirty' | 'conflict'; paths: string[] }> {
  if (await isDirty(repo)) return { ok: false, reason: 'dirty', paths: [] }
  const r = await run(repo, [...IDENTITY, 'merge', '--no-ff', '--no-verify', branch, '-m', message])
  if (r.code === 0) return { ok: true, commit: (await must(repo, ['rev-parse', 'HEAD'])).trim() }

  const paths = (await run(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const abort = await run(repo, ['merge', '--abort'])
  if (abort.code !== 0) {
    throw new RelayError('merge_abort_failed', `git merge --abort failed, the main tree may be left mid-merge: ${abort.stderr.trim() || `exit ${abort.code}`}`)
  }
  if (paths.length === 0) throw new RelayError('merge_failed', `git merge failed: ${(r.stderr || r.stdout).trim()}`)
  return { ok: false, reason: 'conflict', paths }
}
