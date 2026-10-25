// The agent-relay mod's contract: the bridge's shapes it folds into state
// (copied from bridge/src/types.ts, which a mod cannot import), and the state
// it keeps for the session.

export type AgentId = 'opencode' | 'commandcode'

export type TaskStatus =
  | 'starting'
  | 'running'
  | 'asking'
  | 'waiting_permission'
  | 'idle'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'out_of_credits'

export type ActivityEntry = {
  at: number
  kind: 'thought' | 'message' | 'tool'
  text: string
  toolCallId?: string
  status?: string
}

export type PendingRequest = {
  requestId: string
  type: 'permission' | 'question'
  title: string
  toolKind?: string
  rawInput?: unknown
  options: { optionId: string; name: string; kind: string }[]
}

export type TaskSummary = {
  id: string
  agent: AgentId
  title: string
  model?: string
  effort?: string
  status: TaskStatus
  currentStep?: string
  filesTouched: string[]
  startedAt: number
  updatedAt: number
  costUsd: number
  pending?: PendingRequest
  lastMessage?: string
  waitingOnUser: boolean
  branch: string
  worktree: string
}

export type AttentionReason = 'question' | 'permission' | 'turn_ended' | 'failed' | 'out_of_credits'

export type BridgeEvent =
  | { type: 'task'; task: TaskSummary }
  | { type: 'activity'; taskId: string; entry: ActivityEntry }
  | { type: 'attention'; taskId: string; reason: AttentionReason; text: string }

export type BridgeReady = { type: 'ready'; port: number; token: string }

export type BridgeState = { status: 'starting' | 'up' | 'down'; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-relay': {
      tasks: TaskSummary[]
      bridge: BridgeState
      expanded: string | null
      activity: Record<string, ActivityEntry[]>
    }
  }
}
