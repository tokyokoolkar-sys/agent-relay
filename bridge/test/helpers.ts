import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

export function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`))
      else resolve(stdout.trim())
    })
  })
}

/** Fresh temp git repo on branch `main` with one commit containing README.md. Remove with cleanupRepos(). */
export async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-repo-'))
  created.push(dir)
  await git(dir, 'init', '-b', 'main')
  await git(dir, 'config', 'user.name', 'Test')
  await git(dir, 'config', 'user.email', 'test@localhost')
  await git(dir, 'config', 'core.autocrlf', 'false')
  await writeFile(join(dir, 'README.md'), 'line one\nline two\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-m', 'initial')
  return dir
}

/** A temp directory that is not a git repo (removed by cleanupRepos()). */
export async function makePlainDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-plain-'))
  created.push(dir)
  return dir
}

export async function cleanupRepos(): Promise<void> {
  const dirs = created.splice(0)
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}
