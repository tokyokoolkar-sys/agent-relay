# Agent Relay — Claude orchestrates OpenCode and Command Code over ACP

## Context

Claude Code is expensive for bulk build work. The user wants Claude (in Claude Code desktop) to stay the
orchestrator — planning, briefing, judging, reviewing — while cheaper coding agents (OpenCode, Command Code)
with task‑fit models do the heavy lifting. The user must be able to **watch** the delegated agents work from
inside Claude Code desktop, and communication must be **two‑way**: agents ask Claude; Claude answers itself
or, when the decision is the user's, asks the user and relays the answer back.

Delegation is never the default. Whenever there is build work, Claude asks the user how to run it:
subagents here · Command Code · OpenCode · sequential here.

## What the user decided

- Claude hands out the work; the user never talks to the agents directly.
- Everything is visible in Claude Code desktop: a side panel, **layout A — one card per agent**.
- Card shows agent, model, task, status (running / asking / waiting on you / done / failed), current step,
  files touched, elapsed time, and a pending question if any.
- Expanded card shows: **effort, model, full task brief, and the message thread** (agent ↔ Claude ↔ user).
- Questions from agents go to Claude; Claude escalates to the user only when it's the user's call.
- Claude decides on agents' permission requests (shell, deletes, installs…).
- Agents work in **isolated git worktrees**; Claude reviews the diff and merges.
- The motive is cost: Claude's own orchestration must stay lean.
- **Lifetime:** tasks stop with the session. The bridge is a child of the mod; closing the session /
  reloading the mod cancels agents. Worktrees and `relay/<taskId>` branches are kept so work isn't lost.
- **Merging:** Claude merges on its own judgment after reviewing the diff, then tells the user
  (summary + how to undo).

## Claude's calls (the user can overturn these)

- **Permission policy lives in the bridge, set by Claude.** Auto-allow: reads and edits inside the task's
  worktree. Everything else (shell commands, installs, network, deletes, paths outside the worktree)
  goes to Claude. Each auto-allow is still logged on the card's thread. Keeps wake-ups (and cost) down.
- **Worktree base = current HEAD.** If the main tree has uncommitted changes, Claude warns the user
  before delegating (agents won't see them).
- **The bridge commits** the agent's work on `relay/<taskId>` when a turn ends ("relay: <task title>").
- **Merge** = `git merge --no-ff relay/<taskId>` into the currently checked-out branch. Refuse if the main
  tree is dirty; on conflict, abort the merge and send the conflict back to the agent (or to Claude if
  trivial). Parallel tasks merge one at a time.
- **Watching:** the expanded card also shows the agent's **live activity log** (its text, thinking and
  tool calls), stored in the bridge and rendered in the pane only — never sent to Claude.
  `relay_status` returns summaries; the full log only on explicit request.
- **Pane actions:** a Stop button per card (cancels that agent). No free-text to agents from the pane —
  messages go through Claude.

## Goals / non-goals / anti-goals

- **Goals:** delegate a task to OpenCode or Command Code with chosen model + effort; live cards; two-way
  Q&A and permission relay; worktree isolation and merge-back; several agents in parallel.
- **Non-goals (v1):** automatic delegation without asking; sharing/marketplace packaging; cloud agents;
  agents other than OpenCode and Command Code (but the agent table should make adding one trivial).
- **Anti-goals:** Claude reading every streamed token (kills the savings); an agent acting without the
  user being able to see it; a question or permission request silently stalling.

## Recon facts (verified on this machine, 2026‑10‑25)

- `opencode` v2.1.4 → `opencode acp` (ACP server over stdio). Models: free tier only
  (`opencode/glm-5.3-flash-free`, `opencode/deepseek-v4.1-flash-free`, `opencode/big-pickle`, …).
- Command Code v1.86.3 (`cmd` / `commandcode`) → `cmd acp` (ACP over stdio). 93 models
  (DeepSeek V4/V4.1, Kimi K3.x, GLM 5.x, Qwen 3.8, MiniMax…); has `--effort`, `--list-models`.
- Both are npm `.ps1` shims under `%APPDATA%\npm` — spawning must resolve the real
  entry (e.g. via `cmd.exe /c` or the package's JS entry), not the `.ps1`.
- Claude Code mod API (build 2.1.308): `$.ui.open` Pane, `$.tool.register` (tools Claude calls),
  `$.process.spawn` (streams child stdout; **stdin is one-shot only**), `$.http.fetch` (localhost OK),
  `$.prompt.submit` (queues a prompt that wakes an idle session), `$.command.register`, `prompt.compose`.
- Because a mod can't hold a bidirectional pipe, ACP (bidirectional JSON-RPC over stdio) needs a **bridge**.

## Architecture

```
Claude (main loop) ──tools──▶ mod "agent-relay" ──HTTP 127.0.0.1+token──▶ bridge (Node)
        ▲                         │  ▲                                        │  ACP stdio
        │ $.prompt.submit         │  └── NDJSON events on bridge stdout ◀────┤
        │ (agent asked/finished)  ▼                                          ├─▶ opencode acp  (worktree A)
   user ◀── AskUserQuestion    Pane: agent cards                             └─▶ cmd acp       (worktree B)
```

### Repo layout — `the repository root` (git init; currently empty)

- `bridge/` — TypeScript Node daemon, `@agentclientprotocol/sdk` client.
  - `agents.ts` — table: id, label, spawn argv, how model/effort are set.
  - `task.ts` — one delegated task = worktree + ACP connection + session + message log + status machine.
  - `worktree.ts` — `git worktree add <repo>/.relay/wt/<taskId> -b relay/<taskId>`; diff; cleanup.
  - `server.ts` — HTTP on 127.0.0.1, random port, bearer token. `POST /tasks` (delegate), `POST
    /tasks/:id/reply`, `POST /tasks/:id/permission`, `POST /tasks/:id/cancel`, `GET /tasks`,
    `GET /tasks/:id` (full thread), `GET /agents/:id/models`.
  - stdout: first line `{type:"ready",port,token}`, then one NDJSON event per state change
    (status, current step, files touched, question, permission request, turn ended, error).
- `mod/agent-relay/` — the Claude Code mod (`.claude-plugin/plugin.json`, `hooks/hooks.json`,
  `hooks/register.tsx`, `types/index.d.ts`), developed here and loaded via `--plugin-dir` /
  `CLAUDE_CODE_PLUGIN_DIRS` (or installed globally so it works in every project).
  - `session.start`: spawn the bridge, parse `ready`, keep the stdout loop alive for the session,
    fold events into `$.state` atoms (task list) → redraws the Pane.
  - Tools (`isDeferred: false`): `relay_delegate {agent, model, effort, task, repoPath}`,
    `relay_reply {taskId, text}`, `relay_permission {taskId, requestId, optionId}`,
    `relay_status {taskId?}` (summary, or full thread on request), `relay_diff {taskId}`,
    `relay_merge {taskId}`, `relay_cancel {taskId}`, `relay_models {agent}`.
  - Wake-ups: on question / permission request / turn ended / error, `$.prompt.submit` a short
    message ("[relay] Command Code #2 asks: …") so Claude handles it; if Claude is mid-turn it
    queues until idle. Running-status events never wake Claude.
  - Pane (layout A): one card per task; click toggles the expanded view (effort, model, brief,
    message thread incl. Claude's auto-decisions and user escalations). `/relay` command opens it.
  - `prompt.compose`: a session section with the operating rules below.

### Operating rules (injected into Claude's system prompt by the mod)

1. Before any build work, ask the user: subagents here / Command Code / OpenCode / sequential here.
   When delegating, propose agent + model + effort per task; user may override.
2. Briefs are self-contained (goal, files, constraints, done-criteria) because agents don't share context.
3. Agent question → answer from conversation + codebase; if it's the user's decision, AskUserQuestion,
   mark the card "waiting on you", relay the answer.
4. Permission requests → Claude decides; escalate to the user for: new dependencies, deletes outside the
   task, anything touching secrets/credentials, network/deploy actions.
5. On turn end → read the summary + diff (not the stream), then reply (more work), or merge, or discard.
   After merging, tell the user what landed and the undo command.

## Left to the builder

- Exact status-machine edges; HTTP payload shapes; event schema names.
- How model/effort are applied per agent (ACP `session/set_config_option` vs spawn flags) — decide after
  the step‑0 spike shows what each agent exposes.
- Which ACP client capabilities to advertise (recommend none for fs/terminal so agents use their own tools
  inside the worktree).
- Pane visual details within layout A.

## Implementation steps

0. **Spike (throwaway):** a 50-line Node script that runs `initialize` + `session/new` + one
   `session/prompt` against `opencode acp` and `cmd acp` on Windows; log every `session/update`,
   `session/request_permission`, the advertised `configOptions` (model / effort), and how a clarifying
   question arrives (expected: a message then `stopReason: end_turn`). Findings decide model/effort wiring.
1. `git init` the repo; `bridge/` TS project (package.json, tsconfig, vitest); `agents.ts`, `worktree.ts`.
2. `task.ts` + ACP client wiring; fake ACP agent fixture for tests (scripted updates, a permission
   request, a question).
3. `server.ts` + NDJSON event emitter; bridge tests over HTTP against the fake agent.
4. Mod: manifest, contract, `session.start` bridge spawn + event loop + atoms; tools → `$.http.fetch`.
5. Mod: Pane (layout A + expand), `/relay` command, `$.prompt.submit` wake-ups, `prompt.compose` rules.
6. Merge/diff/cleanup flow; parallel tasks.

## Verification

- `bridge`: `npx tsc --noEmit`, `npx vitest run` (fake agent covers update streaming, question,
  permission round-trip, cancel, worktree create/diff/cleanup).
- Mod: `claude plugin validate mod/agent-relay`, `tsc -p mod/agent-relay`, `claude plugin test
  mod/agent-relay` (pane renders cards from state; tools call the bridge).
- End-to-end in a scratch git repo: delegate "add a README section" to OpenCode
  (`opencode/glm-5.3-flash-free`) and a tiny test file to Command Code (`deepseek/deepseek-v4-flash`) in
  parallel; watch both cards update live; force a question and a permission request; confirm Claude
  answers one itself, escalates one to the user, the answer reaches the agent, and diffs merge cleanly.

## Spike findings (2026-10-25, step 0 done)

- **Spawn entries (Windows):** OpenCode → `%APPDATA%/npm/node_modules/@opencode/cli/bin/opencode.exe acp`;
  Command Code → `node %APPDATA%/npm/node_modules/command-code/dist/index.mjs acp`.
  Resolve via `npm root -g` at runtime, not hard-coded.
- **Model / effort:** both expose ACP `configOptions` on `session/new`. Set with
  `session/set_config_option {sessionId, configId, type:"id", value}`. OpenCode: `model` (9 free models),
  `mode` (build/plan); an `effort` option appears only after a model is set. Command Code: `model`
  (94 incl. Claude/GPT/DeepSeek/Kimi/GLM…), `effort` (`default|off|high|max`), plus ACP `modes`
  (`default|auto-accept|plan|dont-ask|bypass`). Apply whatever the agent advertises; skip absent ones.
- **Permissions:** Command Code asks via `session/request_permission` for edits (options
  `allow_once|allow_always|reject_once|reject_always`). OpenCode asks **nothing** by default; with env
  `OPENCODE_CONFIG_CONTENT='{"permission":{"edit":"allow","bash":"ask","webfetch":"ask"}}'` it asks for shell
  (options `once|always|reject`). Bridge sets that env for OpenCode.
- **Questions — two shapes:**
  - Command Code's ask-user tool arrives as `session/request_permission` whose `toolCall.rawInput` has
    `question` + `options[]`, and whose options are `option_N` (kind `allow_once`). Must be routed to Claude
    as a **question**, never auto-allowed. Answer = the chosen `optionId`.
  - OpenCode's `question` tool fails under ACP; it asks in the final message text and ends with
    `stopReason: end_turn`. Claude reads the last message and replies with a new `session/prompt`.
- **Streamed updates:** `agent_message_chunk`, `agent_thought_chunk`, `tool_call` (`kind`
  edit/execute/other/think, `title`, `locations[].path`, `rawInput`), `tool_call_update` (`status`
  pending/in_progress/completed/failed, `content`), `usage_update` (`used`, `size`, `cost.amount`,
  `cost.currency`), `available_commands_update`.
- **Turn end:** `session/prompt` resolves `{stopReason, usage}`.

## Command Code credits → free-model fallback (user request, 2026-10-25)

- `cmd usage` needs a TTY; ACP exposes no usage command. So v1:
  1. **Spend tracking:** sum `usage_update.cost.amount` per task and per session; show on cards and in
     `relay_status`.
  2. **Out-of-credits detection:** a Command Code prompt error or final text matching
     `/insufficient credits|premium credits exhausted|usage limit (reached|for your plan)/i` marks the
     task `out_of_credits` and wakes Claude.
  3. **Fallback rule (Claude):** before delegating to Command Code, check `relay_credits`; on
     `out_of_credits`, re-delegate the same brief to OpenCode with a free model (default
     `opencode/glm-5.3-flash-free`) and tell the user.
