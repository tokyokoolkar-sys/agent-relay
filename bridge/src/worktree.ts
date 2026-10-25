import { type ChildProcess, execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat as statPath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

// Hooks are disabled outright: pointing hooksPath at the null device means no hook of any kind (post-commit etc.) can run.
const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null'

let gitExe: string | undefined

/**
 * Absolute path of the git executable, found by searching PATH entries only (never the current directory,
 * which for a worktree is agent-writable and which Windows would otherwise search first). Cached.
 */
export function resolveGit(): string {
  if (gitExe) return gitExe
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : ['']
  for (const raw of (process.env.PATH ?? '').split(delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const candidate = join(dir, `git${ext}`)
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return (gitExe = candidate)
    }
  }
  throw new RelayError('git_not_found', 'could not find git on PATH')
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
  const common = await execGit(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
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

/** Every git call is killed after this long and rejects with RelayError('git_timeout'). */
export const GIT_TIMEOUT_MS = 120_000

/**
 * Bare git invocation: absolute git path, no shell, hardened config and environment, exit code reported rather
 * than thrown. The process cwd is always the OS temp dir (never agent-writable repo content); the target is
 * selected by `-C` / `--git-dir` / `--work-tree` in `args`. `input` is written to stdin. Rejects only on timeout.
 */
function execGit(args: string[], input?: string): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise, reject) => {
    const full = [
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${NO_HOOKS}`,
      '-c', 'core.quotePath=false',
      '-c', 'diff.ignoreSubmodules=all',
      ...args,
    ]
    let timedOut = false
    const child = execFile(
      resolveGit(),
      full,
      { cwd: tmpdir(), windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
      (err, stdout, stderr) => {
        clearTimeout(timer)
        if (timedOut) {
          const what = args.filter((a, i) => !a.startsWith('--git-dir=') && !a.startsWith('--work-tree=') && a !== '-C' && args[i - 1] !== '-C')
          reject(new RelayError('git_timeout', `git ${what.slice(0, 3).join(' ')} did not finish within ${GIT_TIMEOUT_MS} ms and was killed`))
          return
        }
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolvePromise({ code, stdout, stderr: err && typeof err.code !== 'number' ? `${err.message}\n${stderr}` : stderr })
      },
    )
    const timer = setTimeout(() => {
      timedOut = true
      if (child) killTree(child)
    }, GIT_TIMEOUT_MS)
    if (child?.stdin) {
      child.stdin.on('error', () => {}) // git may exit before reading all input; its exit code tells the story
      child.stdin.end(input ?? '')
    }
  })
}

/**
 * Kills our own child and everything it started. On Windows `<git>\cmd\git.exe` is a launcher that runs the real
 * git as a child of its own, so killing only the launcher would orphan it: kill the tree of our child's PID with
 * taskkill (absolute path, never by image name), falling back to a plain kill if that fails.
 */
function killTree(child: ChildProcess): void {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { cwd: tmpdir(), windowsHide: true }, (err) => {
    if (err) child.kill('SIGKILL')
  })
}

/**
 * Runs git against `dir`. Inside a relay worktree the git dir is pinned explicitly (after verifying the `.git`
 * pointer), so nothing the agent wrote there can redirect git. Never rejects on a non-zero exit: callers
 * inspect `code` (stderr noise like CRLF warnings is not failure).
 */
async function run(dir: string, args: string[], input?: string): Promise<GitResult> {
  const gitDir = await trustedWorktreeGitDir(dir)
  return execGit(gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${resolve(dir)}`, ...args] : ['-C', resolve(dir), ...args], input)
}

/** Like run, but throws a RelayError when git exits non-zero. */
async function must(dir: string, args: string[]): Promise<string> {
  const r = await run(dir, args)
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
  return (await must(dir, ['status', '--porcelain', '--ignore-submodules=all'])).trim() !== ''
}

/** Gitlinks (submodules) recorded in commit `base`: forward-slash path -> commit sha. */
async function baseGitlinks(dir: string, base: string): Promise<Map<string, string>> {
  const links = new Map<string, string>()
  for (const e of (await must(dir, ['ls-tree', '-r', '-z', '--full-tree', base])).split('\0')) {
    if (!e.startsWith('160000 ')) continue // "<mode> <type> <sha>\t<path>"
    const tab = e.indexOf('\t')
    links.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[2]!)
  }
  return links
}

/** Case-insensitive file systems (the defaults on Windows and macOS): path comparisons fold case. */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'
const fold = (p: string) => (FOLD_CASE ? p.toLowerCase() : p)

/**
 * Directories (forward-slash, relative, case-folded where the file system folds case) that contain at least one
 * index entry. Folded because the index says `src/` while the agent may have renamed the directory to `SRC/`:
 * git add still reaches the tracked paths through it.
 */
async function indexDirs(dir: string): Promise<Set<string>> {
  const dirs = new Set<string>()
  for (const p of (await must(dir, ['ls-files', '-z'])).split('\0')) {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) dirs.add(fold(p.slice(0, i)))
  }
  return dirs
}

/**
 * Which of `rels` (forward-slash directory paths) git's ignore rules exclude. `check-ignore --stdin` only
 * evaluates patterns and never walks the tree; `ls-files -o -i --directory` does walk it, following junctions,
 * so it would hang on the very cycles the scan exists to catch. Paths go in as `./<rel>` so that a name
 * starting with `:` is not parsed as pathspec magic.
 */
async function ignoredDirs(dir: string, rels: string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set()
  const r = await run(dir, ['check-ignore', '-z', '--stdin'], rels.map((p) => `./${p}\0`).join(''))
  if (r.code === 1) return new Set() // none ignored
  if (r.code !== 0) throw new RelayError('git_failed', `git check-ignore failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  return new Set(r.stdout.split('\0').filter(Boolean).map((p) => p.replace(/^\.\//, '')))
}

export const isInside = (root: string, p: string) => {
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  const c = process.platform === 'win32' ? p.toLowerCase() : p
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** A `.git` path component, in any case, and with the trailing dots/spaces Windows strips from names. */
export const isDotGit = (name: string) => name.toLowerCase().replace(/[. ]+$/, '') === '.git'

type Findings = { nested: string[]; dirLinks: string[]; outside: string[] }

function refusal(f: Findings): RelayError | undefined {
  if (f.nested.length > 0) return new RelayError('nested_repo', `embedded git repositories are not allowed: ${f.nested.join(', ')}`)
  if (f.dirLinks.length > 0) return new RelayError('directory_link', `directory links (junctions, directory symlinks) are not allowed: ${f.dirLinks.join(', ')}`)
  if (f.outside.length > 0) return new RelayError('link_outside_worktree', `links pointing outside the worktree are not allowed: ${f.outside.join(', ')}`)
  return undefined
}

/**
 * Pre-add scan, an early refusal before anything is staged (the post-add check in commitAll is the real defence).
 * Breadth-first, never following links, skipping directories git add does not enter: excluded by git's ignore
 * rules and holding no index entry in any case variant. Forward-slash relative paths.
 * `nested`: any `.git` entry (any case) below the root, a submodule checkout included (worktrees never have
 * submodules initialised). `dirLinks`: every junction or directory symlink, wherever it points. `outside`: file
 * links whose real target lies outside the worktree.
 */
async function scanWorktree(dir: string, trackedDirs: Set<string>): Promise<Findings> {
  const root = resolve(dir)
  const found: Findings = { nested: [], dirLinks: [], outside: [] }
  const realRoot = await realpath(root)
  const rel = (p: string) => relative(root, p).replaceAll('\\', '/')
  let level = [root]
  while (level.length > 0) {
    const subdirs: string[] = []
    for (const parent of level) {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        const full = join(parent, entry.name)
        if (isDotGit(entry.name)) {
          if (parent !== root) found.nested.push(rel(full)) // the root's is the pointer trustedWorktreeGitDir verified
          continue
        }
        if (entry.isSymbolicLink()) {
          const target = await statPath(full).catch(() => undefined) // a dangling link stages as plain link text
          if (target?.isDirectory()) found.dirLinks.push(rel(full))
          else if (target && !isInside(realRoot, await realpath(full))) found.outside.push(rel(full))
        } else if (entry.isDirectory()) {
          subdirs.push(full)
        }
      }
    }
    const ignored = await ignoredDirs(dir, subdirs.map(rel).filter((r) => !trackedDirs.has(fold(r))))
    level = subdirs.filter((d) => !ignored.has(rel(d)))
  }
  return found
}

type StagedEntry = { mode: string; sha: string; path: string }

/** The index as `ls-files -s -z` reports it: "<mode> <sha> <stage>\t<path>". */
async function stagedEntries(dir: string): Promise<StagedEntry[]> {
  return (await must(dir, ['ls-files', '-s', '-z']))
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t')
      const [mode, sha] = e.slice(0, tab).split(' ')
      return { mode: mode!, sha: sha!, path: e.slice(tab + 1) }
    })
}

/**
 * Checks what `git add` actually staged, independently of the scan and of any ignore rule: every index entry (not
 * only changed ones; one cached lstat per directory plus one realpath per entry, run 32 at a time, stays well
 * under a second for a few thousand files). An entry is refused when a path component is `.git`, when it is a
 * gitlink that `base` does not have at that sha, when one of its ancestor directories is a link, or when its
 * real path is outside the worktree.
 */
async function verifyStaged(dir: string, entries: StagedEntry[], exempt: Map<string, string>): Promise<Findings> {
  const root = resolve(dir)
  const realRoot = await realpath(root)
  const nested = new Set<string>()
  const dirLinks = new Set<string>()
  const outside = new Set<string>()
  const linkDirs = new Map<string, Promise<boolean>>()
  const isLinkDir = (rel: string) => {
    let known = linkDirs.get(rel)
    if (!known) {
      known = lstat(join(root, rel)).then(
        (st) => st.isSymbolicLink(),
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false
          throw err
        },
      )
      linkDirs.set(rel, known)
    }
    return known
  }
  const check = async ({ mode, sha, path }: StagedEntry) => {
    const parts = path.split('/')
    if (parts.some(isDotGit)) nested.add(path)
    if (mode === '160000' && exempt.get(path) !== sha) nested.add(path)
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      if (await isLinkDir(ancestor)) dirLinks.add(ancestor)
    }
    const real = await realpath(join(root, path)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined // not on disk (e.g. skip-worktree): nothing read
      throw err
    })
    if (real && !isInside(realRoot, real)) outside.add(path)
  }
  let next = 0
  const worker = async () => {
    while (next < entries.length) await check(entries[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(32, entries.length) }, worker))
  return { nested: [...nested], dirLinks: [...dirLinks], outside: [...outside] }
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Stages and commits everything as Agent Relay. Returns false when there was nothing to commit.
 * `base` is the sha `createWorktree` recorded. It, not the worktree's HEAD (which the agent can move by
 * committing), decides which gitlinks are legitimate.
 *
 * After `add -A` the staged set itself is verified (see verifyStaged). On any violation the index is restored
 * with `read-tree HEAD` and commitAll throws, so nothing reaches a commit. A pre-add scan refuses the same
 * things earlier, before anything is staged. Errors:
 * - RelayError('nested_repo'): a `.git` anywhere below the root (file, directory or link, submodule paths
 *   included), or a staged gitlink that is not in `base` at base's sha.
 * - RelayError('directory_link'): a junction or directory symlink (outside gitignored directories), or a staged
 *   path that goes through one.
 * - RelayError('link_outside_worktree'): a file link, or staged path, whose real target is outside the worktree.
 */
export async function commitAll(dir: string, message: string, base: string): Promise<boolean> {
  if (!SHA.test(base)) throw new RelayError('bad_base', `base must be a full commit sha, got ${JSON.stringify(base)}`)
  const exempt = await baseGitlinks(dir, base)
  const early = refusal(await scanWorktree(dir, await indexDirs(dir)))
  if (early) throw early
  await must(dir, ['add', '-A'])
  const restoreIndex = () => run(dir, ['read-tree', 'HEAD'])
  let late: RelayError | undefined
  try {
    late = refusal(await verifyStaged(dir, await stagedEntries(dir), exempt))
  } catch (err) {
    await restoreIndex().catch(() => undefined) // a check that could not finish must not leave the staging behind
    throw err
  }
  if (late) {
    const restored = await restoreIndex()
    if (restored.code !== 0) late.message += ` (restoring the index with read-tree HEAD failed: ${restored.stderr.trim() || `exit ${restored.code}`})`
    throw late
  }
  if (!(await isDirty(dir))) return false
  await must(dir, [...IDENTITY, 'commit', '--no-verify', '-m', message])
  return true
}

export async function diff(repo: string, base: string, branch: string): Promise<{ stat: string; patch: string }> {
  const flags = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
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
