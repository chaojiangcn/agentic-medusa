/**
 * Wire contract — TypeScript mirror of `server/src/protocol.rs`.
 *
 * The Rust side is the single source of truth (Codex App Server style).
 * When protocol.rs changes, regenerate this file with:
 *   npm run sync:protocol
 * Then run `npm run typecheck` to catch drift.
 *
 * Shaped after the Codex App Server: JSON-RPC 2.0 (bidirectional),
 * an `initialize` handshake, and Thread > Turn > Item primitives with
 * explicit lifecycles. State is a projection of an append-only log.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: RpcError
}

export const PROTOCOL_VERSION = '2026-11-20'

// ---------------------------------------------------------------------------
// Session log — append-only fact
// ---------------------------------------------------------------------------

export interface SessionEvent {
  seq: number
  ts: number
  threadId: string
  turnId?: string
  itemId?: string
  /** e.g. "item.started", "item.agentMessage.delta", "boss.inspection" */
  kind: string
  actor: string
  stage: string
  taskId?: string
  workerId?: string
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Conversation primitives
// ---------------------------------------------------------------------------

export interface ThreadInfo {
  id: string
  title: string
  createdAt: number
  headSeq: number
  turnCount: number
  status: 'active' | 'archived' | 'forked' | string
  forkedFrom?: string
}

export interface TurnInfo {
  id: string
  threadId: string
  taskId: string
  status: 'running' | 'completed' | 'interrupted' | 'paused' | string
  startedAt: number
  items: number
  tokens: number
}

export interface ItemInfo {
  id: string
  turnId: string
  kind: string
  status: 'started' | 'completed' | string
  workerId: string
  stage: string
  text: string
  tokens: number
}

// ---------------------------------------------------------------------------
// Tools — the host's capability ledger (office equipment)
// ---------------------------------------------------------------------------

/** Static definition: what the device is and which buttons it has. */
export interface ToolSpec {
  name: string
  label: string
  description: string
  stageId: string
  /** 'safe' | 'approval' — enforced in the protocol layer, not the browser. */
  permission: 'safe' | 'approval' | string
  inputSchema: Record<string, unknown>
}

/** Derived runtime view: the ledger plus usage counters from the log. */
export interface ToolView {
  name: string
  label: string
  description: string
  stageId: string
  permission: 'safe' | 'approval' | string
  calls: number
  lastSeq: number
  active: boolean
  lastReceipt: string
}

export interface ToolOutcome {
  ok: boolean
  receipt: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// Workshop projection (derived from the log)
// ---------------------------------------------------------------------------

export interface Vec3 { x: number; y: number; z: number }

export interface Stage {
  id: string
  name: string
  position: Vec3
  color: string
}

export type WorkerStatus = 'idle' | 'busy' | 'blocked' | 'paused' | string
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | string
export type BossMode = 'patrol' | 'inspect' | 'intervene' | string

export interface Worker {
  id: string
  name: string
  model: string
  stageId: string
  status: WorkerStatus
  load: number
  tokens: number
  taskId?: string | null
  /** Per-role model override. */
  configId?: string
}

export interface WorkTask {
  id: string
  title: string
  stageIndex: number
  progress: number
  status: TaskStatus
}

export interface Boss {
  x: number
  z: number
  targetStageId: string
  mode: BossMode
  note: string
}

export interface Metrics {
  tokens: number
  cost: number
  activeWorkers: number
  blocked: number
  completed: number
  failed: number
  throughput: number
  llmCalls: number
}

export interface Snapshot {
  runId: string
  seq: number
  tick: number
  threadId: string
  playing: boolean
  speed: number
  stages: Stage[]
  workers: Worker[]
  tasks: WorkTask[]
  boss: Boss
  metrics: Metrics
  threads: ThreadInfo[]
  turns: TurnInfo[]
  items: ItemInfo[]
  tools: ToolView[]
  lastEvent: SessionEvent | null
}

/** One replayable frame: the logged fact plus the resulting projection. */
export interface Frame {
  event: SessionEvent
  snapshot: Snapshot
}

// ---------------------------------------------------------------------------
// Config (secrets never cross the wire)
// ---------------------------------------------------------------------------

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  model: string
  envKey: string
  wireApi: 'chat' | 'responses' | string
}

export interface ConfigView {
  mode: 'mock' | 'live' | string
  model: string
  modelProvider: string
  providers: ModelProvider[]
  tickMs: number
  maxTokensPerTurn: number
  maxCallsPerMinute: number
  /** Only a boolean — never the API key itself. */
  hasApiKey: boolean
  protocolVersion: string
  userAgent: string
  configHome: string
}

// ---------------------------------------------------------------------------
// Server-initiated requests
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  stage: string
  note: string
  taskId: string
  turnId: string
  options: string[]
}

export interface ApprovalReply {
  decision: 'allow' | 'deny'
  note?: string
}

export type ControlAction = 'pause' | 'resume' | 'stop' | 'reassign' | 'speed' | 'reset' | string

export interface ControlCommand {
  action: ControlAction
  workerId?: string
  stageId?: string
  value?: number
}
