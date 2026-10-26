# Agent Relay — end-to-end run (2026-10-26)

Live Claude Code desktop session, mod loaded from the session's dev-mods folder, bridge started by the mod. Scratch repo with `README.md`, `src/sum.js`, `package.json`.

| Check | Result |
| --- | --- |
| Bridge starts with the session and stays up (stdin closed by `$.process.spawn`) | Pass. Bridge's parent is `claude.exe`, so the parent watch tracks the engine. |
| Two agents in parallel, separate worktrees | Pass: `oc-1` (OpenCode, `opencode/glm-5.3-flash-free`), `cc-2` (Command Code, `deepseek/deepseek-v4-flash`, effort `off`). |
| Shell permission reaches Claude and the answer reaches the agent | Pass: OpenCode `git log --oneline -1`; Command Code `dir … & git status --short`. |
| In-worktree edit auto-allowed (OpenCode `edit: "ask"`, ruling R16) | Pass: bridge thread shows `auto-allowed edit inside worktree: …\README.md`. |
| Command Code ask-user question routed as a question, escalated to the user, answer relayed with `fromUser` | Pass: user picked `node:test`; card showed "Waiting on you". |
| Turn-end commit, diff review, merge | Pass: `oc-1` and `cc-2` merged with `--no-ff`; `node --test` on merged main: 3 pass. |
| Reply into an idle session (second prompt) | Pass. |
| Cost tracking | Pass: Command Code $0.0025 → $0.0050 over two turns (cumulative, ruling R20). OpenCode $0. |
| Stop a running task | Pass: `relay_cancel` killed the agent and its `opencode serve` child; branch and worktree kept. |

## Found during the run

- Command Code's learning system writes `.commandcode/taste/taste.md` into the worktree after each turn, and the bridge's turn-end commit picked it up. The agent rightly refused to delete it. Fix: the bridge should keep agent-owned state folders (`.commandcode/`, `.opencode/`) out of relay commits.

## Not covered

- Graceful bridge shutdown when the session ends (needs the session to end).
- Pressing the pane's Stop button by hand (`relay_cancel` uses the same route).
- An out-of-credits run (Command Code had credit).
