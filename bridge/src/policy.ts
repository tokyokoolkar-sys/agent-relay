import { lstatSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { PendingRequest } from './types.ts'
import { isDotGit, isInside as isUnder } from './worktree.ts'

export type PermissionParams = { sessionId: string; toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: any; locations?: { path: string }[] }; options: { optionId: string; name: string; kind: string }[] }
export type Decision = { action: 'auto'; optionId: string; note: string } | { action: 'question'; pending: PendingRequest } | { action: 'claude'; pending: PendingRequest }

/** True when `child` is `root` or lies below it. Resolves `..`, accepts `/` and `\`, folds case on win32. Lexical only. */
export function isInside(child: string, root: string): boolean {
  return isUnder(resolve(root), resolve(child))
}

const CREDITS = /insufficient credits|premium credits exhausted|usage limit (reached|for your plan)/i

export function isOutOfCredits(text: string): boolean {
  return CREDITS.test(text)
}

/** Command Code's ask-user tool arrives as a permission request whose options are the answers: `option_0`, `option_1`, ... */
function isQuestion(p: PermissionParams): boolean {
  return (
    typeof p.toolCall.rawInput?.question === 'string' &&
    p.options.length > 0 &&
    p.options.every((o) => o.kind === 'allow_once' && /^option_\d+$/.test(o.optionId))
  )
}

// Deny by default: a request is auto-allowed only when every top-level rawInput key is one we know cannot name
// another file, a destination, or an operation (so new_path, destination, paths, edits, cwd, operation... all escalate).
const PATH_KEYS = ['file_path', 'filePath', 'path']
const ALLOWED_KEYS: Record<string, Set<string>> = {
  edit: new Set([...PATH_KEYS, 'content', 'old_string', 'new_string', 'oldString', 'newString', 'replace_all', 'replaceAll']),
  read: new Set([...PATH_KEYS, 'offset', 'limit']),
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every path the request names, or undefined when the shape is not one we understand (fail closed). */
function requestPaths(tc: PermissionParams['toolCall']): string[] | undefined {
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v !== 'string' || v === '') return false
    out.push(v)
    return true
  }
  if (tc.locations !== undefined) {
    if (!Array.isArray(tc.locations)) return undefined
    for (const l of tc.locations) if (!isObject(l) || !add(l.path)) return undefined
  }
  for (const k of PATH_KEYS) if (tc.rawInput[k] !== undefined && !add(tc.rawInput[k])) return undefined
  return out
}

/** Spellings that can alias another file on the filesystem; refuse them outright instead of reasoning about them. */
function suspiciousPath(p: string): boolean {
  if (p.includes('://')) return true
  const parts = p.split(/[\\/]+/).filter(Boolean)
  if (parts.some(isDotGit)) return true
  if (parts.some((c) => /~\d/.test(c))) return true // 8.3 short names
  if (process.platform === 'win32') {
    // `:` is only legal as the drive designator; elsewhere it opens an alternate data stream (or a device path)
    if (parts.some((c, i) => c.includes(':') && !(i === 0 && /^[a-z]:$/i.test(c)))) return true
  }
  return false
}

/**
 * Real containment: a junction or symlink inside the worktree can point anywhere, so the lexical check is not
 * enough. No existing component below the worktree may be a link, and the deepest existing ancestor must really
 * live inside the worktree. Any fs error fails closed.
 */
function realInside(abs: string, worktree: string): boolean {
  try {
    const root = resolve(worktree)
    const rel = relative(root, abs)
    if (rel === '') return true
    const parts = rel.split(sep)
    let ancestor = root
    for (const part of parts) {
      const next = resolve(ancestor, part)
      let st
      try {
        st = lstatSync(next)
      } catch (e: any) {
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') break // the rest does not exist yet
        return false
      }
      if (st.isSymbolicLink()) return false
      ancestor = next
    }
    return isUnder(realpathSync.native(root), realpathSync.native(ancestor))
  } catch {
    return false
  }
}

/** Why this request may be auto-allowed, or undefined when it must go to Claude. */
function autoReason(tc: PermissionParams['toolCall'], worktree: string): string | undefined {
  const allowed = tc.kind === 'edit' || tc.kind === 'read' ? ALLOWED_KEYS[tc.kind] : undefined
  if (!allowed || !isObject(tc.rawInput)) return undefined
  if (Object.keys(tc.rawInput).some((k) => !allowed.has(k))) return undefined
  const paths = requestPaths(tc)
  if (!paths || paths.length === 0) return undefined
  for (const p of paths) {
    if (suspiciousPath(p)) return undefined
    const abs = resolve(worktree, p)
    if (suspiciousPath(abs) || !isInside(abs, worktree) || !realInside(abs, worktree)) return undefined
  }
  return `${tc.kind} inside worktree: ${paths.join(', ')}`
}

function escalate(p: PermissionParams, requestId: string): Decision {
  const tc: any = isObject(p) && isObject(p.toolCall) ? p.toolCall : {}
  const title = typeof tc.title === 'string' ? tc.title : typeof tc.kind === 'string' ? tc.kind : 'permission request'
  const options = isObject(p) && Array.isArray(p.options) ? p.options : []
  return { action: 'claude', pending: { requestId, type: 'permission', title, toolKind: typeof tc.kind === 'string' ? tc.kind : undefined, rawInput: tc.rawInput, options } }
}

/** Never throws: any unexpected shape escalates to Claude. */
export function classifyPermission(p: PermissionParams, worktree: string, requestId: string): Decision {
  try {
    const tc = p.toolCall
    if (!isObject(tc) || !Array.isArray(p.options)) return escalate(p, requestId)
    if (isQuestion(p)) {
      return { action: 'question', pending: { requestId, type: 'question', title: tc.rawInput.question, toolKind: tc.kind, rawInput: tc.rawInput, options: p.options } }
    }
    const reason = autoReason(tc, worktree)
    const once = p.options.find((o) => o?.kind === 'allow_once')
    if (reason && once && typeof once.optionId === 'string') return { action: 'auto', optionId: once.optionId, note: `auto-allowed ${reason}` }
    return escalate(p, requestId)
  } catch {
    return escalate(p, requestId)
  }
}
