import { resolve } from 'node:path'
import type { PendingRequest } from './types.ts'
import { isDotGit, isInside as isUnder } from './worktree.ts'

export type PermissionParams = { sessionId: string; toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: any; locations?: { path: string }[] }; options: { optionId: string; name: string; kind: string }[] }
export type Decision = { action: 'auto'; optionId: string; note: string } | { action: 'question'; pending: PendingRequest } | { action: 'claude'; pending: PendingRequest }

/** True when `child` is `root` or lies below it. Resolves `..`, accepts `/` and `\`, folds case on win32. */
export function isInside(child: string, root: string): boolean {
  return isUnder(resolve(root), resolve(child))
}

const CREDITS = /insufficient credits?|credits? (?:are |have been |has been )?(?:exhausted|depleted)|out of credits?|(?:usage|rate|quota) limit (?:reached|exceeded)|quota exceeded/i

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

/** Every path the request names, or undefined when one of them is not a plain string (fail closed). */
function requestPaths(tc: PermissionParams['toolCall']): string[] | undefined {
  const raw = [...(tc.locations ?? []).map((l) => l?.path), tc.rawInput?.file_path, tc.rawInput?.filePath, tc.rawInput?.path]
  const out: string[] = []
  for (const v of raw) {
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' || v === '') return undefined
    out.push(v)
  }
  return out
}

const hasGitComponent = (p: string) => p.split(/[\\/]+/).some(isDotGit)

function isDeleteIntent(raw: any): boolean {
  return raw !== null && typeof raw === 'object' && ['delete', 'rm'].some((k) => raw[k] !== undefined && raw[k] !== false && raw[k] !== null)
}

/** Why this request may be auto-allowed, or undefined when it must go to Claude. */
function autoReason(tc: PermissionParams['toolCall'], worktree: string): string | undefined {
  if (tc.kind !== 'edit' && tc.kind !== 'read') return undefined
  if (isDeleteIntent(tc.rawInput)) return undefined
  const paths = requestPaths(tc)
  if (!paths || paths.length === 0) return undefined
  for (const p of paths) {
    const abs = resolve(worktree, p)
    if (hasGitComponent(p) || hasGitComponent(abs) || !isInside(abs, worktree)) return undefined
  }
  return `${tc.kind} inside worktree: ${paths.join(', ')}`
}

export function classifyPermission(p: PermissionParams, worktree: string, requestId: string): Decision {
  const tc = p.toolCall
  if (isQuestion(p)) {
    return { action: 'question', pending: { requestId, type: 'question', title: tc.rawInput.question, toolKind: tc.kind, rawInput: tc.rawInput, options: p.options } }
  }
  const reason = autoReason(tc, worktree)
  const once = p.options.find((o) => o.kind === 'allow_once')
  if (reason && once) return { action: 'auto', optionId: once.optionId, note: `auto-allowed ${reason}` }
  return { action: 'claude', pending: { requestId, type: 'permission', title: tc.title ?? tc.kind ?? 'permission request', toolKind: tc.kind, rawInput: tc.rawInput, options: p.options } }
}
