'use client'

import { useState } from 'react'
import { selectSnapshot, useMedusaStore } from '@/lib/store'
import { eventDetail, eventLabel } from '@/lib/rpc'

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
    approval, config, threads, activeThread, protocolVersion, configHome,
  } = store
  const [tab, setTab] = useState<'workers' | 'tools' | 'config' | 'protocol'>('workers')
  const [busy, setBusy] = useState(false)
  const [toolResult, setToolResult] = useState<{ blocked: boolean; text: string } | null>(null)

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

  return (
    <div className="overlay">
      <header className="topbar">
        <div className="brand">
          <b>Medusa</b>
          <span>流水线车间 · App Server 驱动</span>
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
          <button className={tab === 'workers' ? 'active' : ''} onClick={() => setTab('workers')}>车间</button>
          <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>设备</button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>配置</button>
          <button className={tab === 'protocol' ? 'active' : ''} onClick={() => setTab('protocol')}>协议</button>
        </div>

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
                <button disabled={busy} onClick={() => run('turn/start', { title: '人工投料工单' })}>投一个工单</button>
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
              <div className="tool-row" key={tool.name}>
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
            <div className="metric"><span>LLM 调用</span><b>{snapshot?.metrics.llmCalls ?? 0}</b></div>
            <div className="metric"><span>设备</span><b>{tools.length}</b></div>
            <div className="metric"><span>设备调用</span><b>{toolCalls}</b></div>
          </div>
        </section>

        <section className="stream">
          <h3>事件流 · 当前帧往前 8 条</h3>
          {recent.length === 0 && <p className="empty">暂无事件</p>}
          {recent.map((frame) => (
            <div className="event-row" key={frame.event.seq}>
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
          <span>状态由 append-only 日志投影，刷新页面可 thread/resume 重建</span>
          <span>最新 · {maxCursor}</span>
        </div>
      </footer>

      {approval && (
        <div className="approval-backdrop">
          <div className="approval-card">
            <span className="approval-kicker">服务端主动请求 · approval/request</span>
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
          </div>
        </div>
      )}
    </div>
  )
}
