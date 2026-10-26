# Agent Relay

Agent Relay lets Claude, in Claude Code, hand build tasks to OpenCode and Command Code agents. Each task runs in its own git worktree and branch. You follow the tasks in an Agents pane with one card per task, and Claude answers the agents' questions and permission requests, asks you when a decision is yours, reviews the diff and merges the result.

It has two parts: a Node bridge (`bridge/`) that runs the agents over ACP and serves a local HTTP API, and a Claude Code mod (`mod/agent-relay/`) that starts the bridge for each session, draws the pane and gives Claude the `relay_*` tools.

## Requirements

- Node 26 or later
- git
- OpenCode, Command Code, or both, installed and logged in

## Load the mod in Claude Code

Point Claude Code at the mod folder:

```sh
claude --plugin-dir <repo>/mod/agent-relay
```

or set the environment variable before you start it:

```sh
CLAUDE_CODE_PLUGIN_DIRS=<repo>/mod/agent-relay claude
```

On each session start the mod runs `node <bridgePath>`, opens the Agents pane and adds the `/relay` command, which opens the pane again.

### The `bridgePath` option

`bridgePath` is the absolute path of the bridge's `main.ts`. The default is `E:/ataspace/aiPlayground/Communication/bridge/src/main.ts`. If you cloned the repo somewhere else, set `bridgePath` to `<repo>/bridge/src/main.ts` in the plugin's settings.

Run `npm install` in `bridge/` once before the first session.

## Tests

Bridge:

```sh
cd bridge && npm install && npm test
```

Mod:

```sh
claude plugin test mod/agent-relay
```

## Security notes

- Each task runs in its own worktree (`<repo>/.relay/wt/<task id>`, branch `relay/<task id>`), made from the last commit. The main tree changes only when Claude merges a task.
- The bridge allows on its own only reads and edits of files inside the task's worktree. Every other permission request (shell commands, network, paths outside the worktree, anything it cannot parse) goes to Claude, who asks you for new dependencies, deletes outside the task, secrets and deploys.
- Everything an agent writes is treated as untrusted data, in the prompts that wake Claude and in the pane.

Known limits:

- Hardlinks are not detected. A hardlink in the worktree to a file elsewhere on the same volume passes as a worktree file: an edit through it changes that file, and its content can be committed to the task's branch.
- Both agents read files without asking, files outside the worktree included. The bridge sees no request for those reads, so it cannot stop them.
