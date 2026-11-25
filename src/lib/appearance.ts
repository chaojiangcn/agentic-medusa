/**
 * Appearance is UI-local, not a workshop fact. The App Server owns the log;
 * how a worker *looks* is a projection preference, so it lives in the browser
 * and never crosses JSON-RPC.
 */

export interface AvatarConfig {
  /** One of AVATAR_MODELS, or a `glb:` path under /public/models. */
  model: string
  /** null = follow the worker's live status colour. */
  color: string | null
  /** null = use the worker's name from the snapshot. */
  label: string | null
  scale: number
}

export const AVATAR_MODELS = [
  { id: 'office', name: '工服人偶', desc: '衬衫 · 领带 · 工牌' },
  { id: 'blocky', name: '方块小人', desc: '低模方块造型' },
  { id: 'robot', name: '机器人', desc: '屏幕脸 · 发光关节' },
  { id: 'capsule', name: '简约胶囊', desc: '最轻量的默认形象' },
] as const

export const AVATAR_COLORS = [
  '#7b84d2', '#5f9380', '#c98a4c', '#c0625d',
  '#5a7fa8', '#8d6bb0', '#4a4a68', '#9aa6b4',
]

export const DEFAULT_AVATAR: AvatarConfig = {
  model: 'office',
  color: null,
  label: null,
  scale: 1,
}

export const APPEARANCE_STORAGE_KEY = 'medusa.appearance.v1'
export const ALL_KEY = 'all'
export const BOSS_KEY = 'boss'

export const workerKey = (id: string) => `worker:${id}`

export interface AvatarTarget {
  kind: 'boss' | 'worker'
  id?: string
  name: string
  status: string
}

/** Per-target override wins, then the "apply to all" value, then default. */
export function resolveAvatar(
  appearance: Record<string, Partial<AvatarConfig>>,
  key: string,
  statusColor: string,
): AvatarConfig & { effectiveColor: string } {
  const own = appearance[key]
  const global = appearance[ALL_KEY]
  const merged: AvatarConfig = {
    ...DEFAULT_AVATAR,
    ...(global ?? {}),
    ...(own ?? {}),
  }
  return {
    ...merged,
    model: String(merged.model || DEFAULT_AVATAR.model),
    scale: Number(merged.scale) || 1,
    effectiveColor: merged.color ?? statusColor,
  }
}

export function isGlbModel(model: string): boolean {
  return model.startsWith('glb:') && model.length > 4
}

export function glbUrl(model: string): string {
  const name = model.slice(4).replace(/^\/+/, '')
  return name.startsWith('/models/') ? name : `/models/${name}`
}
