# Agent Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude (Claude Code desktop) delegate build tasks to OpenCode and Command Code over ACP, watch them live in a side pane of agent cards, and talk with them two-way.

**Architecture:** A Node bridge (`bridge/`) runs each delegated task in its own git worktree with its own ACP agent process, applies the permission policy, and exposes an HTTP API plus an NDJSON event stream on stdout. A Claude Code mod (`mod/agent-relay/`) spawns the bridge for the session, folds its events into `$.state`, draws the pane, registers the `relay_*` tools Claude calls, and wakes Claude with `$.prompt.submit` when an agent asks, finishes, fails, or runs out of credits.

**Tech Stack:** Node 26 (runs `.ts` directly via type stripping; no build step), TypeScript 7 (`tsc --noEmit` only), vitest 5, `@agentclientprotocol/sdk@2.0.2` for **types only**, plus a minimal hand-written NDJSON JSON-RPC peer (as proven in the spike). Claude Code mod API build 2.1.308, checked with `claude plugin validate|test`.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-relay-design.md` (read it, including "Spike findings" and "Command Code credits").

## Global Constraints

- Bridge listens on `127.0.0.1` only, random port, every request needs `Authorization: Bearer <token>`.
- Bridge stdout line 1: `{"type":"ready","port":<n>,"token":"<hex>"}`; every later stdout line is one `BridgeEvent` JSON.
- Agent spawn: resolve `npm root -g` once at startup. OpenCode = `<root>/@opencode/cli/bin/opencode.exe acp`; Command Code = `node <root>/command-code/dist/index.mjs acp`. Never spawn the `.ps1` shims.
- OpenCode env: `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"allow","bash":"ask","webfetch":"ask"}}`.
- ACP `initialize`: `protocolVersion: 1`, `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`.
- Model/effort: `session/set_config_option {configId, type:"id", value}` only for options the agent advertised; set `model` first, then re-read options and set `effort` if present.
- Worktree: `<repo>/.relay/wt/<taskId>`, branch `relay/<taskId>`, base = repo `HEAD`; `.relay/` added to `<repo>/.git/info/exclude`.
- Task id: `<agent-short>-<n>` (`oc-1`, `cc-2`), n increments per bridge process.
- Bridge commits at each turn end: `git add -A && git commit -m "relay: <title>"` (skip if nothing changed). Commit author `Agent Relay <relay@localhost>`.
- Merge = `git merge --no-ff relay/<taskId> -m "relay: merge <taskId> <title>"` in the main tree; refuse when the main tree is dirty; on conflict run `git merge --abort` and return the conflicting paths.
- Out-of-credits regex: `/insufficient credits|premium credits exhausted|usage limit (reached|for your plan)/i`.
- Free fallback model: `opencode/glm-5.3-flash-free`.
- The live activity log (thoughts, message chunks, tool calls) never goes into any tool result Claude reads unless `relay_status` is called with `full: true`.
- Lifetime: the bridge dies with the mod; on SIGTERM / stdin close it cancels all sessions, kills agents, keeps worktrees and branches.
- Copy in the pane: sentence case, no "successfully", no "please".

## Review Focus

1. **Command Code question disguised as a permission request** — must become `status: "asking"` and wake Claude, never auto-allowed. (Test in Task 3.)
2. **Agent process dies mid-turn** (crash, killed, auth expired) — task goes `failed` with stderr tail, Claude is woken, no hang. (Test in Task 4.)
3. **Permission request arrives while Claude is mid-turn or slow** — it stays pending with no timeout auto-decision; the card shows "waiting on Claude"; answering later works. (Test in Task 4.)
4. **Repo path is not a git repo, or has no commits** — `POST /tasks` returns 400 with a clear message, nothing spawned. (Test in Task 2.)
5. **Edit outside the worktree** (absolute path elsewhere, `..`) — not auto-allowed; goes to Claude. Windows path casing and `\` vs `/` must not cause false "outside". (Test in Task 3.)

---

## File Structure

```
bridge/
  package.json            scripts: test, typecheck; deps: @agentclientprotocol/sdk (types), devDeps: typescript, vitest
  tsconfig.json           noEmit, erasableSyntaxOnly, allowImportingTsExtensions, module nodenext, strict
  src/types.ts            TaskStatus, TaskSummary, TaskDetail, ThreadEntry, ActivityEntry, BridgeEvent, DelegateRequest
  src/rpc.ts              RpcPeer: NDJSON JSON-RPC over a child's stdio
  src/agents.ts           agent table + spawn spec
  src/policy.ts           permission classification + out-of-credits detection
  src/worktree.ts         git worktree / commit / diff / merge helpers
  src/task.ts             Task: one agent session in one worktree
  src/registry.ts         TaskRegistry: id allocation, lookup, event fan-out, shutdown
  src/server.ts           HTTP API
  src/main.ts             entry: npm root, registry, server, ready line, signal handling
  test/fake-agent.ts      scripted ACP agent used by tests
  test/helpers.ts         temp git repo factory
  test/*.test.ts
mod/agent-relay/
  .claude-plugin/plugin.json   name, version, description, types, userConfig.bridgePath
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           everything the mod does (one module; split only if validate accepts relative imports)
  types/index.d.ts             PluginState['agent-relay']: { tasks, bridge, expanded }
  test/relay.test.tsx
```

---

### Task 1: Bridge scaffold, shared types, RPC peer

**Files:**
- Create: `bridge/package.json`, `bridge/tsconfig.json`, `bridge/src/types.ts`, `bridge/src/rpc.ts`, `bridge/test/rpc.test.ts`, `.gitignore` (`node_modules/`, `.relay/`)

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  export type AgentId = 'opencode' | 'commandcode'
  export type TaskStatus = 'starting' | 'running' | 'asking' | 'waiting_permission' | 'idle' | 'done' | 'failed' | 'cancelled' | 'out_of_credits'
  export type ThreadEntry = { at: number; from: 'claude' | 'agent' | 'user' | 'bridge'; kind: 'brief' | 'message' | 'question' | 'answer' | 'permission' | 'decision' | 'escalation' | 'error'; text: string; requestId?: string }
  export type ActivityEntry = { at: number; kind: 'thought' | 'message' | 'tool'; text: string; toolCallId?: string; status?: string }
  export type PendingRequest = { requestId: string; type: 'permission' | 'question'; title: string; toolKind?: string; rawInput?: unknown; options: { optionId: string; name: string; kind: string }[] }
  export type TaskSummary = { id: string; agent: AgentId; title: string; model?: string; effort?: string; status: TaskStatus; currentStep?: string; filesTouched: string[]; startedAt: number; updatedAt: number; costUsd: number; pending?: PendingRequest; lastMessage?: string; waitingOnUser: boolean; branch: string; worktree: string }
  export type TaskDetail = TaskSummary & { brief: string; thread: ThreadEntry[]; activity?: ActivityEntry[] }
  export type DelegateRequest = { agent: AgentId; title: string; brief: string; repoPath: string; model?: string; effort?: string }
  export type BridgeEvent =
    | { type: 'task'; task: TaskSummary }                       // any summary change (drives the pane)
    | { type: 'activity'; taskId: string; entry: ActivityEntry } // pane-only live log
    | { type: 'attention'; taskId: string; reason: 'question' | 'permission' | 'turn_ended' | 'failed' | 'out_of_credits'; text: string }
  ```
- Produces (`src/rpc.ts`): `class RpcPeer { constructor(stdin: Writable, stdout: Readable); request<T>(method: string, params: unknown): Promise<T>; notify(method: string, params: unknown): void; onRequest(h: (method: string, params: any) => Promise<unknown>): void; onNotification(h: (method: string, params: any) => void): void; close(reason: Error): void }` — `close` rejects all pending requests with `reason`.

- [ ] **Step 1:** `npm init` in `bridge/` (`"type": "module"`), install `@agentclientprotocol/sdk@2.0.2`, devDeps `typescript@7 vitest@5 @types/node`. tsconfig: `strict, noEmit, module/moduleResolution nodenext, allowImportingTsExtensions, erasableSyntaxOnly, target es2024`. Scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.
- [ ] **Step 2: Write failing tests** in `test/rpc.test.ts` using two `PassThrough` pairs wired back-to-back:
  - `request resolves with the peer's result` — peer B `onRequest` returns `{ok:1}` → A's `request('x',{})` resolves `{ok:1}`.
  - `request rejects on error response` — B handler throws `new Error('nope')` → A rejects with message containing `nope`.
  - `notifications reach onNotification` — A `notify('session/update', {a:1})` → B handler called with (`'session/update'`, `{a:1}`).
  - `split and joined lines parse` — write `'{"jsonrpc":"2.0","method":"m","params":{}}\n{"jsonrpc"'` then `':"2.0","method":"m","params":{}}\n'` → 2 notifications.
  - `close rejects pending` — pending `request` rejects with the close reason.
- [ ] **Step 3:** Run `npx vitest run test/rpc.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement `RpcPeer` (newline buffer, id map, handler errors → `{error:{code:-32603,message}}`, non-JSON lines ignored).
- [ ] **Step 5:** `npx vitest run test/rpc.test.ts` → PASS; `npm run typecheck` → no errors.
- [ ] **Step 6:** Commit `feat(bridge): scaffold, shared types, NDJSON RPC peer`.

### Task 2: Agents table and worktree helpers

**Files:**
- Create: `bridge/src/agents.ts`, `bridge/src/worktree.ts`, `bridge/test/helpers.ts`, `bridge/test/agents.test.ts`, `bridge/test/worktree.test.ts`

**Interfaces:**
- Consumes: `AgentId` (Task 1).
- Produces (`agents.ts`): `type AgentSpec = { id: AgentId; short: 'oc' | 'cc'; label: string; command: string; args: string[]; env: Record<string, string> }`; `agentSpec(id: AgentId, npmRoot: string): AgentSpec`; `resolveNpmRoot(): Promise<string>` (runs `npm root -g`); `AGENT_IDS: readonly AgentId[]`. A test-only override: if env `RELAY_FAKE_AGENT` is set, every spec becomes `{command: process.execPath, args: [RELAY_FAKE_AGENT]}` with the real `short`/`label`.
- Produces (`worktree.ts`): `assertRepo(repo: string): Promise<void>` (throws `RelayError('not_a_repo' | 'no_commits', msg)`); `createWorktree(repo, taskId): Promise<{ path: string; branch: string; base: string }>`; `isDirty(dir): Promise<boolean>`; `commitAll(dir, message): Promise<boolean>` (false if nothing to commit); `diff(repo, base, branch): Promise<{ stat: string; patch: string }>`; `merge(repo, branch, message): Promise<{ ok: true; commit: string } | { ok: false; reason: 'dirty' | 'conflict'; paths: string[] }>`; `class RelayError extends Error { code: string }`.
- Test helper: `makeRepo(): Promise<string>` — temp dir, `git init -b main`, one commit with `README.md`.

- [ ] **Step 1: Write failing tests:**
  - `agentSpec('opencode', R)` → `command` ends with `@opencode/cli/bin/opencode.exe`, `args` `['acp']`, `env.OPENCODE_CONFIG_CONTENT` parses to `{permission:{edit:'allow',bash:'ask',webfetch:'ask'}}`.
  - `agentSpec('commandcode', R)` → `command === process.execPath`, `args` `[<R>/command-code/dist/index.mjs, 'acp']`, `short === 'cc'`.
  - `assertRepo` on a plain temp dir rejects with code `not_a_repo`; on `git init` without commits → `no_commits`. *(Review Focus 4)*
  - `createWorktree(repo,'oc-1')` → path `<repo>/.relay/wt/oc-1` exists, branch `relay/oc-1`, `base` = repo HEAD sha, `.git/info/exclude` contains `.relay/`.
  - `commitAll` after writing a file → `true`, again → `false`.
  - `diff` lists the new file in `stat`.
  - `merge` into clean main → `{ok:true}` and file present in main; with an uncommitted change in main → `{ok:false, reason:'dirty'}`; two branches editing the same line, second merge → `{ok:false, reason:'conflict', paths:['README.md']}` and `git status` in main is clean afterwards.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `execFile('git', …)` (no shell), `git -c user.name="Agent Relay" -c user.email=relay@localhost commit`.
- [ ] **Step 4:** Run → PASS; typecheck clean.
- [ ] **Step 5:** Commit `feat(bridge): agent table and worktree helpers`.

### Task 3: Permission policy and credit detection

**Files:**
- Create: `bridge/src/policy.ts`, `bridge/test/policy.test.ts`

**Interfaces:**
- Consumes: `PendingRequest` (Task 1).
- Produces:
  ```ts
  export type PermissionParams = { sessionId: string; toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: any; locations?: { path: string }[] }; options: { optionId: string; name: string; kind: string }[] }
  export type Decision = { action: 'auto'; optionId: string; note: string } | { action: 'question'; pending: PendingRequest } | { action: 'claude'; pending: PendingRequest }
  export function classifyPermission(p: PermissionParams, worktree: string, requestId: string): Decision
  export function isInside(child: string, root: string): boolean   // case-insensitive on win32, normalises / and \, resolves ..
  export function isOutOfCredits(text: string): boolean
  ```
- Rules: **question** when `rawInput.question` is a string and every option kind is `allow_once` with id `option_N` (Command Code ask-user). **auto** (`allow_once` option) when `toolCall.kind` is `edit` or `read` and every path in `locations` and `rawInput.file_path`/`rawInput.filePath` (if present) is inside the worktree and `rawInput` has no `delete`/`rm` intent (kind `delete` never auto). Everything else → **claude**.

- [ ] **Step 1: Write failing tests** (fixtures copied from the spike's real payloads in the spec):
  - Command Code ask-user payload (`rawInput:{question:'Which color…',options:[…]}`, options `option_0..3`) → `action:'question'`, `pending.type==='question'`, 4 options. *(Review Focus 1)*
  - Command Code Write inside worktree (`kind:'edit'`, `rawInput.file_path` = `<wt>\\hello.txt`) → `auto` with optionId `allow_once`.
  - Same with `file_path` `C:\\elsewhere\\x.txt` → `claude`. *(Review Focus 5)*
  - `isInside('c:/Repo/.relay/wt/oc-1/a.txt', 'C:\\repo\\.relay\\wt\\oc-1')` → true on win32; `isInside('C:/repo/.relay/wt/oc-1/../../secret', 'C:/repo/.relay/wt/oc-1')` → false. *(Review Focus 5)*
  - OpenCode shell payload (`kind:'execute'`, options `once|always|reject`) → `claude`.
  - `isOutOfCredits('Insufficient credits for deepseek/deepseek-v4-pro.')`, `'Premium credits exhausted'`, `'Usage limit reached'` → true; `'all tests passed'` → false.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, typecheck clean.
- [ ] **Step 5:** Commit `feat(bridge): permission policy and credit detection`.

### Task 4: Task — one ACP session in one worktree (with fake agent)

**Files:**
- Create: `bridge/src/task.ts`, `bridge/test/fake-agent.ts`, `bridge/test/task.test.ts`

**Interfaces:**
- Consumes: `RpcPeer` (T1), `AgentSpec`, `createWorktree`, `commitAll` (T2), `classifyPermission`, `isOutOfCredits` (T3), types (T1).
- Produces:
  ```ts
  export class Task {
    constructor(opts: { id: string; spec: AgentSpec; req: DelegateRequest; emit: (e: BridgeEvent) => void })
    start(): Promise<void>                       // worktree, spawn, initialize, session/new, set model/effort, first prompt (brief)
    reply(text: string, fromUser?: boolean): Promise<void>   // new session/prompt; only when status is idle/asking(text-question); clears waitingOnUser
    answer(requestId: string, optionId: string, note?: string, fromUser?: boolean): void  // resolves a pending permission/question; clears waitingOnUser
    escalate(question: string): void             // thread entry kind escalation, waitingOnUser = true
    cancel(): Promise<void>                      // session/cancel, kill process, status cancelled
    summary(): TaskSummary
    detail(full: boolean): TaskDetail            // activity only when full
  }
  ```
- Behaviour pinned by tests: `session/update` → activity entries (thought/message chunks coalesced per contiguous run; tool calls keyed by `toolCallId`); `currentStep` = latest tool call title; `filesTouched` from `locations` of `kind:'edit'` calls, relative to the worktree, unique; `costUsd` = latest `usage_update.cost.amount` summed across prompts. On `session/prompt` resolve: `commitAll`, status `idle`, thread entry with the final message text, `attention:turn_ended` (or `out_of_credits` if `isOutOfCredits(lastMessage)` and agent is commandcode). Prompt error → `out_of_credits` if matching, else `failed` with error text. Child exit while a prompt is pending → `failed`, `attention:failed` with the last 20 stderr lines. *(Review Focus 2)* Pending permission requests never time out. *(Review Focus 3)*
- Fake agent (`test/fake-agent.ts`): reads JSON script from env `FAKE_SCRIPT` — a list of steps per prompt: `{update: {...}}`, `{permission: {...}}` (waits for the client's answer and records it in a `fake.update` message `{sessionUpdate:'agent_message_chunk', content:{type:'text', text:'answer:<optionId>'}}`), `{exit: code}`, `{error: 'msg'}`, `{writeFile: 'name'}` (writes into its cwd), `{stop: 'end_turn'}`. Advertises `configOptions` `model` and `effort`, records `set_config_option` calls to stderr.

- [ ] **Step 1: Write failing tests** (each uses `makeRepo()` and `RELAY_FAKE_AGENT`):
  - `runs the brief and ends idle` — script: thought chunk, tool_call edit `a.txt` + writeFile, message chunk "done", stop → events include `task` with `status:'running'` then `'idle'`; `summary().filesTouched` = `['a.txt']`; branch `relay/oc-1` has a commit containing `a.txt`; one `attention` `turn_ended`.
  - `sets model then effort` — `req.model='m1', req.effort='high'` → fake stderr shows `model=m1` before `effort=high`; summary shows both.
  - `routes a question and waits` — script: permission with Command Code ask-user payload → status `asking`, `attention:question`; no answer for 200 ms → still `asking`; `answer(id,'option_2')` → final message `answer:option_2`. *(Review Focus 1, 3)*
  - `auto-allows an in-worktree edit` — permission edit inside cwd → thread gets a `decision` entry, no `attention`.
  - `reply sends a second prompt` — after idle, `reply('next')` → second turn's message in thread; `costUsd` sums two `usage_update`s (0.001 + 0.002 → 0.003).
  - `agent crash fails the task` — script `{exit: 3}` mid-turn → status `failed`, `attention:failed` text includes the exit code. *(Review Focus 2)*
  - `out of credits` — agent `commandcode`, script `{error: 'Insufficient credits for x'}` → status `out_of_credits`, `attention:out_of_credits`.
  - `escalate then reply` — `escalate('pick a db?')` → `waitingOnUser` true and thread entry `escalation`; `reply('sqlite', true)` → `waitingOnUser` false, thread entry `from:'user'`.
  - `detail(false)` has no `activity`; `detail(true)` has it.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `Task` and the fake agent. **Step 4:** Run → PASS, typecheck clean.
- [ ] **Step 5:** Commit `feat(bridge): task lifecycle over ACP`.

### Task 5: Registry, HTTP server, entry point

**Files:**
- Create: `bridge/src/registry.ts`, `bridge/src/server.ts`, `bridge/src/main.ts`, `bridge/test/server.test.ts`

**Interfaces:**
- Consumes: `Task` (T4), `assertRepo`, `isDirty`, `diff`, `merge` (T2), `agentSpec`, `resolveNpmRoot` (T2).
- Produces (`registry.ts`): `class TaskRegistry { constructor(npmRoot: string, emit: (e: BridgeEvent) => void); delegate(req: DelegateRequest): Promise<TaskSummary>; get(id): Task; list(): TaskSummary[]; shutdown(): Promise<void>; spend(): { commandcodeUsd: number; opencodeUsd: number } }`.
- Produces (`server.ts`): `startServer(reg: TaskRegistry): Promise<{ port: number; token: string; close(): Promise<void> }>`. Routes (JSON in/out; 401 without token; 404 unknown task; 400 `{error, code}` on `RelayError`):
  - `POST /tasks` body `DelegateRequest` → `TaskSummary` + `mainDirty: boolean` (warn flag)
  - `GET /tasks` → `TaskSummary[]`; `GET /tasks/:id?full=1` → `TaskDetail`
  - `POST /tasks/:id/reply` `{text, fromUser?}`; `POST /tasks/:id/answer` `{requestId, optionId, note?, fromUser?}`; `POST /tasks/:id/escalate` `{question}`; `POST /tasks/:id/cancel`
  - `GET /tasks/:id/diff` → `{stat, patch}`; `POST /tasks/:id/merge` → merge result (serialised: one merge at a time via a promise chain)
  - `GET /agents/:agent/models` → `configOptions` from a throwaway `initialize`+`session/new` in the repo (cached per agent)
  - `GET /spend` → `spend()`
- `main.ts`: resolve npm root, start registry+server, print ready line, print each event as one line, on `SIGTERM`/`SIGINT`/stdin `end` → `shutdown()` then exit 0.

- [ ] **Step 1: Write failing tests** (start server in-process with fake agent):
  - `401 without token`.
  - `POST /tasks` with a non-repo path → 400 code `not_a_repo`, no process spawned. *(Review Focus 4)*
  - delegate → poll `GET /tasks/oc-1` until `idle` → `GET /tasks/oc-1/diff` stat lists the file → `POST /merge` → `{ok:true}`.
  - two delegations at once → ids `oc-1`, `oc-2`; both reach `idle`; merges run one at a time (second sees first's commit).
  - `answer` route resolves a pending question (fake records `answer:option_1`).
  - `main.ts` spawned as a child: first stdout line parses as `ready`; after SIGTERM the child exits 0 and the fake agent process is gone.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run full suite `npm test` → PASS; typecheck clean.
- [ ] **Step 5:** Commit `feat(bridge): registry, HTTP API, entry point`.

### Task 6: Mod — bridge lifecycle, state, tools

**Files:**
- Create: `mod/agent-relay/.claude-plugin/plugin.json`, `mod/agent-relay/hooks/hooks.json`, `mod/agent-relay/hooks/register.tsx`, `mod/agent-relay/types/index.d.ts`, `mod/agent-relay/test/relay.test.tsx`

**Interfaces:**
- Consumes: bridge HTTP + events (T5), `TaskSummary`/`BridgeEvent` shapes (copy the types into `types/index.d.ts`; the mod cannot import from `bridge/`).
- Manifest: `name: "agent-relay"`, `types: "./types/index.d.ts"`, `userConfig.bridgePath` (string, default `<repo>/bridge/src/main.ts`).
- State contract: `PluginState['agent-relay'] = { tasks: TaskSummary[]; bridge: { status: 'starting' | 'up' | 'down'; error?: string }; expanded: string | null; activity: Record<string, ActivityEntry[]> }` (activity capped at last 200 per task).
- `session.start`: spawn `['node', bridgePath]`, read lines in a detached loop: `ready` → keep `{port, token}` in module memory; `task` → upsert into `tasks`; `activity` → append; `attention` → `$.prompt.submit({ text })` with text `[relay] <taskId> (<agent label>, <model>) <reason>: <text>` (first 600 chars) — `turn_ended` text ends with "Review with relay_status / relay_diff."; loop end → `bridge.status='down'` + toast.
- Tools (all `isDeferred: false`, each served by `on('tool.call', { tool: 'mcp__agent-relay__<name>' }, …)` returning `{ result }` with the bridge's JSON, or `{ deny: <error text> }` on HTTP error):
  `relay_delegate {agent, title, brief, repoPath, model?, effort?}` · `relay_reply {taskId, text, fromUser?}` · `relay_answer {taskId, requestId, optionId, note?, fromUser?}` · `relay_escalate {taskId, question}` · `relay_status {taskId?, full?}` · `relay_diff {taskId}` · `relay_merge {taskId}` · `relay_cancel {taskId}` · `relay_models {agent}` · `relay_credits {}` (returns `/spend` plus the last `out_of_credits` time if any).

- [ ] **Step 1: Write failing tests** (`claude-code/testing`; stub `process.spawn` with a hook that yields a scripted `ready` line + events, stub `http.fetch`):
  - after `session.start`, `tool.register` was called for all 10 tool names.
  - an `attention` event with reason `question` causes one `prompt.submit` whose text starts `[relay] cc-1`.
  - a `task` event then a second `task` event for the same id → `tasks` holds one entry with the latest status.
  - `relay_delegate` call → `http.fetch` hit `POST http://127.0.0.1:<port>/tasks` with the bearer token; tool result carries the summary.
  - HTTP 400 → tool result is `{deny}` containing the bridge's message.
- [ ] **Step 2:** Run `claude.exe plugin test mod/agent-relay` → FAIL.
- [ ] **Step 3:** Implement. **Step 4:** `claude.exe plugin validate mod/agent-relay` clean; `tsc -p mod/agent-relay` clean (after first load lays types; before that use the skill's tsconfig recipe); `plugin test` → PASS.
- [ ] **Step 5:** Commit `feat(mod): bridge lifecycle, state and relay tools`.

### Task 7: Mod — agent cards pane, `/relay`, operating rules

**Files:**
- Modify: `mod/agent-relay/hooks/register.tsx`, `mod/agent-relay/test/relay.test.tsx`

**Interfaces:**
- Consumes: state from T6.
- Pane id `agent-relay`, title `Agents`; opened on `session.start` and by `/relay`.
- Card (collapsed): line 1 `<label> · <title>` + status word; line 2 model (and effort if set); line 3 current step (dim); line 4 `<n> files · <elapsed> · $<cost to 4 dp>`; when `pending`: the question/permission title and "Claude is answering" (or "Waiting on you" when `waitingOnUser`). Status words: running, asking, waiting on Claude, idle, done, failed, stopped, out of credits.
- Card press → toggles `expanded`. Expanded adds: effort, model, full brief, thread (from `GET /tasks/:id` fetched on expand and on each `task` event while expanded), last 30 activity lines, and a `Stop` button (calls cancel) shown while running/asking.
- Empty state: "No delegated tasks yet. Ask Claude to delegate build work to OpenCode or Command Code."
- `prompt.compose`: append section `agent-relay:rules` (`scope: 'session'`) with the five operating rules from the spec **plus**: "Before delegating to Command Code call relay_credits; if a task ends out_of_credits, re-delegate the same brief to OpenCode with model opencode/glm-5.3-flash-free and tell the user. When escalating an agent's question to the user, call relay_escalate first, then AskUserQuestion, then relay_reply/relay_answer with fromUser: true and the user's words."

- [ ] **Step 1: Write failing tests:** for `['terminal','desktop']`: with two tasks in state, the pane shows both titles; a task with `pending.type==='question'` shows its title and "Claude is answering"; pressing a card shows "Stop" and the brief; empty state text; `prompt.compose` result contains a section with id `agent-relay:rules` mentioning `relay_credits`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** validate + tsc + `plugin test` → PASS.
- [ ] **Step 5:** Commit `feat(mod): agent cards pane, /relay command, operating rules`.

### Task 8: End-to-end with the real agents

**Files:**
- Create: `README.md` (what it is, how to load the mod: `CLAUDE_CODE_PLUGIN_DIRS` / `--plugin-dir`, the `bridgePath` option, requirements)

- [ ] **Step 1:** Load the mod in this session (plugin-authoring folder or `--plugin-dir`); confirm the pane opens and `bridge.status === 'up'`.
- [ ] **Step 2:** In a scratch repo, delegate in parallel: OpenCode `opencode/glm-5.3-flash-free` "add a Usage section to README.md"; Command Code `deepseek/deepseek-v4-flash` effort `off` "add test/sum.test.js for a sum() in src/sum.js, ask which test runner first". Expect: both cards live; Command Code's question reaches Claude as a `[relay]` prompt; Claude answers; a shell permission from OpenCode reaches Claude; both end idle; diffs reviewed; both merged (second after first); `relay_credits` shows non-zero Command Code spend.
- [ ] **Step 3:** Stop a running task from the card's Stop button → card shows stopped, agent process gone, branch kept.
- [ ] **Step 4:** Commit `docs: README and end-to-end notes`.
