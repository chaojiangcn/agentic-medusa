'use client'

/**
 * A floating inspector opened by clicking a character in the 3D scene.
 * Appearance is a local projection preference: none of this goes to the
 * App Server or into the append-only log.
 */

import { useState } from 'react'
import { useMedusaStore } from '@/lib/store'
import {
  AVATAR_COLORS, AVATAR_MODELS, BOSS_KEY,
  resolveAvatar, workerKey,
} from '@/lib/appearance'
import type { AvatarConfig } from '@/lib/appearance'

function Glyph({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 32 40" width="30" height="36" aria-hidden="true">
      {id === 'human' && (
        <>
          <circle cx="16" cy="7.5" r="5.6" fill="currentColor" opacity="0.9" />
          <path d="M8.6 15.4c0-1.7 3.3-2.9 7.4-2.9s7.4 1.2 7.4 2.9l1 9.4c.1 1.3-1 2.2-2.3 2.2h-1.4l-.8 10.3h-3l-.7-8h-.2l-.7 8h-3l-.8-10.3H10.1c-1.3 0-2.4-.9-2.3-2.2z" fill="currentColor" opacity="0.55" />
          <path d="M7.4 16.2 5.6 24a1.6 1.6 0 0 0 3.1.8l1.6-7.2z" fill="currentColor" opacity="0.4" />
          <path d="M24.6 16.2 26.4 24a1.6 1.6 0 0 1-3.1.8l-1.6-7.2z" fill="currentColor" opacity="0.4" />
          <rect x="14.6" y="15.2" width="2.8" height="7.4" rx="1" fill="#fff" opacity="0.85" />
        </>
      )}
      {id === 'office' && (
        <>
          <circle cx="16" cy="9" r="6" fill="currentColor" opacity="0.85" />
          <path d="M8 17h16l1.5 16h-19z" fill="currentColor" opacity="0.5" />
          <rect x="14.5" y="17" width="3" height="11" fill="#fff" opacity="0.9" />
        </>
      )}
      {id === 'blocky' && (
        <>
          <rect x="9" y="3" width="14" height="13" rx="1" fill="currentColor" opacity="0.85" />
          <rect x="8" y="17" width="16" height="15" fill="currentColor" opacity="0.5" />
          <rect x="10" y="33" width="5" height="6" fill="currentColor" opacity="0.65" />
          <rect x="17" y="33" width="5" height="6" fill="currentColor" opacity="0.65" />
        </>
      )}
      {id === 'robot' && (
        <>
          <rect x="14.5" y="0" width="3" height="5" fill="currentColor" opacity="0.7" />
          <circle cx="16" cy="1" r="2" fill="currentColor" />
          <rect x="7" y="5" width="18" height="13" rx="2" fill="currentColor" opacity="0.85" />
          <circle cx="12" cy="11" r="1.6" fill="#fff" />
          <circle cx="20" cy="11" r="1.6" fill="#fff" />
          <rect x="8" y="19" width="16" height="14" rx="2" fill="currentColor" opacity="0.5" />
        </>
      )}
      {id === 'capsule' && (
        <>
          <rect x="9" y="9" width="14" height="24" rx="7" fill="currentColor" opacity="0.6" />
          <circle cx="16" cy="8" r="6.5" fill="currentColor" opacity="0.85" />
        </>
      )}
      {id === 'glb' && (
        <>
          <path d="M16 3 29 10v14L16 31 3 24V10z" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.75" />
          <path d="M3 10l13 7 13-7M16 17v14" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.55" />
        </>
      )}
    </svg>
  )
}

export function AvatarEditor() {
  const target = useMedusaStore((state) => state.avatarEditor)
  const appearance = useMedusaStore((state) => state.appearance)
  const setAvatar = useMedusaStore((state) => state.setAvatar)
  const applyAvatarToAll = useMedusaStore((state) => state.applyAvatarToAll)
  const resetAppearance = useMedusaStore((state) => state.resetAppearance)
  const closeAvatarEditor = useMedusaStore((state) => state.closeAvatarEditor)
  const [glb, setGlb] = useState('')

  if (!target) return null

  const key = target.kind === 'boss' ? BOSS_KEY : workerKey(target.id ?? '')
  const cfg = resolveAvatar(appearance, key, '#7b84d2')
  const patch = (value: Partial<AvatarConfig>) => setAvatar(key, value)
  const isGlb = cfg.model.startsWith('glb:')
  const activeModel = isGlb ? 'glb' : cfg.model

  return (
    <div className="avatar-card" onClick={(event) => event.stopPropagation()}>
      <div className="avatar-head">
        <div>
          <span className="avatar-kicker">3D 外观 · 只存在这台浏览器</span>
          <h2>设置 · {target.name}</h2>
          <small>当前状态 {target.status} · 点场景空白处或「完成」关闭</small>
        </div>
        <button className="avatar-x" onClick={closeAvatarEditor}>×</button>
      </div>

      <div className="avatar-section">
        <label>人物模型</label>
        <div className="avatar-models">
          {AVATAR_MODELS.map((model) => (
            <button
              key={model.id}
              className={'avatar-model' + (activeModel === model.id ? ' on' : '')}
              onClick={() => patch({ model: model.id })}
            >
              <Glyph id={model.id} />
              <b>{model.name}</b>
              <small>{model.desc}</small>
            </button>
          ))}
          <button
            className={'avatar-model' + (isGlb ? ' on' : '')}
            onClick={() => { if (glb.trim()) patch({ model: 'glb:' + glb.trim() }) }}
          >
            <Glyph id="glb" />
            <b>外部 GLB</b>
            <small>载入自己的模型</small>
          </button>
        </div>
        <div className="avatar-glb">
          <input
            value={isGlb ? cfg.model.slice(4) : glb}
            onChange={(event) => setGlb(event.target.value)}
            placeholder="/models/worker.glb"
          />
          <button onClick={() => { const v = glb.trim(); if (v) patch({ model: 'glb:' + v }) }}>加载</button>
        </div>
        <p className="avatar-hint">
          把 <code>.glb</code> 放进 <code>public/models/</code> 再填文件名；加载失败会自动退回胶囊形象。
        </p>
      </div>

      <div className="avatar-section">
        <label>主色 {cfg.color === null && <em>· 跟随状态</em>}</label>
        <div className="avatar-swatches">
          <button className={'avatar-follow' + (cfg.color === null ? ' on' : '')} onClick={() => patch({ color: null })}>
            自动
          </button>
          {AVATAR_COLORS.map((color) => (
            <button
              key={color}
              className={'avatar-swatch' + (cfg.color === color ? ' on' : '')}
              style={{ background: color }}
              title={color}
              onClick={() => patch({ color })}
            />
          ))}
        </div>
      </div>

      <div className="avatar-section">
        <label>名牌文字</label>
        <input
          className="avatar-input"
          value={cfg.label ?? ''}
          placeholder={`默认：${target.name}`}
          onChange={(event) => patch({ label: event.target.value || null })}
        />
      </div>

      <div className="avatar-section">
        <label>体型 <code>{cfg.scale.toFixed(2)}×</code></label>
        <input
          className="avatar-range"
          type="range"
          min="0.8"
          max="1.4"
          step="0.05"
          value={cfg.scale}
          onChange={(event) => patch({ scale: Number(event.target.value) })}
        />
      </div>

      <div className="avatar-actions">
        <button onClick={() => applyAvatarToAll({
          model: cfg.model, color: cfg.color, label: null, scale: cfg.scale,
        })}>应用到全体</button>
        <button onClick={resetAppearance}>恢复默认</button>
        <button className="primary" onClick={closeAvatarEditor}>完成</button>
      </div>
      <p className="avatar-foot">直接点场景里另一个人，就能接着改他的外观。</p>
    </div>
  )
}
