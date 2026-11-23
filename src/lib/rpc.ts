/**
 * JSON-RPC 2.0 client for the Medusa App Server.
 *
 * Mirrors the Codex App Server client shape:
 *  - `initialize` request, then `initialized` notification (handshake gate)
 *  - pending request map with ids
 *  - notification subscriptions
 *  - *server-initiated requests* (approval/request) that suspend a turn
 *  - reconnect + `thread/resume` replay from the append-only log
 */

import type { ApprovalRequest, Frame, RpcMessage, SessionEvent } from './contract'

export interface RpcHandlers {
  onFrame: (frame: Frame) => void
  onNotification: (method: string, params: unknown) => void
  onServerRequest: (msg: RpcMessage) => void
  onState: (connected: boolean, error: string | null) => void
  onReady: (result: Record<string, unknown>) => void
}

const DEFAULT_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'ws://127.0.0.1:8787/rpc'

type Pending = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RpcClient {
  private ws: WebSocket | null = null
  private id = 0
  private pending = new Map<number, Pending>()
  private closed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0

  constructor(
    private readonly url: string = DEFAULT_URL,
    private readonly handlers: RpcHandlers,
  ) {}

  connect() {
    this.closed = false
    this.open()
  }

  private open() {
    if (this.closed) return
    this.handlers.onState(false, null)
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.scheduleReconnect(String(e))
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      // Codex-style handshake: initialize must precede every other call.
      void this.request('initialize', {
        clientInfo: {
          name: 'medusa_next_ui',
          title: 'Medusa 3D Workshop',
          version: '0.1.0',
        },
        capabilities: { approvals: true, replay: true },
      }).then((result) => {
        this.notify('initialized', {})
        this.handlers.onState(true, null)
        this.handlers.onReady(result as Record<string, unknown>)
      })
    }

    ws.onmessage = (event) => {
      let msg: RpcMessage
      try {
        msg = JSON.parse(String(event.data)) as RpcMessage
      } catch {
        return
      }
      this.handle(msg)
    }

    ws.onerror = () => {
      this.handlers.onState(false, 'App Server 连接失败，正在重连…')
    }

    ws.onclose = () => {
      this.ws = null
      this.handlers.onState(false, '连接已断开，正在重连…')
      this.rejectAll()
      this.scheduleReconnect('closed')
    }
  }

  private handle(msg: RpcMessage) {
    // Response to one of our requests.
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const key = Number(msg.id)
      const p = this.pending.get(key)
      if (!p) return // may be a late approval reply
      clearTimeout(p.timer)
      this.pending.delete(key)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }

    // Server-initiated request (approval/request) — has method AND id.
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      this.handlers.onServerRequest(msg)
      return
    }

    // Plain notification.
    if (msg.method) {
      this.handlers.onNotification(msg.method, msg.params)
      if (msg.method === 'workshop/snapshot') {
        const frame = msg.params as Frame
        if (frame?.event) this.handlers.onFrame(frame)
      }
    }
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('未连接'))
    }
    const id = ++this.id
    const payload: RpcMessage = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`请求超时: ${method}`))
      }, 15_000)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      ws.send(JSON.stringify(payload))
    })
  }

  notify(method: string, params: unknown = {}) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  /** Reply to a server-initiated request (approval gate). */
  reply(id: number | string, result: unknown) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }

  private rejectAll() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接断开'))
    }
    this.pending.clear()
  }

  private scheduleReconnect(reason: string) {
    if (this.closed) return
    this.attempts += 1
    const delay = Math.min(1000 * 2 ** Math.min(this.attempts, 4), 8000)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      void reason
      this.open()
    }, delay)
  }

  close() {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
    this.rejectAll()
  }
}

export function approvalParams(msg: RpcMessage): ApprovalRequest {
  const p = (msg.params ?? {}) as Record<string, unknown>
  return {
    stage: String(p.stage ?? ''),
    note: String(p.note ?? ''),
    taskId: String(p.taskId ?? ''),
    turnId: String(p.turnId ?? ''),
    options: Array.isArray(p.options) ? (p.options as string[]) : ['allow', 'deny'],
  }
}

export function eventLabel(kind: string): string {
  const labels: Record<string, string> = {
    'run.started': '班次开始',
    'thread.started': '线程创建',
    'thread.resumed': '线程恢复',
    'turn.started': '轮次开始 · 投料',
    'turn.completed': '轮次完成',
    'turn.interrupted': '轮次被叫停',
    'item.started': '项目开始',
    'item.agentMessage.delta': '流式输出',
    'item.completed': '项目完成',
    'task.moved': '工件流转',
    'worker.blocked': '工人阻塞',
    'worker.resumed': '恢复工作',
    'boss.patrol': '老板巡逻',
    'boss.inspection': '老板抽查',
    'boss.intervention': '老板介入 / 审批',
    'system.control': '人工介入',
    'config.updated': '配置更新',
    'external.event': '外部上报',
    'session.event': '会话事件',
  }
  return labels[kind] ?? kind
}

export function eventDetail(event: SessionEvent): string {
  const p = event.payload ?? {}
  const note = typeof p.note === 'string' ? p.note : ''
  const delta = typeof p.delta === 'string' ? p.delta : ''
  const parts = [note, delta].filter(Boolean)
  return parts.join(' · ').slice(0, 90)
}
