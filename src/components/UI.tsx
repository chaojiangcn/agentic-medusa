'use client'

import { useEffect, useState } from 'react'
import { CAMERA_PRESETS, selectSnapshot, useMedusaStore } from '@/lib/store'
import type { CameraPreset } from '@/lib/store'
import { AvatarEditor } from './AvatarEditor'
import { eventDetail, eventLabel } from '@/lib/rpc'
import type {
  CameraList, DerivedContext, OrderReceipt, OrderTemplate,
} from '@/lib/contract'

const STATUS_LABEL: Record<string, string> = {
  busy: '忙碌',
  idle: '空闲',
  blocked: '阻塞',
  paused: '已暂停',
}

const STATUS_COLOR: Record<string, string> = {
  busy: '#534ab7',
  idle: '#888780',
  blocked: '#d93f3f',
  paused: '#ba7517',
}

function fmt(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 10000) return value.toFixed(0)
  return value.toFixed(digits)
}

export function UI() {
  const store = useMedusaStore()
  const snapshot = useMedusaStore(selectSnapshot)
  const {
    frames, cursor, playing, speed, connected, error, selectedWorkerId,
    approval, config, orderDesk, threads, activeThread, protocolVersion, configHome,
  } = store
  const [tab, setTab] = useState<'orders' | 'workers' | 'tools' | 'dispatch' | 'observe' | 'config' | 'protocol'>('orders')
  const [busy, setBusy] = useState(false)
  // Order desk state. Criteria ids come from the App Server's template list;
  // the browser never invents a rubric the oracle would not recognise.
  const [orderTitle, setOrderTitle] = useState('合规复核')
  const [orderGoal, setOrderGoal] = useState('')
  const [orderCriteria, setOrderCriteria] = useState<string[]>(['conclusion', 'source', 'approved'])
  const [orderBusy, setOrderBusy] = useState(false)
  const [orderReceipt, setOrderReceipt] = useState<OrderReceipt | null>(null)
  const [orderError, setOrderError] = useState<string | null>(null)
  const [toolResult, setToolResult] = useState<{ blocked: boolean; text: string } | null>(null)
  const [context, setContext] = useState<DerivedContext | null>(null)
  const [ctxTask, setCtxTask] = useState<string | null>(null)
  const [ctxLoading, setCtxLoading] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [cameraList, setCameraList] = useState<CameraList | null>(null)
  const [obsBusy, setObsBusy] = useState(false)
  const [obsResult, setObsResult] = useState<string | null>(null)

  // Appearance and the camera shot live in localStorage, so hydration must
  // wait for the client. A click in the 3D scene can also ask this panel to
  // switch tabs.
  useEffect(() => {
    useMedusaStore.getState().hydrateAppearance()
    useMedusaStore.getState().hydrateCamera()
  }, [])

  // 1-4 jump between shots. Ignore keystrokes originating in a form field so
  // typing an order title never yanks the camera out from under the user.
  useEffect(() => {
    const keys: Record<string, CameraPreset> = {
      '1': 'studio', '2': 'desk', '3': 'close', '4': 'wide', '5': 'board',
    }
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const preset = keys[event.key]
      if (preset) useMedusaStore.getState().setCameraPreset(preset)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (store.tabRequest) setTab(store.tabRequest.tab as typeof tab)
  }, [store.tabRequest])

  const maxCursor = Math.max(0, frames.length - 1)
  const recent = frames
    .slice(0, cursor + 1)
    // Polling frames are a transport artifact, not workshop activity.
    .filter((frame) => frame.event.payload?.source !== 'snapshot-poll')
    .slice(-8)
    .reverse()

  const workers = snapshot?.workers ?? []
  const tools = snapshot?.tools ?? []
  const toolCalls = tools.reduce((sum, tool) => sum + tool.calls, 0)
  const dispatch = snapshot?.dispatch ?? []
  const tasks = snapshot?.tasks ?? []
  // The order the ledger is currently talking about: the one whose context is
  // open, else the newest one on the floor.
  const focusTask = tasks.find((t) => t.id === ctxTask) ?? tasks[tasks.length - 1]
  // The request that actually left the process, straight from the log.
  const realCall = (snapshot?.modelLog ?? [])
    .filter((m) => m.taskId === (context?.taskId ?? focusTask?.id))
    .slice(-1)[0]
  const selected = workers.find((worker) => worker.id === selectedWorkerId) ?? workers[0]
  const stageIndex = snapshot?.stages.findIndex((stage) => stage.id === selected?.stageId) ?? -1
  const nextStage = snapshot?.stages[(stageIndex + 1) % (snapshot?.stages.length || 1)]

  const run = async (method: string, params: unknown = {}) => {
    setBusy(true)
    try {
      await store.call(method, params)
    } catch (e) {
      store.sendControl({ action: 'resume' })
    } finally {
      setBusy(false)
    }
  }

  const callTool = async (name: string) => {
    setBusy(true)
    try {
      const res = await store.call<{ blocked: boolean; receipt: string }>('tools/call', { name })
      setToolResult({
        blocked: Boolean(res.blocked),
        text: (res.blocked ? '闸口拦下' : '结果小票') + ' · ' + res.receipt,
      })
    } catch (e) {
      setToolResult({ blocked: true, text: e instanceof Error ? e.message : '设备调用失败' })
    } finally {
      setBusy(false)
    }
  }

  // Derive the model context server-side from the log — the browser never
  // assembles a prompt, it only inspects what the App Server would send.
  const loadContext = async (taskId?: string) => {
    setCtxLoading(true)
    try {
      const res = await store.call<DerivedContext>(
        'session/context',
        taskId ? { taskId } : {},
      )
      setContext(res)
      setCtxTask(res.taskId)
    } catch {
      setContext(null)
    } finally {
      setCtxLoading(false)
    }
  }

  const loadCameras = async () => {
    try {
      const res = await store.call<CameraList>('camera/list', {})
      setCameraList(res)
    } catch {
      setCameraList(null)
    }
  }

  // The rubric arrives with the initialize handshake (App Server is the
  // single source of truth), so the desk is usable on the very first paint.
  const applyTemplate = (t: OrderTemplate) => {
    setOrderTitle(t.title)
    setOrderGoal('')
    setOrderCriteria(t.criteria.map((c) => c.id))
    setOrderReceipt(null)
  }

  const toggleCriterion = (id: string) =>
    setOrderCriteria((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )

  const submitOrder = async (templateId?: string) => {
    setOrderBusy(true)
    setOrderError(null)
    try {
      // A paused floor would leave the order queued forever; resume it first.
      if (snapshot && !snapshot.playing) await store.sendControl({ action: 'resume' })
      const payload: Record<string, unknown> = templateId
        ? { template: templateId }
        : { title: orderTitle.trim(), goal: orderGoal.trim(), criteria: orderCriteria }
      const res = await store.call<OrderReceipt>('turn/start', payload)
      setOrderReceipt(res)
    } catch (e) {
      setOrderError(e instanceof Error ? e.message : '投单失败')
    } finally {
      setOrderBusy(false)
    }
  }

  // A manual capture is still read-only: it only appends observation facts.
  const captureNow = async (cameraId?: string) => {
    setObsBusy(true)
    try {
      const res = await store.call<{
        cameraId: string; coverage: number; blindspots: number; seen: number
      }>('camera/capture', cameraId ? { cameraId } : {})
      setObsResult(
        `${res.cameraId} · 看见 ${res.seen} 条关键事实 · 覆盖率 ${Math.round(res.coverage * 100)}% · 盲区 ${res.blindspots} 处`,
      )
      await loadCameras()
    } catch (e) {
      setObsResult(e instanceof Error ? e.message : '抓拍失败')
    } finally {
      setObsBusy(false)
    }
  }

  useEffect(() => {
    if (tab !== 'dispatch') return
    let cancelled = false
    const call = useMedusaStore.getState().call
    setCtxLoading(true)
    call<DerivedContext>('session/context', {})
      .then((res) => {
        if (cancelled) return
        setContext(res)
        setCtxTask(res.taskId)
      })
      .catch(() => {
        if (!cancelled) setContext(null)
      })
      .finally(() => {
        if (!cancelled) setCtxLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab])

  useEffect(() => {
    // Re-fetch when the tab opens *and* whenever the RPC link comes back:
    // a reload can land on this tab before the handshake finishes.
    if (tab !== 'observe' || !connected) return
    let cancelled = false
    const call = useMedusaStore.getState().call
    call<CameraList>('camera/list', {})
      .then((res) => { if (!cancelled) setCameraList(res) })
      .catch(() => { if (!cancelled) setCameraList(null) })
    return () => { cancelled = true }
  }, [tab, connected])

  return (
    <div className="overlay">
      <header className="topbar">
        <div className="brand">
          <b>Medusa</b>
          <span>流水线车间 · App Server 驱动</span>
        </div>
        <div className="view-switch" role="group" aria-label="镜头机位">
          {(Object.keys(CAMERA_PRESETS) as CameraPreset[]).map((id, index) => (
            <button
              key={id}
              className={store.cameraPreset === id ? 'active' : ''}
              onClick={() => store.setCameraPreset(id)}
              title={CAMERA_PRESETS[id].hint}
            >
              <span className="view-key">{index + 1}</span>{CAMERA_PRESETS[id].label}
            </button>
          ))}
        </div>
        <div className="chips">
          <span className={`chip ${connected ? 'ok' : 'bad'}`}>
            {connected ? '● JSON-RPC' : '○ 断开'}
          </span>
          <span className="chip">v{protocolVersion}</span>
          <span className="chip">{activeThread}</span>
          <span className="chip">帧 {frames.length ? cursor + 1 : 0} / {frames.length}</span>
          <span className="chip accent">老板 · {snapshot?.boss.mode ?? '—'}</span>
        </div>
      </header>

      <aside className="panel left">
        <div className="tabs">
          <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>投单</button>
          <button className={tab === 'workers' ? 'active' : ''} onClick={() => setTab('workers')}>车间</button>
          <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>设备</button>
          <button className={tab === 'dispatch' ? 'active' : ''} onClick={() => setTab('dispatch')}>派单</button>
          <button className={tab === 'observe' ? 'active' : ''} onClick={() => setTab('observe')}>观测</button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>配置</button>
          <button className={tab === 'protocol' ? 'active' : ''} onClick={() => setTab('protocol')}>协议</button>
        </div>

        {tab === 'orders' && (
          <>
            <section>
              <h3>投单台 · 给工作室派活</h3>
              <p className="note">
                工单从这儿进队列，下一个节拍由派单台接手：派单 → 模型推理 → 设备小票 → oracle 判定。
                全过程写进 append-only 日志，刷新后从最新快照恢复。
              </p>
              <div className="order-form">
                <label>工单标题</label>
                <input
                  value={orderTitle}
                  onChange={(e) => setOrderTitle(e.target.value)}
                  placeholder="想让工作室做什么"
                  maxLength={80}
                />
                <label>目标（可选）</label>
                <textarea
                  value={orderGoal}
                  onChange={(e) => setOrderGoal(e.target.value)}
                  rows={2}
                  placeholder="留空则使用模板目标"
                />
              </div>
            </section>

            <section>
              <h3>一键模板 · {orderDesk?.templates.length ?? '…'}</h3>
              <div className="template-grid">
                {(orderDesk?.templates ?? []).map((t) => (
                  <button
                    key={t.id}
                    className={'template-chip' + (orderTitle === t.title ? ' active' : '')}
                    onClick={() => applyTemplate(t)}
                  >
                    <b>{t.title}</b>
                    <small>
                      {t.criteria.length} 条判据
                      {t.criteria.some((c) => c.id === 'approved') ? ' · 要签字' : ''}
                    </small>
                  </button>
                ))}
                {!orderDesk && <p className="empty">连接后读取模板…</p>}
              </div>
            </section>

            <section>
              <h3>验收判据 · {orderCriteria.length} 条</h3>
              <p className="note">
                判定不是进度条走满：每条判据都要在日志里找到证据。勾「已签字」会触发老板签字闸口。
              </p>
              <div className="crit-checks">
                {(orderDesk?.criteria ?? []).map((c) => (
                  <label
                    key={c.id}
                    className={'crit-check' + (orderCriteria.includes(c.id) ? ' on' : '')}
                  >
                    <input
                      type="checkbox"
                      checked={orderCriteria.includes(c.id)}
                      onChange={() => toggleCriterion(c.id)}
                    />
                    <span>{c.label}</span>
                    <code>{c.id}</code>
                  </label>
                ))}
              </div>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button
                  className="primary"
                  disabled={orderBusy || !connected || orderCriteria.length === 0}
                  onClick={() => void submitOrder()}
                >
                  {orderBusy ? '排队中…' : '派给工作室'}
                </button>
              </div>
              {orderError && <p className="error">{orderError}</p>}
              {orderReceipt && (
                <div className="order-receipt">
                  <b>{orderReceipt.taskId} 已入队</b>
                  <small>
                    {orderReceipt.title} · 队列位置 {orderReceipt.queuePosition} · {orderReceipt.criteria.length} 条判据
                  </small>
                  <div className="btn-row" style={{ marginTop: 8, marginBottom: 0 }}>
                    <button onClick={() => { setTab('dispatch'); void loadContext(orderReceipt.taskId) }}>
                      看这张工单
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section>
              <h3>车间节奏</h3>
              <div className="kv"><span>自动演示投料</span><code>{config?.autoDemo ? '开' : '关'}</code></div>
              <div className="btn-row">
                <button onClick={() => void store.updateConfig({ autoDemo: !config?.autoDemo })}>
                  {config?.autoDemo ? '关掉自动投料' : '打开自动投料'}
                </button>
                <button onClick={() => store.sendControl({ action: snapshot?.playing ? 'pause' : 'resume' })}>
                  {snapshot?.playing ? '暂停车间' : '继续车间'}
                </button>
              </div>
              <p className="note">
                默认安静车间：只有你投的单才上流水线。打开自动投料会每 8 个节拍补一张演示单。
              </p>
            </section>

            <section>
              <h3>怎么玩</h3>
              <ol className="howto">
                <li>选「合规复核」模板 → 派给工作室</li>
                <li>切到派单台看派单理由、模型请求体、设备小票</li>
                <li>模型摸到命令终端会弹签字卡：放行才出小票，oracle 才判「通过」</li>
                <li>驳回或 25 秒不理 → 缺签字 → 工单未通过，日志留痕</li>
              </ol>
              <p className="note">
                也能用 curl：<code>POST /api/orders</code> 投单，<code>GET /api/orders</code> 看参数说明。
              </p>
            </section>
          </>
        )}

        {tab === 'workers' && (
          <>
            <section>
              <h3>工人 · {workers.length}</h3>
              {workers.length === 0 && <p className="empty">等待车间数据…</p>}
              {workers.map((worker) => (
                <button
                  key={worker.id}
                  className={`worker-row ${selectedWorkerId === worker.id ? 'active' : ''}`}
                  onClick={() => store.selectWorker(worker.id)}
                >
                  <i className="dot" style={{ background: STATUS_COLOR[worker.status] }} />
                  <span className="worker-info">
                    <b>{worker.name}</b>
                    <small>{worker.model || worker.configId || '未绑定模型'} · {STATUS_LABEL[worker.status] ?? worker.status}</small>
                    <small>{worker.tokens} tok · 工位 {worker.stageId}</small>
                  </span>
                </button>
              ))}
            </section>

            <section>
              <h3>老板 / 人工介入</h3>
              <p className="note">{snapshot?.boss.note || '正在沿流水线巡视'}</p>
              <div className="btn-row">
                <button onClick={() => store.sendControl({ action: 'pause' })}>暂停车间</button>
                <button onClick={() => store.sendControl({ action: 'resume' })}>继续车间</button>
                <button className="danger" onClick={() => store.sendControl({ action: 'stop' })}>叫停</button>
              </div>
              <div className="btn-row">
                <button
                  onClick={() => store.sendControl({
                    action: 'reassign',
                    workerId: selected?.id,
                    stageId: nextStage?.id,
                  })}
                >
                  改派 {selected?.name ?? '—'} → {nextStage?.id ?? '—'}
                </button>
                <button onClick={() => store.sendControl({ action: 'speed', value: speed === 1 ? 2 : 1 })}>
                  节奏 ×{speed === 1 ? 2 : 1}
                </button>
              </div>
              <div className="btn-row">
                <button onClick={() => setTab('orders')}>去投单台</button>
                <button disabled={busy} onClick={() => run('thread/fork', {})}>老板开支线</button>
              </div>
              {error && <p className="error">{error}</p>}
            </section>

            <section>
              <h3>在途工单 · {snapshot?.tasks.filter((task) => task.status === 'running' || task.status === 'queued').length ?? 0}</h3>
              {snapshot?.tasks.filter((task) => task.status !== 'done' && task.status !== 'failed').slice(-5).map((task) => (
                <div className="kv" key={task.id}>
                  <span>{task.id} · {task.title}</span>
                  <code>{Math.round(task.progress * 100)}%</code>
                </div>
              ))}
            </section>
          </>
        )}

        {tab === 'tools' && (
          <section>
            <h3>设备台账 · {tools.length}</h3>
            <p className="note">
              设备由 App Server 注册，浏览器只拿到清单和结果小票，不执行任何东西。
              标「需签字」的设备在协议层就被拦下。
            </p>
            {tools.length === 0 && <p className="empty">连接后读取设备清单…</p>}
            {tools.map((tool) => (
              <div className={'tool-row' + (store.focusTool === tool.name ? ' focus' : '')} key={tool.name}>
                <div className="tool-row-head">
                  <b>{tool.label}</b>
                  <span className={'perm-badge ' + tool.permission}>
                    {tool.permission === 'approval' ? '需签字' : '可直接用'}
                  </span>
                </div>
                <small>{tool.name} · {tool.stageId} · {tool.description}</small>
                <small>调用 {tool.calls} 次 · {tool.lastReceipt || '尚无小票'}</small>
                <div className="btn-row" style={{ marginTop: 7, marginBottom: 0 }}>
                  <button disabled={busy} onClick={() => callTool(tool.name)}>启动设备</button>
                </div>
              </div>
            ))}
            {toolResult && (
              <p className={toolResult.blocked ? 'error' : 'note'}>{toolResult.text}</p>
            )}
          </section>
        )}

        {tab === 'dispatch' && (
          <>
            <section>
              <h3>工单目标与判据</h3>
              <p className="note">
                完成不是进度条走满：判据要在日志里找得到证据，判定由 oracle 写成事实。
                模型说「做完了」只是提议，通过还是驳回都留痕。
              </p>
              {!focusTask && <p className="empty">还没有在跑的工单。</p>}
              {focusTask && (
                <>
                  <div className="kv"><span>工单</span><code>{focusTask.id} · {focusTask.title}</code></div>
                  <div className="kv"><span>目标</span><code>{focusTask.goal || '未声明'}</code></div>
                  <div className="kv"><span>推理轮次</span><code>{focusTask.iterations} 轮</code></div>
                  <div className="criteria">
                    {focusTask.criteria.map((c) => (
                      <div className={'criterion' + (c.ok ? ' ok' : '')} key={c.id}>
                        <span className="crit-mark">{c.ok ? '✓' : '·'}</span>
                        <div>
                          <b>{c.label}</b>
                          <small>
                            {c.note}
                            {c.evidenceSeq ? ` · seq ${c.evidenceSeq}` : ''}
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                  {focusTask.verdict && (
                    <p className={focusTask.verdict.passed ? 'verdict-line pass' : 'verdict-line fail'}>
                      判定 · {focusTask.verdict.passed ? '通过' : '未通过'} · {focusTask.verdict.note}
                    </p>
                  )}
                </>
              )}
            </section>

            <section>
              <h3>派单台 · 最近决策</h3>
              <p className="note">
                工单进哪个工位、交给谁，由调度规则按「工位匹配 / 空闲 / 负载 / 阻塞」打分，
                决策和理由都是日志里的事实，不是前端猜的。
              </p>
              {dispatch.length === 0 && <p className="empty">还没有派单记录，等下一张工单…</p>}
              {dispatch.slice().reverse().map((d) => (
                <div className="dispatch-row" key={d.seq}>
                  <div className="dispatch-head">
                    <b>{d.taskId} → {d.stageId}</b>
                    <span className="dispatch-score">{d.score.toFixed(2)}</span>
                  </div>
                  <small>{d.workerName}（{d.workerId}） · {d.reason}</small>
                  {d.alternatives && <small>备选：{d.alternatives}</small>}
                  <small className="dispatch-seq">seq {d.seq}</small>
                </div>
              ))}
            </section>

            <section>
              <h3>工人看到的上下文</h3>
              <p className="note">
                从 append-only 日志派生：工位 SOP、上游结论、设备小票。每条都带来源 seq，
                底部是 App Server 会原样发出去的请求体。
              </p>
              <div className="btn-row">
                <button disabled={ctxLoading} onClick={() => void loadContext()}>最新工单</button>
                <button disabled={ctxLoading || !ctxTask} onClick={() => void loadContext(ctxTask ?? undefined)}>刷新</button>
                <button disabled={!context} onClick={() => setRequestOpen(true)}>请求体</button>
              </div>
              {ctxLoading && <p className="empty">派生中…</p>}
              {!ctxLoading && !context && <p className="empty">还没有可派生的工单。</p>}
              {context && (
                <>
                  <div className="kv"><span>工单</span><code>{context.taskId}</code></div>
                  <div className="kv"><span>工位 · 工人</span><code>{context.stage || '—'} · {context.workerId || '—'}</code></div>
                  <div className="kv"><span>消息 · 估算</span><code>{context.messages.length} 条 · ~{context.tokensEstimate} tok</code></div>
                  <div className="kv"><span>预算</span><code>{context.tokensEstimate} / {context.budget}</code></div>
                  {context.dropped > 0 && <p className="note">超出预算，已省略 {context.dropped} 条较早记录。</p>}
                  {context.messages.map((m, i) => (
                    <div className={'ctx-msg ' + m.role} key={`${m.role}-${i}`}>
                      <div className="ctx-head">
                        <span className="ctx-role">{m.role}{m.name ? ' · ' + m.name : ''}</span>
                        <span className="ctx-seqs">
                          {m.sourceSeqs.length ? 'seq ' + m.sourceSeqs.slice(0, 3).join(',') : '派生'}
                        </span>
                      </div>
                      <p>{m.content}</p>
                    </div>
                  ))}
                  <p className="note" style={{ marginTop: 8 }}>
                    这就是模型会收到的全部内容。点「请求体」可以看 App Server 原样 POST 的 JSON。
                  </p>
                </>
              )}
            </section>

            <section>
              <h3>工单列表</h3>
              {(snapshot?.turns ?? []).slice(-8).reverse().map((t) => {
                const task = tasks.find((x) => x.id === t.taskId)
                return (
                  <button
                    key={t.id}
                    className={'thread-row' + (ctxTask === t.taskId ? ' active' : '')}
                    onClick={() => void loadContext(t.taskId)}
                  >
                    <b>{t.taskId}</b>
                    <small>
                      {t.status} · {task?.iterations ?? 0} 轮 · {t.items} items · {t.tokens} tok
                    </small>
                    {task?.verdict && (
                      <span className={'perm-badge ' + (task.verdict.passed ? 'safe' : 'approval')}>
                        {task.verdict.passed ? '通过' : '未通过'}
                      </span>
                    )}
                  </button>
                )
              })}
            </section>
          </>
        )}

        {tab === 'observe' && (
          <>
            <section>
              <h3>摄像头 · 只读观测角色</h3>
              <p className="note">
                摄像头不派单、不介入、不改任何工单状态。它只往 append-only 日志写两类事实：
                <code>camera.capture</code>（看到了什么）和 <code>camera.blindspot</code>（哪里是盲区）。
                观测事实不带工单归属，所以永远不会混进模型上下文。
              </p>
              <div className="policy-strip">
                <span className="perm-badge safe">只读</span>
                <span>不决策</span><span>不干预</span><span>不改状态</span>
              </div>
              <div className="btn-row">
                <button disabled={obsBusy} onClick={() => void captureNow()}>手动抓拍</button>
                <button disabled={obsBusy} onClick={() => void loadCameras()}>刷新台账</button>
              </div>
              {obsResult && <p className="note">{obsResult}</p>}
            </section>

            <section>
              <h3>可观测性</h3>
              <div className="coverage-bar">
                <div style={{ width: `${Math.round((snapshot?.metrics.observability ?? 1) * 100)}%` }} />
              </div>
              <div className="kv"><span>覆盖率 · 当前窗口</span><code>{Math.round((snapshot?.metrics.observability ?? 1) * 100)}%</code></div>
              <div className="kv"><span>抓拍 / 盲区累计</span><code>{snapshot?.metrics.captures ?? 0} / {snapshot?.metrics.blindspots ?? 0}</code></div>
              <p className="note">
                覆盖率 = 日志里能找到完整闭环的关键事实占比：开工→完成、设备调用→结果小票、投料→派单决策。
              </p>
            </section>

            <section>
              <h3>机位 · {snapshot?.cameras.length ?? 0}</h3>
              {snapshot?.cameras.length === 0 && <p className="empty">连接后读取机位…</p>}
              {(snapshot?.cameras ?? []).map((cam) => (
                <button key={cam.id} className={'camera-row' + (store.focusCamera === cam.id ? ' focus' : '')} onClick={() => void captureNow(cam.id)}>
                  <div className="camera-row-head">
                    <i className={'rec-dot ' + cam.status} />
                    <b>{cam.label}</b>
                    <span>{cam.status === 'alert' ? '发现盲区' : '录制中'}</span>
                  </div>
                  <small>{cam.focus} · 抓拍 {cam.captures} · 盲区 {cam.blindspots}</small>
                  <small className="cam-note">{cam.lastNote || '尚无记录'}</small>
                </button>
              ))}
            </section>

            <section>
              <h3>最近观测</h3>
              {(snapshot?.observations ?? []).length === 0 && <p className="empty">等下一次抓拍…</p>}
              {(snapshot?.observations ?? []).slice().reverse().map((o) => (
                <div className={'obs-row ' + o.kind} key={o.seq}>
                  <div className="obs-head">
                    <span className={'obs-kind ' + o.kind}>{o.kind === 'blindspot' ? '盲区' : '抓拍'}</span>
                    <b>{o.code === 'clear' ? o.subject : o.code}</b>
                    <small>#{o.seq}</small>
                  </div>
                  <p>{o.note}</p>
                  <small>
                    {o.cameraLabel} · tick {o.tick}
                    {o.evidenceSeqs.length ? ' · 证据 seq ' + o.evidenceSeqs.slice(0, 4).join(',') : ''}
                  </small>
                </div>
              ))}
            </section>

            <section>
              <h3>结构性盲区（修不了的）</h3>
              <p className="note">harness 本身的可观测性缺口，摄像头看得见但补不上，只能如实报告。</p>
              {(cameraList?.structuralBlindspots ?? []).map((b) => (
                <div className="structural-row" key={b.code}>
                  <code>{b.code}</code>
                  <p>{b.note}</p>
                </div>
              ))}
              {!cameraList && <p className="empty">连接后读取…</p>}
            </section>
          </>
        )}

        {tab === 'config' && (
          <section>
            <h3>模型配置 · 进程侧</h3>
            <p className="note">
              配置和 Key 留在 App Server，浏览器只拿到 <code>hasApiKey</code> 布尔值。
              设 <code>MEDUSA_HOME</code> 下的 <code>medusa.toml</code>，Key 用环境变量名引用。
            </p>
            {config ? (
              <>
                <div className="kv"><span>模式</span><code>{config.mode}</code></div>
                <div className="kv"><span>模型</span><code>{config.model || '—'}</code></div>
                <div className="kv"><span>Provider</span><code>{config.modelProvider || '—'}</code></div>
                <div className="kv"><span>已配 Key</span><code>{config.hasApiKey ? '是' : '否（mock）'}</code></div>
                <div className="kv"><span>节拍</span><code>{config.tickMs} ms</code></div>
                <div className="kv"><span>自动演示投料</span><code>{config.autoDemo ? '开' : '关'}</code></div>
                <div className="kv"><span>调用上限</span><code>{config.maxCallsPerMinute}/min</code></div>
                <div className="kv"><span>配置目录</span><code className="path">{configHome}</code></div>
                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button onClick={() => store.updateConfig({ mode: config.mode === 'mock' ? 'live' : 'mock' })}>
                    切到 {config.mode === 'mock' ? 'live' : 'mock'}
                  </button>
                </div>
                <div className="btn-row">
                  <button onClick={() => store.updateConfig({ tickMs: config.tickMs === 420 ? 220 : 420 })}>
                    节拍 {config.tickMs === 420 ? '加快' : '恢复'}
                  </button>
                </div>
              </>
            ) : <p className="empty">连接后读取…</p>}
          </section>
        )}

        {tab === 'protocol' && (
          <section>
            <h3>协议 · Codex App Server 形态</h3>
            <p className="note">
              双向 JSON-RPC 2.0。握手 <code>initialize</code> → <code>initialized</code>；
              服务端可主动发 <code>approval/request</code> 暂停轮次。
            </p>
            <div className="kv"><span>Thread / Turn / Item</span><code>三级原语</code></div>
            <div className="kv"><span>会话日志</span><code>append-only JSONL</code></div>
            <div className="kv"><span>重连</span><code>thread/resume</code></div>
            <div className="kv"><span>分叉</span><code>thread/fork</code></div>
            <div className="kv"><span>线程数</span><code>{threads.length || snapshot?.threads?.length || 0}</code></div>
            <div className="kv"><span>轮次数</span><code>{snapshot?.turns?.length ?? 0}</code></div>
            <div className="kv"><span>Item 数</span><code>{snapshot?.items?.length ?? 0}</code></div>
            <h3 style={{ marginTop: 16 }}>线程列表</h3>
            {(threads.length ? threads : snapshot?.threads ?? []).map((t) => (
              <button key={t.id} className="thread-row" onClick={() => run('thread/resume', { threadId: t.id })}>
                <b>{t.id}</b>
                <small>{t.title} · {t.turnCount} turns · seq {t.headSeq}</small>
              </button>
            ))}
            {config && <p className="empty" style={{ marginTop: 10 }}>{config.userAgent}</p>}
          </section>
        )}
      </aside>

      <aside className="panel right">
        <section>
          <h3>质检台 / 指标</h3>
          <div className="metrics">
            <div className="metric"><span>累计 token</span><b>{snapshot?.metrics.tokens ?? 0}</b></div>
            <div className="metric"><span>成本 (¥)</span><b>{fmt(snapshot?.metrics.cost ?? 0, 4)}</b></div>
            <div className="metric"><span>在岗工人</span><b>{snapshot?.metrics.activeWorkers ?? 0}</b></div>
            <div className="metric"><span>阻塞</span><b>{snapshot?.metrics.blocked ?? 0}</b></div>
            <div className="metric"><span>已完成</span><b>{snapshot?.metrics.completed ?? 0}</b></div>
            <div className="metric"><span>推理轮次</span><b>{snapshot?.metrics.iterations ?? 0}</b></div>
            <div className="metric"><span>判定通过</span><b>{snapshot?.metrics.passed ?? 0}</b></div>
            <div className="metric"><span>判定未过</span><b>{snapshot?.metrics.rejected ?? 0}</b></div>
            <div className="metric"><span>设备</span><b>{tools.length}</b></div>
            <div className="metric"><span>设备调用</span><b>{toolCalls}</b></div>
            <div className="metric"><span>派单</span><b>{snapshot?.metrics.dispatched ?? 0}</b></div>
            <div className="metric"><span>摄像头抓拍</span><b>{snapshot?.metrics.captures ?? 0}</b></div>
            <div className="metric"><span>盲区累计</span><b>{snapshot?.metrics.blindspots ?? 0}</b></div>
            <div className="metric"><span>可观测性</span><b>{Math.round((snapshot?.metrics.observability ?? 1) * 100)}%</b></div>
          </div>
        </section>

        <section className="stream">
          <h3>事件流 · 当前帧往前 8 条</h3>
          {recent.length === 0 && <p className="empty">暂无事件</p>}
          {recent.map((frame, index) => (
            <div className="event-row" key={`${frame.event.seq}-${index}`}>
              <span className="event-seq">#{frame.event.seq}</span>
              <div>
                <b>{eventLabel(frame.event.kind)}</b>
                <small>{eventDetail(frame.event)}</small>
              </div>
            </div>
          ))}
        </section>
      </aside>

      <footer className="timeline">
        <div className="timeline-top">
          <button onClick={() => store.setCursor(cursor - 1)}>◀ 单步</button>
          <button className="primary" onClick={() => store.setPlaying(!playing)}>
            {playing ? '暂停跟随' : '跟随实时'}
          </button>
          <button onClick={() => store.setCursor(cursor + 1)}>单步 ▶</button>
          <button onClick={() => store.setPlaying(true)}>跳到最新</button>
          <span className="spacer" />
          <span className="readout">
            seq {frames[cursor]?.event.seq || '—'} · 速率 ×{speed} · {playing ? '跟随实时流' : '回放中'}
          </span>
        </div>
        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(1, maxCursor)}
          value={cursor}
          onChange={(event) => store.setCursor(Number(event.target.value))}
        />
        <div className="ticks">
          <span>起点</span>
          <span>状态由 append-only 日志投影 · 刷新从最新快照恢复</span>
          <span>最新 · {maxCursor}</span>
        </div>
      </footer>

      {requestOpen && context && (
        <div className="approval-backdrop" onClick={() => setRequestOpen(false)}>
          <div className="request-card" onClick={(event) => event.stopPropagation()}>
            <div className="request-head">
              <div>
                <b>模型请求体 · {context.taskId}</b>
                <small>
                  {realCall
                    ? `日志原文 @seq ${realCall.seq} · 第 ${realCall.iteration} 轮 · ${realCall.messageCount} 条消息`
                    : '当前派生预览 · 该工单还没有请求事实'}
                </small>
              </div>
              <button onClick={() => setRequestOpen(false)}>关闭</button>
            </div>
            <pre className="request-pre">
              {JSON.stringify(
                realCall
                  ? { model: realCall.model, messages: realCall.request, tools: realCall.tools }
                  : context.modelRequest,
                null,
                2,
              )}
            </pre>
            <p className="request-foot">
              {realCall
                ? `这一份是从 append-only 日志里取回的原样请求（seq ${realCall.seq}），不是前端拼的。`
                : '这条工单还没有 model.request 事实：可能还没跑到，或来自旧日志。'}
            </p>
          </div>
        </div>
      )}

      {approval && (
        <div className="approval-backdrop">
          <div className="approval-card">
            <span className="approval-kicker">服务端主动请求 · approval/request</span>
            {approval.request.kind === 'tool' ? (
              <>
                <h2>设备签字 · {approval.request.label || approval.request.toolName}</h2>
                <p>{approval.request.note}</p>
                <pre className="approval-args">
                  {JSON.stringify(approval.request.args ?? {}, null, 2)}
                </pre>
                <p className="approval-meta">
                  工单 {approval.request.taskId || '—'} · 设备 {approval.request.toolName}
                  <br />当前轮次已暂停；25 秒内没签字会自动驳回，并在日志里留痕。
                </p>
                <div className="btn-row">
                  <button className="primary" onClick={() => store.replyApproval('allow')}>签字放行</button>
                  <button className="danger" onClick={() => store.replyApproval('deny')}>驳回</button>
                </div>
              </>
            ) : (
              <>
                <h2>老板在 {approval.request.stage} 抽查到疑点</h2>
                <p>{approval.request.note}</p>
                <p className="approval-meta">
                  工单 {approval.request.taskId || '—'} · 轮次 {approval.request.turnId || '—'}
                  <br />当前轮次已暂停，等待你放行或叫停。
                </p>
                <div className="btn-row">
                  <button className="primary" onClick={() => store.replyApproval('allow')}>放行</button>
                  <button className="danger" onClick={() => store.replyApproval('deny')}>叫停</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <AvatarEditor />
    </div>
  )
}
