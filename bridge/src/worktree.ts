import { type ChildProcess, execFile, execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rmdir, stat as statPath, unlink } from 'node:fs/promises'
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
export function killTree(child: ChildProcess): void {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { cwd: tmpdir(), windowsHide: true }, (err) => {
    if (err) child.kill('SIGKILL')
  })
}

/** Synchronous killTree for last-resort crash handlers: the process is about to exit, so nothing may be left async. Best effort. */
export function killTreeSync(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid !== undefined) {
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      execFileSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { cwd: tmpdir(), windowsHide: true, stdio: 'ignore', timeout: 5000 })
      return
    }
  } catch {
    /* fall through to a plain kill */
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
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

/** True when `refs/heads/<branch>` exists in `repo`. */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await run(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
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

/**
 * Whether `dir` has changes. `untracked: false` counts only tracked files (the merge precondition: an untracked file
 * of the user's does not stop a merge). Throws RelayError('worktree_tampered') when `dir` is a relay worktree whose
 * `.git` pointer was altered.
 */
export async function isDirty(dir: string, opts: { untracked?: boolean } = {}): Promise<boolean> {
  const args = ['status', '--porcelain', '--ignore-submodules=all', ...(opts.untracked === false ? ['--untracked-files=no'] : [])]
  return (await must(dir, args)).trim() !== ''
}

/** Whether the index differs from HEAD (what a commit would record). */
async function hasStagedChanges(dir: string): Promise<boolean> {
  const r = await run(dir, ['diff', '--cached', '--quiet'])
  if (r.code === 0) return false
  if (r.code === 1) return true
  throw new RelayError('git_failed', `git diff --cached failed: ${r.stderr.trim() || `exit ${r.code}`}`)
}

/** Every entry of commit `base` (blobs, links and gitlinks): forward-slash path -> its mode and sha. */
async function baseEntries(dir: string, base: string): Promise<Map<string, { mode: string; sha: string }>> {
  const entries = new Map<string, { mode: string; sha: string }>()
  for (const e of (await must(dir, ['ls-tree', '-r', '-z', '--full-tree', base])).split('\0')) {
    if (!e) continue
    const tab = e.indexOf('\t') // "<mode> <type> <sha>\t<path>"
    const [mode, , sha] = e.slice(0, tab).split(' ')
    entries.set(e.slice(tab + 1), { mode: mode!, sha: sha! })
  }
  return entries
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

/**
 * A `.git` path component under any spelling NTFS resolves to it: any case, trailing dots/spaces stripped, an
 * alternate-data-stream suffix (`.git::$INDEX_ALLOCATION`, `.git::$DATA`), or the 8.3 short name `GIT~1`.
 */
export const isDotGit = (name: string) => {
  const lower = name.toLowerCase()
  const colon = lower.indexOf(':')
  const base = (colon === -1 ? lower : lower.slice(0, colon)).replace(/[. ]+$/, '')
  return base === '.git' || /^git~\d+$/.test(base)
}

type Findings = { nested: string[]; dirLinks: string[]; outside: string[]; hardlinks?: string[] }

function refusal(f: Findings): RelayError | undefined {
  if (f.nested.length > 0) return new RelayError('nested_repo', `embedded git repositories are not allowed: ${f.nested.join(', ')}`)
  if (f.dirLinks.length > 0) return new RelayError('directory_link', `directory links (junctions, directory symlinks) are not allowed: ${f.dirLinks.join(', ')}`)
  if (f.outside.length > 0) return new RelayError('link_outside_worktree', `links pointing outside the worktree are not allowed: ${f.outside.join(', ')}`)
  if (f.hardlinks && f.hardlinks.length > 0) return new RelayError('hardlink', `files with more than one hard link are not allowed: ${f.hardlinks.join(', ')}`)
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
 * only changed ones; one cached lstat per directory plus one lstat and one realpath per entry, run 32 at a time,
 * stays well under a second for a few thousand files). An entry is refused when a path component is `.git`, when
 * it is a gitlink that `base` does not have at that sha, when one of its ancestor directories is a link, when its
 * real path is outside the worktree, when it is a link (mode 120000) whose link text, read from the staged blob,
 * resolves outside the worktree (dangling or not, and whatever is on disk: with core.symlinks=false the link is a
 * plain file), or when it is a regular file with more than one hard link (its content is shared with a file that
 * may live anywhere on the volume). Links `base` already has, unchanged, are the user's own and are not judged.
 */
async function verifyStaged(dir: string, entries: StagedEntry[], base: Map<string, { mode: string; sha: string }>): Promise<Findings> {
  const root = resolve(dir)
  const realRoot = await realpath(root)
  const nested = new Set<string>()
  const dirLinks = new Set<string>()
  const outside = new Set<string>()
  const hardlinks = new Set<string>()
  const linkDirs = new Map<string, Promise<boolean>>()
  const missing = (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined // not on disk (e.g. skip-worktree): nothing read
    throw err
  }
  const isLinkDir = (rel: string) => {
    let known = linkDirs.get(rel)
    if (!known) {
      known = lstat(join(root, rel)).then(
        (st) => st.isSymbolicLink(),
        (err: NodeJS.ErrnoException) => missing(err) ?? false,
      )
      linkDirs.set(rel, known)
    }
    return known
  }
  const check = async ({ mode, sha, path }: StagedEntry) => {
    const parts = path.split('/')
    const inBase = base.get(path)
    const unchanged = inBase?.mode === mode && inBase.sha === sha
    if (parts.some(isDotGit)) nested.add(path)
    if (mode === '160000' && !unchanged) nested.add(path)
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      if (await isLinkDir(ancestor)) dirLinks.add(ancestor)
    }
    const full = join(root, path)
    if (mode === '120000' && !unchanged) {
      const text = await must(dir, ['cat-file', 'blob', sha])
      if (!isInside(root, resolve(dirname(full), text))) outside.add(path)
    }
    if (mode === '100644' || mode === '100755') {
      const st = await lstat(full).catch(missing)
      if (st?.isFile() && st.nlink > 1) hardlinks.add(path)
    }
    const real = await realpath(full).catch(missing)
    if (real && !isInside(realRoot, real)) outside.add(path)
  }
  let next = 0
  const worker = async () => {
    while (next < entries.length) await check(entries[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(32, entries.length) }, worker))
  return { nested: [...nested], dirLinks: [...dirLinks], outside: [...outside], hardlinks: [...hardlinks] }
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Folders where the agents keep their own state (Command Code's taste notes, OpenCode's session data). Left out of
 * every commit through pathspec excludes (never info/exclude: that file is shared with the main tree, where a real
 * `.opencode/` project config must stay visible), unless `base` tracks something under one: then it is project
 * content and is committed like anything else.
 */
const AGENT_STATE_DIRS = ['.commandcode', '.opencode']

/**
 * Stages and commits everything as Agent Relay. Returns false when there was nothing to commit.
 * `base` is the sha `createWorktree` recorded. It, not the worktree's HEAD (which the agent can move by
 * committing), decides which gitlinks and links are legitimate and which agent state folders are project content.
 * `onLeftOut` hears which agent state folders exist and were left out (`.commandcode/`).
 *
 * After `add -A` the staged set itself is verified (see verifyStaged). On any violation the index is restored
 * with `read-tree HEAD` and commitAll throws, so nothing reaches a commit. A pre-add scan refuses the same
 * things earlier, before anything is staged. Errors:
 * - RelayError('nested_repo'): a `.git` anywhere below the root (file, directory or link, submodule paths
 *   included), or a staged gitlink that is not in `base` at base's sha.
 * - RelayError('directory_link'): a junction or directory symlink (outside gitignored directories), or a staged
 *   path that goes through one.
 * - RelayError('link_outside_worktree'): a file link, or staged path, whose real target is outside the worktree,
 *   or a staged link whose link text resolves outside it.
 * - RelayError('hardlink'): a staged regular file with more than one hard link.
 */
export async function commitAll(dir: string, message: string, base: string, onLeftOut?: (dirs: string[]) => void): Promise<boolean> {
  if (!SHA.test(base)) throw new RelayError('bad_base', `base must be a full commit sha, got ${JSON.stringify(base)}`)
  const inBase = await baseEntries(dir, base)
  const early = refusal(await scanWorktree(dir, await indexDirs(dir)))
  if (early) throw early
  const tracked = new Set([...inBase.keys()].map((p) => fold(p.split('/')[0]!)))
  const leaveOut = AGENT_STATE_DIRS.filter((d) => !tracked.has(fold(d)))
  await must(dir, ['add', '-A', '--', ...leaveOut.map((d) => `:(top,exclude)${d}`)])
  const restoreIndex = () => run(dir, ['read-tree', 'HEAD'])
  let late: RelayError | undefined
  try {
    late = refusal(await verifyStaged(dir, await stagedEntries(dir), inBase))
  } catch (err) {
    await restoreIndex().catch(() => undefined) // a check that could not finish must not leave the staging behind
    throw err
  }
  if (late) {
    const restored = await restoreIndex()
    if (restored.code !== 0) late.message += ` (restoring the index with read-tree HEAD failed: ${restored.stderr.trim() || `exit ${restored.code}`})`
    throw late
  }
  if (onLeftOut) {
    const present = await Promise.all(leaveOut.map((d) => lstat(join(resolve(dir), d)).then(() => true, () => false)))
    const dirs = leaveOut.filter((_, i) => present[i]).map((d) => `${d}/`)
    if (dirs.length > 0) onLeftOut(dirs)
  }
  if (!(await hasStagedChanges(dir))) return false
  await must(dir, [...IDENTITY, 'commit', '--no-verify', '-m', message])
  return true
}

/**
 * Removes a task's worktree (git's record of it and the directory), uncommitted files included. The branch stays.
 * git leaves behind what it will not delete, such as a junction; the rest is removed here without ever following
 * a link: a link is removed itself, never what it points to.
 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  const wt = resolve(path)
  await must(repo, ['worktree', 'remove', '--force', wt])
  await removeTreeNoFollow(wt)
}

async function removeTreeNoFollow(p: string): Promise<void> {
  const st = await lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined
    throw err
  })
  if (!st) return
  if (st.isSymbolicLink()) {
    // a file link is unlinked; a junction or directory link is removed with rmdir, which drops the link only
    await unlink(p).catch(() => rmdir(p))
    return
  }
  if (st.isDirectory()) {
    for (const name of await readdir(p)) await removeTreeNoFollow(join(p, name))
    await rmdir(p)
    return
  }
  await unlink(p)
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
  // untracked files do not count: git itself refuses a merge that would overwrite one, reported below
  if (await isDirty(repo, { untracked: false })) return { ok: false, reason: 'dirty', paths: [] }
  const r = await run(repo, [...IDENTITY, 'merge', '--no-ff', '--no-verify', branch, '-m', message])
  if (r.code === 0) return { ok: true, commit: (await must(repo, ['rev-parse', 'HEAD'])).trim() }
  // a merge git refused to start (an untracked file in the way, say) left nothing to abort
  if ((await run(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code !== 0) {
    throw new RelayError('merge_failed', `git merge failed: ${(r.stderr || r.stdout).trim()}`)
  }

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
