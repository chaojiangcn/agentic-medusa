'use client'

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows, Environment, Html, Lightformer, OrbitControls, RoundedBox,
} from '@react-three/drei'
import { Bloom, EffectComposer, N8AO, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { CAMERA_PRESETS, selectSnapshot, useMedusaStore } from '@/lib/store'
import type { CameraPreset } from '@/lib/store'
import { BOSS_KEY, resolveAvatar, workerKey } from '@/lib/appearance'
import { Avatar, SEATED_Y } from './Avatar'
import type { HumanMotion } from './Avatar'
import {
  Bust, Credenza, DESK_D, DESK_H, Desk, DeskKit, Easel, Plant, RoomShell, ShelfUnit,
  TaskChair, WallArt, WallClock, BoxStack,
} from './OfficeSet'
import type { Boss, CameraView, DispatchRecord, Stage, ToolView, Worker, WorkTask } from '@/lib/contract'

// Deliberately muted: the backend colours are chart accents, not paint.
const STATUS_COLOR: Record<string, string> = {
  busy: '#8b95e0',
  idle: '#a6b2c0',
  blocked: '#d4746f',
  paused: '#c9a05e',
}

function soften(hex: string, saturation = 0.36, lightness = 0.72): string {
  const c = new THREE.Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  c.setHSL(hsl.h, saturation, lightness)
  return `#${c.getHexString()}`
}

/// Stages arrive on a 10-unit span, which forces the camera so far back that a
/// 1.3 m character ends up 50 px tall. The client projects them into a studio
/// plan instead: three desks at three depths, each slightly off-axis. A rigid
/// row reads as a spreadsheet; a staggered cluster reads as a room.
const STAGE_LAYOUT = [
  { x: -2.32, z: -0.72, rot: -0.27 },
  { x: 0.12, z: 0.46, rot: 0.035 },
  { x: 2.4, z: -0.5, rot: 0.4 },
]

/// Where a worker sits, in the desk's local frame.
const SEAT_Z = -0.9

function seatAnchor(stage: Stage, index: number, offsetX: number) {
  const tilt = STAGE_LAYOUT[index]?.rot ?? 0
  const cos = Math.cos(tilt)
  const sin = Math.sin(tilt)
  return {
    x: stage.position.x + offsetX * cos + SEAT_Z * sin,
    z: stage.position.z - offsetX * sin + SEAT_Z * cos,
    rot: tilt,
  }
}

/** A white desk with a real top, a drawer pedestal and a task chair behind
    it. The nameplate moved from a floating sign to the front edge. */
function WorkStation({
  stage, index, devices, highlighted,
}: {
  stage: Stage
  index: number
  devices: { tool: ToolView; recent: boolean }[]
  highlighted: boolean
}) {
  const accent = useMemo(() => soften(stage.color), [stage.color])
  const pool = useMemo(() => soften(stage.color, 0.4, 0.86), [stage.color])
  const [hovered, setHovered] = useState(false)
  const requestTab = useMedusaStore((state) => state.requestTab)
  const tilt = STAGE_LAYOUT[index]?.rot ?? 0
  return (
    <group position={[stage.position.x, 0, stage.position.z]} rotation={[0, tilt, 0]}>
      {/* a barely-there pool of accent light on the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.007, 0]} raycast={() => {}}>
        <circleGeometry args={[1.55, 40]} />
        <meshBasicMaterial
          color={pool}
          transparent
          opacity={hovered ? 0.32 : highlighted ? 0.26 : 0.1}
          depthWrite={false}
        />
      </mesh>
      <Desk accent={accent} />
      <DeskKit accent={accent} />
      <TaskChair x={0} z={-0.9} rotation={0.05} accent={highlighted ? accent : '#e7ebf1'} />
      {devices.map(({ tool, recent }, i) => (
        <ToolDevice key={tool.name} tool={tool} x={0.52 + i * 0.28} recent={recent} />
      ))}
      <Html center zIndexRange={[5, 0]} position={[0, 0.46, DESK_D / 2 + 0.02]}>
        <div
          className="stage-tag"
          style={{ '--tag-accent': accent } as CSSProperties}
          onClick={() => requestTab('workers')}
        >
          {stage.name}
        </div>
      </Html>
    </group>
  )
}

function WorkerFigure({
  worker,
  anchor,
  selected,
  tint,
  labelLift = 0,
  stageIndex,
  handoff,
}: {
  worker: Worker
  anchor: { x: number; z: number; rot: number }
  selected: boolean
  tint: string
  labelLift?: number
  stageIndex: number
  handoff: { current: HandoffState | null }
}) {
  const group = useRef<THREE.Group>(null)
  const halo = useRef<THREE.Mesh>(null)
  // The rig reads this every frame. While seated, "speed" stays at zero and
  // the typing / hand-off channels drive the forearms instead.
  const motion = useRef<HumanMotion>({ speed: 0, typing: 0, handoff: 0 })
  const [hovered, setHovered] = useState(false)
  const appearance = useMedusaStore((state) => state.appearance)
  const openAvatarEditor = useMedusaStore((state) => state.openAvatarEditor)
  const selectWorker = useMedusaStore((state) => state.selectWorker)
  const editorTarget = useMedusaStore((state) => state.avatarEditor)
  const isEditing = editorTarget?.kind === 'worker' && editorTarget.id === worker.id
  const statusColor = STATUS_COLOR[worker.status] ?? STATUS_COLOR.busy
  const avatar = resolveAvatar(appearance, workerKey(worker.id), tint)
  const color = avatar.effectiveColor
  // Only the built-in human has a seated rig; every other silhouette stands
  // behind the desk on the floor, which still reads correctly for a chibi.
  const seated = avatar.model === 'human'
  const baseY = seated ? SEATED_Y : 0.645

  useFrame(({ clock }) => {
    if (!group.current) return
    const t = clock.getElapsedTime()
    const bob = worker.status === 'busy' ? 0.007 : 0.003
    group.current.position.y = baseY + Math.sin(t * 1.6 + worker.id.length) * bob
    group.current.rotation.y = anchor.rot + Math.sin(t * 0.45 + worker.id.length) * 0.045
    motion.current.typing = worker.status === 'busy' ? 1 : 0.15
    // A hand-off is a per-frame read of the shared bus, not React state. The
    // source station pushes (+1), the destination reaches out a beat later
    // (-1); both fade back to zero when the crate lands.
    const h = handoff.current
    if (h) {
      const u = (clock.elapsedTime - h.t0) / h.duration
      const pushEnv = u >= 0 && u <= 1 ? Math.sin(Math.PI * u) : 0
      const ru = (u - 0.2) / 0.8
      const receiveEnv = ru >= 0 && ru <= 1 ? Math.sin(Math.PI * ru) : 0
      motion.current.handoff =
        (stageIndex === h.fromStage ? pushEnv : 0) -
        (stageIndex === h.toStage ? receiveEnv : 0)
    } else {
      motion.current.handoff = 0
    }
    if (halo.current) {
      const m = halo.current.material as THREE.MeshBasicMaterial
      m.opacity = isEditing
        ? 0.42 + Math.sin(t * 2.4) * 0.08
        : selected ? 0.3 + Math.sin(t * 2.4) * 0.1 : hovered ? 0.2 : 0
    }
  })

  return (
    <group
      ref={group}
      name={`worker-${worker.id}`}
      position={[anchor.x, baseY, anchor.z]}
      onClick={(event) => {
        event.stopPropagation()
        selectWorker(worker.id)
        openAvatarEditor({ kind: 'worker', id: worker.id, name: worker.name, status: worker.status })
      }}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = 'auto'
      }}
    >
      {/* Invisible hit volume: a humanoid has gaps between its limbs, and a
          click should not disappear into them. */}
      <mesh position={[0, seated ? 0.54 : 0.5, 0]}>
        <capsuleGeometry args={[0.42, seated ? 0.5 : 0.68, 4, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Avatar
        model={avatar.model}
        color={color}
        scale={avatar.scale}
        pose={seated ? 'sit' : 'stand'}
        motionRef={motion}
      />
      <mesh
        ref={halo}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, seated ? -0.505 : -0.638, 0]}
        raycast={() => {}}
      >
        <ringGeometry args={[0.44, 0.66, 40]} />
        <meshBasicMaterial color={statusColor} transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Html center zIndexRange={[30, 20]} position={[0, (seated ? 0.92 : 1.02) + labelLift, 0]}>
        <div
          className="worker-tag"
          onClick={() => {
            selectWorker(worker.id)
            openAvatarEditor({ kind: 'worker', id: worker.id, name: worker.name, status: worker.status })
          }}
        >
          <i className="tag-dot" style={{ background: color }} />
          {avatar.label || worker.name} · {worker.status}
        </div>
      </Html>
    </group>
  )
}

/** One in-flight hand-off, shared by the crates and the seated rigs. A crate
    publishes it when its order crosses a station boundary; the workers read
    it every frame. No React state is involved, so a stage change never
    re-renders (and never unmounts) the scene. */
interface HandoffState {
  fromStage: number
  toStage: number
  t0: number
  duration: number
  taskId: string
}
// 0.95s read as a flicker on the wide shot and left the seated rigs no time
// to sell the push/catch. 1.3s is slow enough to follow, short enough not to
// stall the line.
const HANDOFF_SECONDS = 1.3

/** Watches the order list itself, not the crate slots. Slot indices shift
    whenever the log grows, so a crate component cannot reliably remember
    which station an order was at. Keying on task.id makes the hand-off
    immune to that shift. */
function HandoffWatcher({
  tasks, stages, handoff,
}: {
  tasks: WorkTask[]
  stages: Stage[]
  handoff: { current: HandoffState | null }
}) {
  const memory = useRef<Map<string, number>>(new Map())
  useFrame(({ clock }) => {
    const now = clock.elapsedTime
    // Retire a finished hand-off so crates and rigs never replay it.
    const active = handoff.current
    if (active && now - active.t0 > HANDOFF_SECONDS + 0.08) handoff.current = null
    const recent = tasks.slice(-24)
    const alive = new Set<string>()
    for (const task of recent) {
      alive.add(task.id)
      const last = memory.current.get(task.id)
      // An order often crosses its last station and completes in the SAME
      // frame, so filtering out finished tasks would swallow the final
      // hand-off entirely. Memory is updated every frame, so a done order
      // publishes exactly once and then stays quiet.
      if (last !== undefined && last !== task.stageIndex) {
        handoff.current = {
          fromStage: Math.min(last, stages.length - 1),
          toStage: Math.min(task.stageIndex, stages.length - 1),
          t0: now,
          duration: HANDOFF_SECONDS,
          taskId: task.id,
        }
      }
      memory.current.set(task.id, task.stageIndex)
    }
    for (const id of memory.current.keys()) {
      if (!alive.has(id)) memory.current.delete(id)
    }
  })
  return null
}

function TaskCrate({
  task, offset, stages, handoff,
}: {
  task: WorkTask | null
  offset: number
  stages: Stage[]
  handoff: { current: HandoffState | null }
}) {
  const group = useRef<THREE.Group>(null)
  const goal = useMemo(() => new THREE.Vector3(), [])
  const flight = useRef<{
    from: THREE.Vector3
    to: THREE.Vector3
    t0: number
  } | null>(null)
  // A delivered crate lingers briefly after landing; vanishing on the exact
  // frame the order completes made the hand-off look like a glitch.
  const landedAt = useRef(0)
  const done = !task || task.status === 'done' || task.status === 'failed'
  const slot = Math.min(task?.stageIndex ?? 0, stages.length - 1)
  const stage = stages[slot]
  // There is no conveyor any more. Crates rest on a shared line in the open
  // floor in front of the desks (rather than tucked behind a desk where the
  // furniture hides them), and fly across in an arc when the order moves to
  // the next station. Keeping z fixed makes the hand-off travel mostly along
  // x, so the arc reads clearly from the wide shot.
  // Pull the shared crate line toward the centre of the visible 3D viewport.
  // The side panels cover the far left/right of the canvas, so a crate that
  // tracked the full stage x (2.4) landed behind the right metrics panel.
  goal.set(
    (stage?.position.x ?? 0) * 0.62 + offset * 0.3,
    0,
    1.15 + Math.abs(offset) * 0.18,
  )
  // The transform belongs to the frame loop. Passing position/rotation as
  // props made React snap the crate back to its spawn on every
  // snapshot-driven re-render, which fought the arc and made the crate appear
  // to flicker in and out of the room.
  useLayoutEffect(() => {
    if (!group.current) return
    group.current.position.set(goal.x, 0, goal.z)
    group.current.rotation.y = offset * 0.9
    // Visibility is owned by useFrame from the next frame on. Leaving a
    // `visible` prop in JSX let React switch the crate off on every
    // snapshot-driven re-render, which raced the frame loop and made the
    // crate disappear for most of its flight.
    group.current.visible = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useFrame(({ clock }) => {
    if (!group.current) return
    const now = clock.elapsedTime
    // The watcher publishes hand-offs keyed by task.id, so a crate can pick
    // up its own arc even when the log grew and shifted its slot index.
    const h = handoff.current
    if (task && h && h.taskId === task.id && !flight.current
        && now - h.t0 < HANDOFF_SECONDS * 0.6) {
      flight.current = {
        from: group.current.position.clone(),
        to: goal.clone(),
        t0: h.t0,
      }
    }

    // A crate in flight stays visible even if the station just changed hands,
    // and a delivered crate lingers for a moment so the landing reads.
    group.current.visible =
      !done || !!flight.current || (landedAt.current > 0 && now - landedAt.current < 1)
    const f = flight.current
    if (!f) {
      group.current.position.lerp(goal, 0.055)
      group.current.rotation.x = 0
      group.current.rotation.z = 0
      group.current.scale.setScalar(1)
      return
    }
    const t = Math.min(1, (now - f.t0) / HANDOFF_SECONDS)
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    group.current.position.lerpVectors(f.from, f.to, e)
    group.current.position.y =
      // Clear the desk line (0.55) at the apex. A 0.52 arc flew exactly at
      // desktop height, so the crate spent the whole hand-off hidden behind
      // the furniture and looked like it never moved.
      Math.sin(Math.PI * t) * 0.78 +
      (t > 0.8
        ? Math.abs(Math.sin(((t - 0.8) / 0.2) * Math.PI * 2)) * 0.055 * (1 - t) / 0.2
        : 0)
    group.current.rotation.z = Math.sin(t * Math.PI) * 0.13
    group.current.rotation.x = Math.sin(t * Math.PI * 1.35) * 0.075
    // A small pulse makes the lift read even when the crate is only a few
    // pixels wide on the wide shot; it settles back to 1 on landing.
    group.current.scale.setScalar(1 + Math.sin(Math.PI * t) * 0.12)
    if (t >= 1) {
      group.current.position.copy(f.to)
      group.current.rotation.x = 0
      group.current.rotation.z = 0
      group.current.scale.setScalar(1)
      flight.current = null
      landedAt.current = now
    }
  })
  const failed = task?.status === 'failed'
  // A mid-tone slate reads against the white studio floor; near-white crates
  // vanished into it. The strap below adds the contrast edge.
  const color = failed ? '#cf6f6b' : '#8fa4bf'
  return (
    <group
      ref={group}
      name={task ? `crate-${task.id}` : 'crate-empty'}
    >
      <RoundedBox args={[0.4, 0.32, 0.4]} radius={0.05} smoothness={3} position={[0, 0.16, 0]} castShadow>
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.05} />
      </RoundedBox>
      <mesh position={[0, 0.325, 0]}>
        <boxGeometry args={[0.26, 0.01, 0.02]} />
        <meshStandardMaterial color={failed ? '#f0c9c6' : '#8fa0b3'} roughness={0.5} />
      </mesh>
      {/* Packing strap. A white crate on a white floor is invisible from the
          wide shot, and an invisible crate makes the hand-off look broken. */}
      <mesh position={[0, 0.16, 0]} castShadow>
        <boxGeometry args={[0.41, 0.07, 0.41]} />
        <meshStandardMaterial color={failed ? '#c97873' : '#3a4759'} roughness={0.52} metalness={0.12} />
      </mesh>
      <Html center zIndexRange={[5, 0]} position={[0, 0.44, 0]}>
        <div className="task-tag" style={{ opacity: done ? 0 : 1 }}>{task?.id ?? ''}</div>
      </Html>
    </group>
  )
}

function BossFigure({ boss }: { boss: Boss }) {
  const group = useRef<THREE.Group>(null)
  const motion = useRef<HumanMotion>({ speed: 0, typing: 0, handoff: 0 })
  const aisleX = boss.x < 0 ? -1.02 : 1.32
  const targetX = useRef(aisleX)
  targetX.current = boss.x < 0 ? -1.02 : 1.32
  const targetZ = useRef(-2.62 + boss.z * 0.02)
  targetZ.current = -2.62 + boss.z * 0.02
  // The group's position must NOT be bound to the aisle prop. If React writes
  // the new aisle into `position` on the frame the backend flips sides, the
  // figure teleports and there is no displacement left to animate. Spawn once,
  // then let the frame loop walk it across.
  const spawn = useRef<[number, number, number] | null>(null)
  if (!spawn.current) spawn.current = [aisleX, 0.645, -2.62 + boss.z * 0.02]
  const [hovered, setHovered] = useState(false)
  const appearance = useMedusaStore((state) => state.appearance)
  const openAvatarEditor = useMedusaStore((state) => state.openAvatarEditor)
  const editorTarget = useMedusaStore((state) => state.avatarEditor)
  const isEditing = editorTarget?.kind === 'boss'
  const modeColor = boss.mode === 'intervene'
    ? '#b8615c'
    : boss.mode === 'inspect'
      ? '#b58a4c'
      : boss.mode === 'dispatch'
        ? '#5f9380'
        : '#6e6e92'
  const avatar = resolveAvatar(appearance, BOSS_KEY, modeColor)
  const color = avatar.effectiveColor

  useFrame((_, delta) => {
    if (!group.current) return
    const before = group.current.position.x
    group.current.position.x += (targetX.current - group.current.position.x) * 0.028
    // Walk cycle is driven by real displacement, not by a timer: the feet only
    // move while the body is actually travelling, and they stop on arrival.
    const v = (group.current.position.x - before) / Math.max(delta, 1 / 120)
    motion.current.speed = THREE.MathUtils.damp(
      motion.current.speed,
      Math.min(1, Math.abs(v) / 1.1),
      6,
      delta,
    )
    const facing = Math.abs(v) > 0.12 ? (v > 0 ? Math.PI / 2 : -Math.PI / 2) : 0
    group.current.rotation.y = THREE.MathUtils.damp(group.current.rotation.y, facing, 4, delta)
    group.current.position.z = THREE.MathUtils.damp(
      group.current.position.z,
      targetZ.current,
      3,
      delta,
    )
  })

  return (
    <group
      ref={group}
      name="boss-figure"
      position={spawn.current}
      onClick={(event) => {
        event.stopPropagation()
        openAvatarEditor({ kind: 'boss', name: '老板', status: boss.mode })
      }}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = 'auto'
      }}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.638, 0]} raycast={() => {}}>
        <circleGeometry args={[0.7, 40]} />
        <meshBasicMaterial color={color} transparent opacity={hovered || isEditing ? 0.26 : 0.12} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.55, 0]}>
        <capsuleGeometry args={[0.45, 0.66, 4, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Avatar model={avatar.model} color={color} boss scale={avatar.scale * 1.05} motionRef={motion} />
      <Html center zIndexRange={[32, 22]} position={[0, 1.06, 0]}>
        <div
          className={`boss-tag ${boss.mode}`}
          onClick={() => openAvatarEditor({ kind: 'boss', name: '老板', status: boss.mode })}
        >{avatar.label || '老板'} · {boss.note || boss.mode}</div>
      </Html>
    </group>
  )
}

/** A small white device on the desk. The tool lives on the worker's desk
    instead of on a plinth, so the scene reads as a workstation. */
function ToolDevice({ tool, x, recent }: { tool: ToolView; x: number; recent: boolean }) {
  const [hovered, setHovered] = useState(false)
  const focusOnTool = useMedusaStore((state) => state.focusOnTool)
  const requestTab = useMedusaStore((state) => state.requestTab)
  const color = recent ? '#5f9380' : tool.permission === 'approval' ? '#b58a4c' : '#9aa5b1'
  const showReceipt = recent && Boolean(tool.lastReceipt)
  const receipt = tool.lastReceipt.length > 12 ? tool.lastReceipt.slice(0, 11) + '…' : tool.lastReceipt
  return (
    <group
      position={[x, DESK_H, -0.28]}
      onClick={(event) => {
        event.stopPropagation()
        focusOnTool(tool.name)
        requestTab('tools')
      }}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = 'auto'
      }}
    >
      <mesh position={[0, 0.1, 0]}>
        <boxGeometry args={[0.3, 0.36, 0.28]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <RoundedBox args={[0.25, 0.17, 0.21]} radius={0.026} smoothness={3} position={[0, 0.09, 0]} castShadow>
        <meshStandardMaterial color="#fdfdfe" roughness={0.42} metalness={0.06} />
      </RoundedBox>
      <mesh position={[0, 0.092, 0.106]}>
        <planeGeometry args={[0.18, 0.11]} />
        <meshStandardMaterial
          color={recent ? '#e2f4ec' : '#f2f7fd'}
          emissive={recent ? '#8fd9bd' : '#000000'}
          emissiveIntensity={recent ? 0.45 : 0}
          roughness={0.28}
        />
      </mesh>
      <mesh position={[0, 0.128, 0.108]}>
        <boxGeometry args={[0.1, 0.008, 0.002]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} />
      </mesh>
      <mesh position={[0.09, 0.152, 0.045]}>
        <sphereGeometry args={[0.016, 10, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={recent ? 1.4 : 0.35} roughness={0.3} />
      </mesh>
      <Html center zIndexRange={[5, 0]} position={[0, 0.52, 0]}>
        <div className="tool-receipt" style={{ opacity: showReceipt ? 1 : 0 }}>
          {showReceipt ? receipt : ''}
        </div>
      </Html>
      <Html center zIndexRange={[5, 0]} position={[0, 0.3, 0]}>
        <div
          className={'tool-tag' + (recent ? ' active' : '') + (hovered ? ' hover' : '')}
          onClick={() => { focusOnTool(tool.name); requestTab('tools') }}
        >{tool.label}</div>
      </Html>
    </group>
  )
}

/** Wall-mounted dispatch board. A dark slab would be the only black object in
    an otherwise white room, so the screen is pale and the frame is white. */
function DispatchBoard({ record }: { record?: DispatchRecord }) {
  const requestTab = useMedusaStore((state) => state.requestTab)
  return (
    <group position={[0, 0, -7.62]}>
      <RoundedBox args={[3.3, 1.5, 0.1]} radius={0.035} smoothness={3} position={[0, 2.42, 0]} castShadow>
        <meshStandardMaterial color="#fbfcfe" roughness={0.4} metalness={0.12} />
      </RoundedBox>
      <mesh position={[0, 2.42, 0.056]}>
        <planeGeometry args={[3.1, 1.3]} />
        <meshStandardMaterial color="#eef5fd" emissive="#dceafb" emissiveIntensity={0.45} roughness={0.24} />
      </mesh>
      <mesh position={[0, 2.42, 0.062]}>
        <boxGeometry args={[3.12, 0.012, 0.004]} />
        <meshBasicMaterial color="#7f9fc0" transparent opacity={0.5} />
      </mesh>
      <Html center zIndexRange={[5, 0]} position={[0, 2.42, 0.09]}>
        <div className="dispatch-board" onClick={() => requestTab('dispatch')}>
          <span>派单台 / DISPATCH</span>
          <b>{record ? `${record.taskId} → ${record.stageId}` : '待命中'}</b>
          <small>{record ? `${record.workerName} · ${record.score.toFixed(2)}` : '等待新工单'}</small>
        </div>
      </Html>
    </group>
  )
}

/** Observation camera on a studio light stand. Three fixed viewpoints, shown
    at the scale of the room rather than the raw backend coordinates (which
    put them 4.5 m up and 7.8 m out, i.e. outside the frame). */
function CameraRig({ camera }: { camera: CameraView }) {
  const [hovered, setHovered] = useState(false)
  const focusOnCamera = useMedusaStore((state) => state.focusOnCamera)
  const requestTab = useMedusaStore((state) => state.requestTab)
  const x = camera.position.x * 0.45
  const z = -3.2 - (camera.position.z + 1.2) * 0.16
  const alert = camera.status === 'alert'
  const color = alert ? '#c0625d' : '#dfe5ec'
  const tilt: [number, number, number] = x < -1 ? [0.2, 0, 0.32] : x > 1 ? [0.2, 0, -0.32] : [0.32, 0, 0]
  return (
    <group
      position={[x, 0, z]}
      onClick={(event) => {
        event.stopPropagation()
        focusOnCamera(camera.id)
        requestTab('observe')
      }}
      onPointerOver={(event) => {
        event.stopPropagation()
        setHovered(true)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = 'auto'
      }}
    >
      <mesh position={[0, 1.1, 0]}>
        <boxGeometry args={[0.5, 2.3, 0.5]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.19, 0.04, 20]} />
        <meshStandardMaterial color="#4a515c" roughness={0.5} metalness={0.3} />
      </mesh>
      <mesh position={[0, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.016, 0.022, 2.1, 10]} />
        <meshStandardMaterial color="#3d444f" metalness={0.55} roughness={0.32} />
      </mesh>
      <group position={[0, 2.12, 0]} rotation={tilt}>
        <RoundedBox args={[0.26, 0.19, 0.34]} radius={0.04} smoothness={3} castShadow>
          <meshStandardMaterial color="#fdfdfe" roughness={0.4} metalness={0.1} />
        </RoundedBox>
        <mesh position={[0, -0.02, 0.16]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.05, 0.062, 0.08, 16]} />
          <meshStandardMaterial color="#7d8794" roughness={0.4} metalness={0.3} />
        </mesh>
        <mesh position={[0, -0.02, 0.205]} rotation={[Math.PI / 2, 0, 0]}>
          <sphereGeometry args={[0.042, 16, 12]} />
          <meshStandardMaterial color={alert ? '#f0c9c6' : '#dbe7f6'} roughness={0.2} metalness={0.2} />
        </mesh>
        <mesh position={[0.1, 0.085, 0.06]}>
          <sphereGeometry args={[0.016, 10, 8]} />
          <meshStandardMaterial color="#ff7b6f" emissive="#ff3524" emissiveIntensity={alert ? 2.4 : 1.3} />
        </mesh>
        {/* A soft glow so the REC lamp survives the white studio light. */}
        <mesh position={[0.1, 0.085, 0.06]}>
          <sphereGeometry args={[0.034, 12, 10]} />
          <meshBasicMaterial color="#ff6a5c" transparent opacity={alert ? 0.32 : 0.18} depthWrite={false} />
        </mesh>
      </group>
      {/* A translucent cone: what this viewpoint can see. It is a hint, not
          a real frustum — the actual record is the append-only log. */}
      <mesh position={[0, 0.55, 0]} rotation={[tilt[0] * 0.4, 0, tilt[2] * 0.4]} raycast={() => {}}>
        <coneGeometry args={[1.5, 3.1, 24, 1, true]} />
        <meshBasicMaterial
          color={alert ? '#c0625d' : '#9fb6d8'}
          transparent
          opacity={0.05}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Html center zIndexRange={[5, 0]} position={[0, 2.42, 0]}>
        <div
          className={'camera-tag' + (alert ? ' alert' : '') + (hovered ? ' hover' : '')}
          onClick={() => { focusOnCamera(camera.id); requestTab('observe') }}
        >
          <span className="cam-rec" />{camera.label} · {alert ? '盲区' : 'REC'}
        </div>
      </Html>
    </group>
  )
}

/** Exposes the live scene graph so headless checks can measure what actually
    reached the frame (a mesh can exist in the tree and still be culled or
    degenerate). No visual effect, no cost in the render loop. */
function SceneProbe() {
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  useEffect(() => {
    ;(window as unknown as { __medusaScene?: THREE.Scene }).__medusaScene = scene
    ;(window as unknown as { __medusaCamera?: THREE.Camera }).__medusaCamera = camera
  }, [scene, camera])
  return null
}

/** OrbitControls is only needed for three fields; keeping a narrow shape
    avoids pulling three-stdlib types into the component. */
type OrbitLike = {
  target: THREE.Vector3
  enabled: boolean
  update: () => void
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

interface ShotTween {
  t: number
  fromPos: THREE.Vector3
  fromTarget: THREE.Vector3
  fromFov: number
  toPos: THREE.Vector3
  toTarget: THREE.Vector3
  toFov: number
}

const easeInOut = (t: number) => t * t * (3 - 2 * t)

/** Moves the camera between shots instead of hard-cutting. OrbitControls is
    disabled during the move (otherwise its damping fights the tween), and any
    manual drag cancels the move so the user always has the last word. */
function CameraDirector({ preset }: { preset: CameraPreset }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null
  const active = useRef<CameraPreset | null>(null)
  const tween = useRef<ShotTween | null>(null)

  useEffect(() => {
    if (!controls) return
    const onStart = () => {
      tween.current = null
      controls.enabled = true
    }
    controls.addEventListener('start', onStart)
    return () => controls.removeEventListener('start', onStart)
  }, [controls])

  useFrame((_, delta) => {
    // null on the first frame, so a preset restored from localStorage also
    // animates into place instead of silently disagreeing with the topbar.
    if (active.current !== preset) {
      active.current = preset
      const shot = CAMERA_PRESETS[preset]
      tween.current = {
        t: 0,
        fromPos: camera.position.clone(),
        fromTarget: controls?.target.clone() ?? new THREE.Vector3(...CAMERA_PRESETS.studio.target),
        fromFov: camera.fov,
        toPos: new THREE.Vector3(...shot.position),
        toTarget: new THREE.Vector3(...shot.target),
        toFov: shot.fov,
      }
      if (controls) controls.enabled = false
    }

    const tw = tween.current
    if (!tw) return
    tw.t = Math.min(1, tw.t + delta / 0.72)
    const k = easeInOut(tw.t)
    const target = new THREE.Vector3().lerpVectors(tw.fromTarget, tw.toTarget, k)
    camera.position.lerpVectors(tw.fromPos, tw.toPos, k)
    camera.fov = tw.fromFov + (tw.toFov - tw.fromFov) * k
    camera.updateProjectionMatrix()
    camera.lookAt(target)
    if (tw.t >= 1) {
      tween.current = null
      if (controls) {
        controls.target.copy(tw.toTarget)
        controls.enabled = true
        controls.update()
      }
    }
  })

  return null
}

function Scene() {
  // Declared before the early return so the hook order stays stable even when
  // a bad frame leaves us without a snapshot.
  const handoff = useRef<HandoffState | null>(null)
  useEffect(() => {
    ;(window as unknown as { __medusaHandoff?: typeof handoff }).__medusaHandoff = handoff
  }, [])
  const snapshot = useMedusaStore(selectSnapshot)
  const selectedWorkerId = useMedusaStore((state) => state.selectedWorkerId)
  if (!snapshot) return null

  // A floater can stand beside a station's regular, so spread workers that
  // share a stage instead of stacking their meshes on one point.
  const perStage: Record<string, number> = {}
  snapshot.workers.forEach((worker) => {
    perStage[worker.stageId] = (perStage[worker.stageId] ?? 0) + 1
  })
  const seen: Record<string, number> = {}
  const offsets: Record<string, number> = {}
  const labelLifts: Record<string, number> = {}
  snapshot.workers.forEach((worker) => {
    const index = seen[worker.stageId] ?? 0
    const count = perStage[worker.stageId] ?? 1
    offsets[worker.id] = (index - (count - 1) / 2) * 0.82
    labelLifts[worker.id] = index * 0.26
    seen[worker.stageId] = index + 1
  })
  const lastDispatch = snapshot.dispatch?.[snapshot.dispatch.length - 1]
  const stages: Stage[] = snapshot.stages.map((stage, i) => ({
    ...stage,
    position: {
      x: STAGE_LAYOUT[i]?.x ?? stage.position.x * 0.45,
      y: 0,
      z: STAGE_LAYOUT[i]?.z ?? 0,
    },
  }))
  // Crates are resolved per station below, so a long log never starves the
  // live order of a slot.

  return (
    <>
      <SceneProbe />
      <HandoffWatcher tasks={snapshot.tasks} stages={stages} handoff={handoff} />
      <RoomShell />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color="#eef2f7" roughness={0.9} metalness={0.02} />
      </mesh>

      {/* ---------- back of the studio ---------- */}
      <Credenza x={-0.5} z={-3.95} width={3.1} />
      <Bust x={1.75} z={-3.95} rotation={-0.35} />
      <Easel x={3.75} z={-2.75} rotation={-0.4} />
      <ShelfUnit x={-3.4} z={-4.95} rotation={0.04} />
      <ShelfUnit x={3.45} z={-5.05} rotation={-0.05} width={1.5} />
      {/* Keep the floor plants low and away from the shelf/camera sightlines:
          a tall crown showed up as detached leaves in the close shot. */}
      <Plant x={-4.4} z={-3.5} scale={1.0} />
      <Plant x={4.35} z={-4.2} scale={0.95} />
      <Plant x={-1.9} z={-5.5} scale={0.9} />
      <WallClock x={-4.9} y={2.85} z={-7.72} />
      <WallArt x={-2.0} y={2.5} z={-7.74} w={1.15} h={1.35} />
      <WallArt x={2.6} y={2.35} z={-7.74} w={0.95} h={1.1} />
      <BoxStack x={-4.0} z={-2.15} rotation={0.3} />
      <BoxStack x={2.75} z={-3.15} rotation={-0.4} />

      {stages.map((stage, index) => {
        const devices = (snapshot.tools ?? [])
          .filter((tool) => tool.stageId === stage.id)
          .map((tool) => ({
            tool,
            recent: tool.active || (tool.lastSeq > 0 && snapshot.seq - tool.lastSeq < 12),
          }))
        return (
          <WorkStation
            key={stage.id}
            stage={stage}
            index={index}
            devices={devices}
            highlighted={snapshot.boss.targetStageId === stage.id && snapshot.boss.mode !== 'patrol'}
          />
        )
      })}
      {snapshot.workers.map((worker) => {
        const index = stages.findIndex((stage) => stage.id === worker.stageId)
        const stage = stages[index]
        if (!stage) return null
        return (
          <WorkerFigure
            key={worker.id}
            worker={worker}
            anchor={seatAnchor(stage, index, offsets[worker.id] ?? 0)}
            selected={selectedWorkerId === worker.id}
            tint={soften(stage.color, 0.6, 0.5)}
            labelLift={labelLifts[worker.id] ?? 0}
            stageIndex={index}
            handoff={handoff}
          />
        )
      })}
      {/* One crate per station: the live order if there is one, otherwise the
          most recent delivered one (so the landing stays visible for a beat).
          Slicing the tail of the log used to fill every slot with finished
          orders, leaving the crate that was actually moving without a slot. */}
      {stages.map((stage, index) => {
        const live = snapshot.tasks.filter(
          (t) => t.stageIndex === index && t.status !== 'done' && t.status !== 'failed',
        )
        const finished = snapshot.tasks.filter(
          (t) => t.stageIndex === index && (t.status === 'done' || t.status === 'failed'),
        )
        return (
          <TaskCrate
            key={stage.id}
            task={live[live.length - 1] ?? finished[finished.length - 1] ?? null}
            offset={0}
            stages={stages}
            handoff={handoff}
          />
        )
      })}
      <DispatchBoard record={lastDispatch} />
      {(snapshot.cameras ?? []).map((camera) => (
        <CameraRig key={camera.id} camera={camera} />
      ))}
      <BossFigure boss={snapshot.boss} />
    </>
  )
}

export default function Workshop() {
  const closeAvatarEditor = useMedusaStore((state) => state.closeAvatarEditor)
  const cameraPreset = useMedusaStore((state) => state.cameraPreset)
  return (
    <Canvas
      shadows
      onPointerMissed={(event) => {
        // drei Html labels live outside the canvas but still bubble into
        // R3F's pointer handling. A click on one of them is a real
        // interaction, not a "miss" that should close the inspector.
        const target = event.target as HTMLElement | null
        if (target?.closest?.(
          '.worker-tag, .boss-tag, .stage-tag, .tool-tag, .camera-tag, .dispatch-board, .avatar-card',
        )) return
        closeAvatarEditor()
      }}
      camera={{ position: CAMERA_PRESETS.studio.position, fov: CAMERA_PRESETS.studio.fov }}
      onCreated={({ scene, camera }) => {
        ;(window as unknown as Record<string, unknown>).__MEDUSA = { scene, camera }
      }}
      dpr={[1, 2]}
      gl={{
        antialias: false,
        alpha: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.1,
      }}
    >
      {/* No scene background: the CSS studio gradient shows through. */}
      <fog attach="fog" args={['#fafbfd', 42, 92]} />
      {/* High-key studio light: a broad soft key, a cool bounce and a lot of
          ambient. The room has to read as white without washing out the pale
          furniture, so the key is wide and the shadows are lifted. */}
      <ambientLight intensity={0.34} />
      <hemisphereLight args={['#ffffff', '#dfe6ef', 0.58]} />
      <directionalLight
        position={[6.5, 12, 8.5]}
        intensity={1.75}
        color="#fff4e6"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-camera-near={0.5}
        shadow-camera-far={44}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-8, 7, -5]} intensity={0.4} color="#eef5ff" />

      {/* Self-hosted studio lighting: Lightformers bake into a cubemap in one
          frame, so there is no HDRI download and no CDN dependency. */}
      <Environment resolution={256} frames={1} environmentIntensity={1.15}>
        <Lightformer form="rect" intensity={1.7} color="#ffffff" scale={[14, 7, 1]} position={[0, 8, -6]} />
        <Lightformer form="rect" intensity={1.1} color="#ffffff" scale={[9, 6, 1]} position={[-9, 4, 2]} rotation={[0, Math.PI / 2, 0]} />
        <Lightformer form="rect" intensity={1.1} color="#ffffff" scale={[9, 6, 1]} position={[9, 4, 2]} rotation={[0, -Math.PI / 2, 0]} />
        <Lightformer form="circle" intensity={1.3} color="#ffffff" scale={[6, 6, 1]} position={[0, 10, 4]} rotation={[-Math.PI / 2, 0, 0]} />
      </Environment>
      <ContactShadows
        position={[0, 0.006, 0]}
        scale={34}
        opacity={0.5}
        blur={1.6}
        far={6}
        resolution={1024}
        color="#5c6a7e"
      />
      <Scene />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={3}
        maxDistance={40}
        maxPolarAngle={Math.PI / 2.08}
        target={CAMERA_PRESETS.studio.target}
      />
      <CameraDirector preset={cameraPreset} />
      <EffectComposer multisampling={4} frameBufferType={THREE.HalfFloatType}>
        {/* Ambient occlusion is what makes white-on-white read: without it
            every pale surface merges into the next one. */}
        <N8AO aoRadius={0.7} intensity={2.4} distanceFalloff={0.85} color="#57647a" />
        <Bloom intensity={0.16} luminanceThreshold={0.95} luminanceSmoothing={0.2} mipmapBlur radius={0.5} />
        <Vignette offset={0.32} darkness={0.08} />
      </EffectComposer>
    </Canvas>
  )
}
