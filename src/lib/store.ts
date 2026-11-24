/**
 * Zustand store. The browser holds only a *projection* of the App Server's
 * append-only log: frames for replay, a cursor, and UI-local state.
 */

import { create } from 'zustand'
import type {
  ApprovalRequest,
  ConfigView,
  ControlCommand,
  CriterionDecl,
  Frame,
  OrderTemplate,
  RpcMessage,
  Snapshot,
  ThreadInfo,
} from './contract'
import { approvalParams, RpcClient } from './rpc'

const MAX_FRAMES = 600

/**
 * REST base for the App Server. Replay over a long append-only log is heavy
 * (one full projection per event), so the first paint comes from a single
 * snapshot fetch and live frames are polled as a safety net next to the
 * JSON-RPC notification stream.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://127.0.0.1:8787'

let pollTimer: ReturnType<typeof setInterval> | null = null

function snapshotFrame(snap: Snapshot): Frame {
  return {
    event: {
      seq: snap.seq,
      ts: Date.now(),
      threadId: snap.threadId,
      kind: 'workshop/snapshot',
      actor: 'server',
      stage: '',
      payload: { source: 'snapshot-poll' },
    },
    snapshot: snap,
  }
}

let client: RpcClient | null = null

interface MedusaState {
  frames: Frame[]
  cursor: number
  playing: boolean
  speed: number
  connected: boolean
  error: string | null
  selectedWorkerId: string | null
  approval: { id: number | string; request: ApprovalRequest } | null
  config: ConfigView | null
  /** Templates + criteria arrive with the initialize handshake. */
  orderDesk: { templates: OrderTemplate[]; criteria: CriterionDecl[] } | null
  threads: ThreadInfo[]
  activeThread: string
  protocolVersion: string
  configHome: string
  connect: () => void
  setCursor: (index: number) => void
  setPlaying: (value: boolean) => void
  setSpeed: (value: number) => void
  selectWorker: (id: string | null) => void
  sendControl: (command: ControlCommand) => Promise<void>
  replyApproval: (decision: 'allow' | 'deny') => void
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>
  updateConfig: (patch: Record<string, unknown>) => Promise<void>
}

export const selectSnapshot = (state: MedusaState) =>
  state.frames[state.cursor]?.snapshot ?? null

export const useMedusaStore = create<MedusaState>((set, get) => ({
  frames: [],
  cursor: 0,
  playing: true,
  speed: 1,
  connected: false,
  error: null,
  selectedWorkerId: null,
  approval: null,
  config: null,
  orderDesk: null,
  threads: [],
  activeThread: 'main',
  protocolVersion: '—',
  configHome: '—',

  connect: () => {
    if (client) return

    // First paint: one snapshot is enough to mount the whole 3D workshop,
    // even before (or without) a full append-only replay.
    const applySnapshot = (snap: Snapshot) => {
      if (!snap || typeof snap.seq !== 'number') return
      set((state) => {
        const last = state.frames[state.frames.length - 1]
        if (last && snap.seq <= (last.snapshot?.seq ?? -1)) return state
        const frames = [...state.frames, snapshotFrame(snap)]
        if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES)
        return {
          frames,
          cursor: state.playing ? frames.length - 1 : Math.min(state.cursor, frames.length - 1),
          speed: snap.speed ?? state.speed,
        }
      })
    }

    // Live fallback: keeps the workshop moving when notifications are lost
    // or the replay request is still in flight.
    const pollOnce = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/snapshot`, { cache: 'no-store' })
        if (!res.ok) return
        applySnapshot((await res.json()) as Snapshot)
      } catch {
        /* App Server 尚未就绪时静默重试 */
      }
    }

    client = new RpcClient(undefined, {
      onFrame: (frame) =>
        set((state) => {
          const frames = [...state.frames, frame]
          if (frames.length > MAX_FRAMES) frames.shift()
          return {
            frames,
            cursor: state.playing
              ? frames.length - 1
              : Math.min(state.cursor, frames.length - 1),
            speed: frame.snapshot?.speed ?? state.speed,
          }
        }),
      onNotification: (method, params) => {
        // A timed-out signature gate must not leave a dead approval card on
        // screen. The server broadcasts the expiry with the request id.
        if (method === 'approval/expired') {
          const p = (params ?? {}) as { id?: number | string }
          const current = get().approval
          if (current && (p.id === undefined || Number(current.id) === Number(p.id))) {
            set({ approval: null, playing: true })
          }
        }
        // Other fine-grained notifications surface through frames + event log.
      },
      onServerRequest: (msg: RpcMessage) => {
        set({
          approval: {
            id: msg.id as number | string,
            request: approvalParams(msg),
          },
          playing: false,
        })
      },
      onState: (connected, error) => set({ connected, error }),
      onReady: (result) => {
        const cfg = result.config as ConfigView | undefined
        if (cfg) {
          set({
            config: cfg,
            protocolVersion: String(result.protocolVersion ?? '—'),
            configHome: String(result.configHome ?? '—'),
            activeThread: String(result.activeThread ?? 'main'),
          })
        }
        const templates = result.templates as OrderTemplate[] | undefined
        const criteria = result.criteria as CriterionDecl[] | undefined
        if (Array.isArray(templates) && Array.isArray(criteria)) {
          set({ orderDesk: { templates, criteria } })
        }
        // Replay the persisted log so a reload restores the exact timeline.
        void get()
          .call<{ frames?: Frame[]; thread?: ThreadInfo }>('thread/resume', {})
          .then((res) => {
            if (Array.isArray(res?.frames) && res.frames.length > 0) {
              set((state) => ({
                frames: res.frames!.slice(-MAX_FRAMES),
                cursor: state.playing ? res.frames!.length - 1 : state.cursor,
              }))
            }
          })
          .catch(() => undefined)
        void get()
          .call<{ threads?: ThreadInfo[] }>('thread/list', {})
          .then((res) => {
            if (Array.isArray(res?.threads)) set({ threads: res.threads! })
          })
          .catch(() => undefined)

        // Paint immediately, then keep a slow poll as the safety net.
        void pollOnce()
        if (!pollTimer) {
          pollTimer = setInterval(() => void pollOnce(), 1000)
        }
      },
    })
    client.connect()
  },

  setCursor: (index) =>
    set((state) => ({
      cursor: Math.max(0, Math.min(index, Math.max(0, state.frames.length - 1))),
      playing: false,
    })),

  setPlaying: (value) =>
    set((state) => ({
      playing: value,
      cursor: value ? Math.max(0, state.frames.length - 1) : state.cursor,
    })),

  setSpeed: (value) => set({ speed: value }),

  selectWorker: (id) => set({ selectedWorkerId: id }),

  sendControl: async (command) => {
    if (command.action === 'pause') set({ playing: false })
    if (command.action === 'resume') set({ playing: true })
    if (command.action === 'speed' && command.value) set({ speed: command.value })
    try {
      await get().call('control', {
        action: command.action,
        workerId: command.workerId,
        stageId: command.stageId,
        value: command.value,
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '控制指令发送失败' })
    }
  },

  replyApproval: (decision) => {
    const a = get().approval
    if (!a || !client) return
    client.reply(a.id, { decision, note: '来自 3D 车间面板' })
    set({ approval: null, playing: true })
  },

  call: async <T = unknown>(method: string, params: unknown = {}) => {
    if (!client) throw new Error('未连接')
    return client.request<T>(method, params)
  },

  updateConfig: async (patch) => {
    try {
      const cfg = await get().call<ConfigView>('config/write', patch)
      if (cfg) set({ config: cfg })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '配置保存失败' })
    }
  },
}))
