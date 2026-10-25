import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export class RelayError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RelayError'
    this.code = code
  }
}

type GitResult = { code: number; stdout: string; stderr: string }

const IDENTITY = ['-c', 'user.name=Agent Relay', '-c', 'user.email=relay@localhost']

/** Runs git without a shell. Never rejects on a non-zero exit: callers inspect `code` (stderr noise like CRLF warnings is not failure). */
function run(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolvePromise({ code, stdout, stderr: err && typeof err.code !== 'number' ? `${err.message}\n${stderr}` : stderr })
    })
  })
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

export async function isDirty(dir: string): Promise<boolean> {
  return (await must(dir, ['status', '--porcelain'])).trim() !== ''
}

/** Stages and commits everything as Agent Relay. Returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await must(dir, ['add', '-A'])
  if (!(await isDirty(dir))) return false
  await must(dir, [...IDENTITY, 'commit', '-m', message])
  return true
}

export async function diff(repo: string, base: string, branch: string): Promise<{ stat: string; patch: string }> {
  const [stat, patch] = await Promise.all([must(repo, ['diff', '--stat', base, branch]), must(repo, ['diff', base, branch])])
  return { stat, patch }
}

export async function merge(
  repo: string,
  branch: string,
  message: string,
): Promise<{ ok: true; commit: string } | { ok: false; reason: 'dirty' | 'conflict'; paths: string[] }> {
  if (await isDirty(repo)) return { ok: false, reason: 'dirty', paths: [] }
  const r = await run(repo, [...IDENTITY, 'merge', '--no-ff', branch, '-m', message])
  if (r.code === 0) return { ok: true, commit: (await must(repo, ['rev-parse', 'HEAD'])).trim() }

  const paths = (await run(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  await run(repo, ['merge', '--abort'])
  if (paths.length === 0) throw new RelayError('merge_failed', `git merge failed: ${(r.stderr || r.stdout).trim()}`)
  return { ok: false, reason: 'conflict', paths }
}
