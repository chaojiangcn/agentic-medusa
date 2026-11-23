/**
 * Zustand store. The browser holds only a *projection* of the App Server's
 * append-only log: frames for replay, a cursor, and UI-local state.
 */

import { create } from 'zustand'
import type {
  ApprovalRequest,
  ConfigView,
  ControlCommand,
  Frame,
  RpcMessage,
  ThreadInfo,
} from './contract'
import { approvalParams, RpcClient } from './rpc'

const MAX_FRAMES = 3000

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
  threads: [],
  activeThread: 'main',
  protocolVersion: '—',
  configHome: '—',

  connect: () => {
    if (client) return
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
      onNotification: () => {
        // Fine-grained notifications are surfaced through frames + event log.
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
