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
