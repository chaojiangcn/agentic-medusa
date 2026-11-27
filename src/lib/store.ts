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
import { ALL_KEY, APPEARANCE_STORAGE_KEY } from './appearance'
import type { AvatarConfig, AvatarTarget } from './appearance'

const MAX_FRAMES = 600

/**
 * UI-local camera shots. Like appearance, a shot is a projection preference:
 * it never reaches the App Server and never enters the append-only log.
 * One table feeds the topbar, the keyboard shortcuts and the camera tween.
 */
export type CameraPreset = 'studio' | 'desk' | 'close' | 'wide' | 'board'

export interface CameraShot {
  label: string
  hint: string
  position: [number, number, number]
  target: [number, number, number]
  fov: number
}

export const CAMERA_STORAGE_KEY = 'medusa.camera.v1'

// The 3D canvas is full-bleed but the two side panels cover ~576 px of it, so
// only the middle ~60% of the frame is actually readable. Every shot is
// framed for that window, not for the raw canvas.
export const CAMERA_PRESETS: Record<CameraPreset, CameraShot> = {
  studio: {
    label: '平视', hint: '房间空间感 · 快捷键 1',
    position: [0.35, 2.45, 8.15], target: [0, 0.95, 0.25], fov: 41,
  },
  desk: {
    label: '桌面', hint: '看清显示器与桌面陈设 · 快捷键 2',
    position: [0, 7.0, 5.8], target: [0, 0.2, -0.9], fov: 44,
  },
  close: {
    label: '近景', hint: '对准第一张工位与人物 · 快捷键 3',
    position: [-1.58, 1.74, 2.95], target: [-2.02, 0.86, -0.78], fov: 33,
  },
  wide: {
    label: '全景', hint: '整间工作室与后场陈设 · 快捷键 4',
    // Close and low: a flatter angle compresses the floor between the desks
    // and the camera, which was the emptiest part of the wide frame.
    position: [0, 2.2, 7.6], target: [0, 1.0, -1.6], fov: 46,
  },
  // The wall board carries the shift's goal and plan. A dedicated shot is the
  // only way to actually read it — from the room shots it is ~200 px wide and
  // the floating REC nameplates sit right on top of it.
  board: {
    label: '白板', hint: '正对任务白板，读目标与规划 · 快捷键 5',
    position: [0, 2.8, -2.0], target: [0, 2.42, -7.62], fov: 40,
  },
}

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

function persistAppearance(appearance: Record<string, Partial<AvatarConfig>>) {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance))
  } catch {
    // Private mode / quota: the session still works, it just does not persist.
  }
}

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
  /** UI-local appearance: never sent to the App Server. */
  appearance: Record<string, Partial<AvatarConfig>>
  avatarEditor: AvatarTarget | null
  /** UI-local camera shot, persisted in localStorage. */
  cameraPreset: CameraPreset
  setCameraPreset: (preset: CameraPreset) => void
  hydrateCamera: () => void
  /** Clicking a device or camera in 3D asks the panel to focus that tab. */
  focusTool: string | null
  focusCamera: string | null
  /** A 3D click can ask the side panel to switch tabs. */
  tabRequest: { tab: string; seq: number } | null
  connect: () => void
  setCursor: (index: number) => void
  setPlaying: (value: boolean) => void
  setSpeed: (value: number) => void
  selectWorker: (id: string | null) => void
  sendControl: (command: ControlCommand) => Promise<void>
  replyApproval: (decision: 'allow' | 'deny') => void
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>
  updateConfig: (patch: Record<string, unknown>) => Promise<void>
  hydrateAppearance: () => void
  setAvatar: (key: string, patch: Partial<AvatarConfig>) => void
  applyAvatarToAll: (config: AvatarConfig) => void
  resetAppearance: () => void
  openAvatarEditor: (target: AvatarTarget) => void
  closeAvatarEditor: () => void
  focusOnTool: (name: string) => void
  focusOnCamera: (id: string) => void
  requestTab: (tab: string) => void
}

export const selectSnapshot = (state: MedusaState) => {
  // Clamp instead of trusting the cursor: the frame buffer is trimmed at the
  // front, so a stale cursor can point past the end. Returning null there
  // unmounts the whole 3D tree (every Html label included).
  const index = Math.min(Math.max(state.cursor, 0), state.frames.length - 1)
  if (state.frames[index]?.snapshot) return state.frames[index].snapshot
  // A frame can arrive without a projection (a transport artifact, or an event
  // written while the shop was mid-update). The newest frame is not allowed to
  // blank the room: fall back to the closest earlier frame that still has one.
  for (let i = index - 1; i >= 0; i--) {
    if (state.frames[i]?.snapshot) return state.frames[i].snapshot
  }
  return null
}

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
  appearance: {},
  avatarEditor: null,
  cameraPreset: 'studio',
  focusTool: null,
  focusCamera: null,
  tabRequest: null,

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
        void get()
          .call<{ threads?: ThreadInfo[] }>('thread/list', {})
          .then((res) => {
            if (Array.isArray(res?.threads)) set({ threads: res.threads! })
          })
          .catch(() => undefined)

        // First paint comes from one snapshot plus the live stream. Calling
        // `thread/resume` here replayed the entire log — after a long shift
        // that response grew to ~44 MB (every event plus 240 full projections)
        // and blocked the main thread for ten seconds, which looked exactly
        // like "the workshop never loaded". The timeline now builds from the
        // frames collected during this session, and the REST snapshot fills
        // the first frame immediately.
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

  hydrateAppearance: () => {
    try {
      const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, Partial<AvatarConfig>>
      if (parsed && typeof parsed === 'object') set({ appearance: parsed })
    } catch {
      // A corrupt value simply falls back to defaults.
    }
  },

  setAvatar: (key, patch) =>
    set((state) => {
      const next = {
        ...state.appearance,
        [key]: { ...(state.appearance[key] ?? {}), ...patch },
      }
      persistAppearance(next)
      return { appearance: next }
    }),

  applyAvatarToAll: (config) => {
    // Drop per-target overrides, otherwise "apply to all" would look broken.
    persistAppearance({ [ALL_KEY]: config })
    set({ appearance: { [ALL_KEY]: config } })
  },

  resetAppearance: () => {
    persistAppearance({})
    set({ appearance: {} })
  },

  openAvatarEditor: (target) => set({ avatarEditor: target }),
  closeAvatarEditor: () => set({ avatarEditor: null }),

  setCameraPreset: (preset) => {
    try {
      localStorage.setItem(CAMERA_STORAGE_KEY, preset)
    } catch {
      // Private mode / quota: the shot still applies for this session.
    }
    set({ cameraPreset: preset })
  },

  hydrateCamera: () => {
    try {
      const raw = localStorage.getItem(CAMERA_STORAGE_KEY)
      if (raw === 'studio' || raw === 'desk' || raw === 'close' || raw === 'wide' || raw === 'board') {
        set({ cameraPreset: raw })
      }
    } catch {
      // A corrupt value just falls back to the eye-level shot.
    }
  },
  focusOnTool: (name) => set({ focusTool: name }),
  focusOnCamera: (id) => set({ focusCamera: id }),
  requestTab: (tab) =>
    set((state) => ({
      tabRequest: { tab, seq: (state.tabRequest?.seq ?? 0) + 1 },
    })),

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

// A read-only debug handle. The 3D room is a projection of this store, so a
// blank room is otherwise indistinguishable from a WebGL failure. Headless
// checks read frame counts and snapshots from here.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __medusaStore?: typeof useMedusaStore }).__medusaStore = useMedusaStore
}
