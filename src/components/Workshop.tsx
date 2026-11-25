'use client'

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows, Environment, Grid, Html, Lightformer, OrbitControls, RoundedBox,
} from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { selectSnapshot, useMedusaStore } from '@/lib/store'
import { BOSS_KEY, resolveAvatar, workerKey } from '@/lib/appearance'
import { Avatar } from './Avatar'
import {
  Cabinet, DeskSetup, OfficeChair, RoomShell, WallClock,
} from './OfficeSet'
import type { Boss, CameraView, DispatchRecord, Stage, ToolView, Worker, WorkTask } from '@/lib/contract'

// Deliberately muted: the backend colours are chart accents, not paint. A calm
// low-saturation palette is what makes a scene read as an office rather than
// a dashboard that happens to be 3D.
const STATUS_COLOR: Record<string, string> = {
  busy: '#8b95e0',
  idle: '#a6b2c0',
  blocked: '#d4746f',
  paused: '#c9a05e',
}

function soften(hex: string, saturation = 0.4, lightness = 0.66): string {
  const c = new THREE.Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  c.setHSL(hsl.h, saturation, lightness)
  return `#${c.getHexString()}`
}

const SURFACE = '#e3d3bb'
const METAL = '#9aa3ad'

function StagePlatform({ stage, highlighted }: { stage: Stage; highlighted: boolean }) {
  const accent = useMemo(() => soften(stage.color), [stage.color])
  const pool = useMemo(() => soften(stage.color, 0.45, 0.8), [stage.color])
  const [hovered, setHovered] = useState(false)
  const requestTab = useMedusaStore((state) => state.requestTab)
  return (
    <group
      position={[stage.position.x, stage.position.y, stage.position.z]}
      onClick={(event) => {
        event.stopPropagation()
        requestTab('workers')
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
      {/* A soft pool of light on the floor ties the station to the ground. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
        <circleGeometry args={[2.0, 48]} />
        <meshBasicMaterial color={pool} transparent opacity={hovered ? 0.4 : highlighted ? 0.34 : 0.2} depthWrite={false} />
      </mesh>
      {/* A recessed plinth, a light top and a thin edge band: three layers
          read as furniture instead of one thick crate. */}
      <mesh position={[0, 0.028, 0]}>
        <boxGeometry args={[2.86, 0.055, 2.16]} />
        <meshStandardMaterial color="#a98f6d" roughness={0.88} />
      </mesh>
      <RoundedBox args={[2.62, 0.05, 1.94]} radius={0.016} smoothness={3} position={[0, 0.025, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#9dabbc" roughness={0.85} metalness={0.05} />
      </RoundedBox>
      <RoundedBox name="stage-top" args={[2.8, 0.12, 2.1]} radius={0.035} smoothness={4} position={[0, 0.115, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={SURFACE} roughness={0.62} metalness={0.04} />
      </RoundedBox>
      <mesh position={[0, 0.132, 0]} receiveShadow>
        <boxGeometry args={[2.58, 0.01, 1.88]} />
        <meshStandardMaterial color={accent} roughness={0.55} transparent opacity={hovered ? 0.34 : highlighted ? 0.26 : 0.12} />
      </mesh>
      {/* Desk dressing: monitor, keyboard, notes, lamp. A station has to look
          like a place someone works at, not a pedestal. */}
      <DeskSetup accent={accent} />
      {/* Front edge light: the only emissive strip, so Bloom has a reason. */}
      <mesh position={[0, 0.045, 1.053]}>
        <boxGeometry args={[2.5, 0.022, 0.014]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={highlighted ? 1.6 : 0.3}
          roughness={0.4}
        />
      </mesh>
      {/* A nameplate on the front edge, not a floating sign behind the desk.
          At y=0.95 / z=-1.05 this label projected straight onto the worker's
          face at any camera distance. */}
      <Html center zIndexRange={[5, 0]} position={[0, 0.2, 1.12]}>
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
  stage,
  selected,
  offsetX = 0,
  labelLift = 0,
}: {
  worker: Worker
  stage?: Stage
  selected: boolean
  offsetX?: number
  labelLift?: number
}) {
  const group = useRef<THREE.Group>(null)
  const halo = useRef<THREE.Mesh>(null)
  const [hovered, setHovered] = useState(false)
  const appearance = useMedusaStore((state) => state.appearance)
  const openAvatarEditor = useMedusaStore((state) => state.openAvatarEditor)
  const selectWorker = useMedusaStore((state) => state.selectWorker)
  const editorTarget = useMedusaStore((state) => state.avatarEditor)
  const isEditing = editorTarget?.kind === 'worker' && editorTarget.id === worker.id
  const statusColor = STATUS_COLOR[worker.status] ?? STATUS_COLOR.busy
  const avatar = resolveAvatar(appearance, workerKey(worker.id), statusColor)
  const color = avatar.effectiveColor

  useFrame(({ clock }) => {
    if (!group.current) return
    const t = clock.getElapsedTime()
    const bob = worker.status === 'busy' ? 0.022 : 0.01
    // Feet land on the desk surface (0.27), not on the old capsule centre.
    group.current.position.y = (stage?.position.y ?? 0) + 0.832 + Math.sin(t * 2 + worker.id.length) * bob
    group.current.rotation.y = Math.sin(t * 0.6) * 0.16
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
      position={[(stage?.position.x ?? 0) + offsetX, 0.82, (stage?.position.z ?? 0) - 0.15]}
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
      <mesh position={[0, 0.14, 0]}>
        <capsuleGeometry args={[0.44, 1.0, 4, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Avatar model={avatar.model} color={color} scale={avatar.scale} />
      <mesh ref={halo} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.56, 0]}>
        <ringGeometry args={[0.44, 0.68, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Html center zIndexRange={[30, 20]} position={[0, 1.72 + labelLift, 0]}>
        <div
          className="worker-tag"
          style={{ position: 'relative', top: '-30px' }}
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

/// Fixed crate slots on the floor. A constant count means React never has to
/// unmount a crate's Html label when the order list shifts.
const CRATE_SLOTS = 10

/// Stages arrive on a 10-unit span, which forces the camera so far back that a
/// 1.3 m character ends up 50 px tall. Narrowing the span on the client keeps
/// the log authoritative while giving the camera a desk-sized room to work in.
const STAGE_SPREAD = 0.6
const SPACING = 5 * STAGE_SPREAD

function TaskCrate({ task, offset, stages }: { task: WorkTask | null; offset: number; stages: Stage[] }) {
  // The slot is permanent; only its contents change. Dropping the group (or
  // keying it by task id) unmounts a drei Html root mid-render, which trips
  // React's sync-unmount guard every time an order leaves the floor.
  const done = !task || task.status === 'done' || task.status === 'failed'
  const base = stages[Math.min(task?.stageIndex ?? 0, stages.length - 1)]?.position.x ?? 0
  const x = task ? base + task.progress * SPACING : stages[0]?.position.x ?? 0
  const failed = task?.status === 'failed'
  const color = failed ? '#cf6f6b' : '#6a86a8'
  return (
    <group visible={!done} position={[x, 0.6, 3.2 + offset]}>
      <RoundedBox args={[0.46, 0.38, 0.46]} radius={0.06} smoothness={3} castShadow>
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.08} />
      </RoundedBox>
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[0.3, 0.012, 0.02]} />
        <meshStandardMaterial color="#e8eef4" roughness={0.5} />
      </mesh>
      <Html center zIndexRange={[5, 0]} position={[0, 0.52, 0]}>
        <div className="task-tag" style={{ opacity: done ? 0 : 1 }}>{task?.id ?? ''}</div>
      </Html>
    </group>
  )
}

function BossFigure({ boss }: { boss: Boss }) {
  const group = useRef<THREE.Group>(null)
  const targetX = useRef(boss.x)
  targetX.current = boss.x
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

  useFrame(() => {
    if (!group.current) return
    group.current.position.x += (targetX.current - group.current.position.x) * 0.09
    group.current.rotation.y = Math.sin(targetX.current) * 0.2
  })

  return (
    <group
      ref={group}
      position={[boss.x, 0.56, boss.z * 0.8]}
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
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.55, 0]}>
        <circleGeometry args={[0.78, 40]} />
        <meshBasicMaterial color={color} transparent opacity={hovered || isEditing ? 0.28 : 0.14} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.1, 0]}>
        <capsuleGeometry args={[0.5, 0.95, 4, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Avatar model={avatar.model} color={color} boss scale={avatar.scale * 1.12} />
      <Html center zIndexRange={[32, 22]} position={[0, 1.86, 0]}>
        <div
          className={`boss-tag ${boss.mode}`}
          onClick={() => openAvatarEditor({ kind: 'boss', name: '老板', status: boss.mode })}
        >{avatar.label || '老板'} · {boss.note || boss.mode}</div>
      </Html>
    </group>
  )
}

function Conveyor() {
  const stripes = useRef<THREE.Group>(null)
  // Stripes are spaced exactly one unit apart, so shifting the whole group by
  // a fractional unit creates an endless belt without touching every child.
  useFrame(({ clock }) => {
    if (stripes.current) stripes.current.position.x = (clock.getElapsedTime() * 0.42) % 1
  })
  return (
    <group position={[0, 0.15, 3.2]}>
      <RoundedBox args={[11, 0.3, 1.4]} radius={0.09} smoothness={3} receiveShadow castShadow>
        <meshStandardMaterial color="#d5dce3" roughness={0.78} metalness={0.06} />
      </RoundedBox>
      <mesh position={[0, 0.158, 0]}>
        <boxGeometry args={[10.5, 0.016, 1.2]} />
        <meshStandardMaterial color="#b9c4cf" roughness={0.6} metalness={0.12} />
      </mesh>
      <group ref={stripes}>
        {Array.from({ length: 13 }, (_, i) => (
          <mesh key={i} position={[-6 + i, 0.17, 0]}>
            <boxGeometry args={[0.045, 0.012, 1.22]} />
            <meshStandardMaterial color="#f4f7fa" roughness={0.8} />
          </mesh>
        ))}
      </group>
      {/* Side rails make it read as a machine, not a plank. */}
      {[-0.76, 0.76].map((z) => (
        <mesh key={z} position={[0, 0.19, z]} castShadow>
          <boxGeometry args={[15, 0.1, 0.06]} />
          <meshStandardMaterial color={METAL} roughness={0.42} metalness={0.55} />
        </mesh>
      ))}
    </group>
  )
}

function ToolDevice({ tool, x, recent }: { tool: ToolView; x: number; recent: boolean }) {
  const [hovered, setHovered] = useState(false)
  const focusOnTool = useMedusaStore((state) => state.focusOnTool)
  const requestTab = useMedusaStore((state) => state.requestTab)
  const color = recent ? '#5f9380' : tool.permission === 'approval' ? '#b58a4c' : '#9aa5b1'
  const screen = recent ? '#c8ecd9' : '#e5ebf1'
  const showReceipt = recent && Boolean(tool.lastReceipt)
  const receipt = tool.lastReceipt.length > 14 ? tool.lastReceipt.slice(0, 13) + '…' : tool.lastReceipt
  return (
    <group
      position={[x, 0.24, 0.95]}
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
        <boxGeometry args={[0.72, 0.82, 0.62]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <RoundedBox args={[0.5, 0.44, 0.38]} radius={0.055} smoothness={3} castShadow>
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.18} />
      </RoundedBox>
      <mesh position={[0, 0.06, 0.196]}>
        <planeGeometry args={[0.34, 0.19]} />
        <meshStandardMaterial
          color={screen}
          emissive={recent ? '#4f9e7c' : '#000000'}
          emissiveIntensity={recent ? 0.5 : 0}
          roughness={0.28}
        />
      </mesh>
      <mesh position={[0, 0.27, 0]}>
        <cylinderGeometry args={[0.024, 0.024, 0.12, 8]} />
        <meshStandardMaterial color={METAL} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0.18, 0.28, 0.1]}>
        <sphereGeometry args={[0.038, 12, 10]} />
        <meshStandardMaterial
          color={recent ? '#8fe0b6' : '#a9b3bd'}
          emissive={recent ? '#3ec98c' : '#000000'}
          emissiveIntensity={recent ? 1.6 : 0}
        />
      </mesh>
      {/* The receipt label stays mounted on purpose: drei's Html unmounts its
          React root synchronously, which trips React's "unmount while
          rendering" guard when it happens on a snapshot update. Fade it. */}
      <Html center zIndexRange={[5, 0]} position={[0, 0.82, 0]}>
        <div className="tool-receipt" style={{ opacity: showReceipt ? 1 : 0 }}>
          {showReceipt ? receipt : ''}
        </div>
      </Html>
      <Html center zIndexRange={[5, 0]} position={[0, -0.36, 0]}>
        <div
          className={'tool-tag' + (recent ? ' active' : '') + (hovered ? ' hover' : '')}
          onClick={() => { focusOnTool(tool.name); requestTab('tools') }}
        >{tool.label}</div>
      </Html>
    </group>
  )
}

function DispatchBoard({ record }: { record?: DispatchRecord }) {
  const requestTab = useMedusaStore((state) => state.requestTab)
  return (
    <group position={[0, 0, -3.3]}>
      {/* A plinth so the big screen stands on the floor instead of floating. */}
      <RoundedBox args={[2.9, 0.12, 0.72]} radius={0.035} smoothness={3} position={[0, 0.06, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#a7b4c3" roughness={0.72} metalness={0.12} />
      </RoundedBox>
      <RoundedBox args={[3.7, 1.2, 0.16]} radius={0.05} smoothness={4} position={[0, 2.25, 0]} castShadow>
        <meshStandardMaterial color="#4a4a68" roughness={0.46} metalness={0.22} />
      </RoundedBox>
      <mesh position={[0, 2.25, 0.088]}>
        <planeGeometry args={[3.42, 0.98]} />
        <meshStandardMaterial
          color="#1d2735"
          emissive="#3f6bb0"
          emissiveIntensity={0.3}
          roughness={0.26}
          metalness={0.2}
        />
      </mesh>
      <mesh position={[0, 2.25, 0.09]}>
        <boxGeometry args={[3.5, 0.02, 0.014]} />
        <meshStandardMaterial color="#8f9ae8" emissive="#8f9ae8" emissiveIntensity={0.7} />
      </mesh>
      {[-1.3, 1.3].map((x) => (
        <mesh key={x} position={[x, 1.4, 0]} castShadow>
          <cylinderGeometry args={[0.035, 0.045, 1.8, 10]} />
          <meshStandardMaterial color={METAL} metalness={0.55} roughness={0.4} />
        </mesh>
      ))}
      <Html center zIndexRange={[5, 0]} position={[0, 2.25, 0.13]}>
        <div className="dispatch-board" onClick={() => requestTab('dispatch')}>
          <span>派单台 / DISPATCH</span>
          <b>{record ? `${record.taskId} → ${record.stageId}` : '待命中'}</b>
          <small>{record ? `${record.workerName} · ${record.score.toFixed(2)}` : '等待新工单'}</small>
        </div>
      </Html>
    </group>
  )
}

function CameraRig({ camera }: { camera: CameraView }) {
  const lamp = useRef<THREE.Mesh>(null)
  const [hovered, setHovered] = useState(false)
  const focusOnCamera = useMedusaStore((state) => state.focusOnCamera)
  const requestTab = useMedusaStore((state) => state.requestTab)
  useFrame(({ clock }) => {
    if (!lamp.current) return
    const mat = lamp.current.material as THREE.MeshStandardMaterial
    const t = clock.getElapsedTime()
    // Blinking REC lamp; faster when the camera has something to report.
    mat.emissiveIntensity = camera.status === 'alert'
      ? 0.9 + Math.sin(t * 8) * 0.5
      : 0.35 + Math.sin(t * 2.5) * 0.2
  })
  const alert = camera.status === 'alert'
  const color = alert ? '#c0625d' : '#5a5a78'
  // Fixed viewpoints lean inward so their cones cover the shop floor.
  const tilt: [number, number, number] = camera.position.x < -1
    ? [0, 0, 0.3]
    : camera.position.x > 1
      ? [0, 0, -0.3]
      : [-0.34, 0, 0]
  return (
    <group
      position={[camera.position.x, camera.position.y, camera.position.z]}
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
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[0.9, 1.5, 0.9]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 1.8, 8]} />
        <meshStandardMaterial color={METAL} metalness={0.6} roughness={0.4} />
      </mesh>
      <RoundedBox args={[0.62, 0.34, 0.42]} radius={0.06} smoothness={3} position={[0, -0.05, 0]} castShadow>
        <meshStandardMaterial color={color} roughness={0.48} metalness={0.16} />
      </RoundedBox>
      <mesh position={[0, -0.05, -0.32]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.14, 0.19, 0.3, 16]} />
        <meshStandardMaterial color="#3f4450" roughness={0.5} metalness={0.3} />
      </mesh>
      <mesh position={[0, -0.05, -0.48]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.11, 0.11, 0.02, 16]} />
        <meshStandardMaterial color={alert ? '#f3cecb' : '#cdd6f2'} roughness={0.25} metalness={0.2} />
      </mesh>
      <mesh ref={lamp} position={[0.24, 0.11, -0.22]}>
        <sphereGeometry args={[0.055, 12, 10]} />
        <meshStandardMaterial color="#e8796f" emissive="#e84a3c" emissiveIntensity={0.6} />
      </mesh>
      {/* A translucent cone: what this viewpoint can see. It is a hint, not
          a real frustum — the actual record is the append-only log. */}
      {/* The cone is decoration: it must not swallow clicks on the floor. */}
      <mesh position={[0, -1.75, 0]} rotation={tilt} raycast={() => {}}>
        <coneGeometry args={[1.45, 3.5, 24, 1, true]} />
        <meshBasicMaterial
          color={alert ? '#c0625d' : '#7f8ad6'}
          transparent
          opacity={0.055}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Html center zIndexRange={[5, 0]} position={[0, 0.7, 0]}>
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

const PLANT_LEAVES: [number, number, number, number][] = [
  [0, 0.54, 0, 0.28],
  [0.18, 0.7, 0.08, 0.22],
  [-0.16, 0.72, -0.06, 0.2],
  [0.05, 0.88, -0.1, 0.17],
]

/// Procedural office dressing. No downloaded assets, no licence to track, and
/// it scales with the scene instead of fighting the data-driven layout.
function OfficePlant({ x, z, scale = 1 }: { x: number; z: number; scale?: number }) {
  return (
    <group position={[x, 0, z]} scale={scale}>
      <RoundedBox args={[0.46, 0.42, 0.46]} radius={0.08} smoothness={3} castShadow receiveShadow>
        <meshStandardMaterial color="#cbc4b8" roughness={0.86} />
      </RoundedBox>
      <mesh position={[0, 0.22, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.035, 20]} />
        <meshStandardMaterial color="#6d6457" roughness={1} />
      </mesh>
      {PLANT_LEAVES.map(([lx, ly, lz, r], i) => (
        <mesh key={i} position={[lx, ly, lz]} castShadow>
          <icosahedronGeometry args={[r, 1]} />
          <meshStandardMaterial color={i % 2 ? '#7f9b7d' : '#6d8b72'} roughness={0.84} flatShading />
        </mesh>
      ))}
    </group>
  )
}

function FloorLamp({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.25, 0.29, 0.08, 24]} />
        <meshStandardMaterial color={METAL} metalness={0.55} roughness={0.4} />
      </mesh>
      <mesh position={[0, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.032, 0.032, 2, 12]} />
        <meshStandardMaterial color={METAL} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 2.12, 0]} castShadow>
        <coneGeometry args={[0.4, 0.42, 24, 1, true]} />
        <meshStandardMaterial
          color="#f1eee6"
          side={THREE.DoubleSide}
          roughness={0.72}
          emissive="#ffe6bd"
          emissiveIntensity={0.22}
        />
      </mesh>
      <mesh position={[0, 1.98, 0]}>
        <sphereGeometry args={[0.11, 16, 12]} />
        <meshStandardMaterial color="#fff1d4" emissive="#ffd28a" emissiveIntensity={1.5} />
      </mesh>
      <pointLight position={[0, 1.98, 0]} intensity={2.4} distance={7} color="#ffe6bd" />
    </group>
  )
}

function Partition({ x }: { x: number }) {
  return (
    <group position={[x, 0, -2.05]}>
      <mesh position={[0, 0.76, 0]} castShadow>
        <boxGeometry args={[3.3, 1.4, 0.07]} />
        <meshStandardMaterial color="#dce4ec" transparent opacity={0.4} roughness={0.32} metalness={0.06} />
      </mesh>
      <mesh position={[0, 1.47, 0]}>
        <boxGeometry args={[3.36, 0.045, 0.11]} />
        <meshStandardMaterial color={METAL} metalness={0.45} roughness={0.4} />
      </mesh>
    </group>
  )
}

/** Exposes the live scene graph so headless checks can measure what actually
    reached the frame (a mesh can exist in the tree and still be culled or
    degenerate). No visual effect, no cost in the render loop. */
function SceneProbe() {
  const scene = useThree((state) => state.scene)
  useEffect(() => {
    ;(window as unknown as { __medusaScene?: THREE.Scene }).__medusaScene = scene
  }, [scene])
  return null
}

function Scene() {
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
    offsets[worker.id] = (index - (count - 1) / 2) * 0.95
    labelLifts[worker.id] = index * 0.32
    seen[worker.stageId] = index + 1
  })
  const lastDispatch = snapshot.dispatch?.[snapshot.dispatch.length - 1]
  const stages: Stage[] = snapshot.stages.map((stage) => ({
    ...stage,
    position: { ...stage.position, x: stage.position.x * STAGE_SPREAD },
  }))

  return (
    <>
      <SceneProbe />
      <RoomShell />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#d3dce6" roughness={0.97} metalness={0} />
      </mesh>
      <Grid
        position={[0, 0.004, 0]}
        args={[60, 60]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#b3c1d1"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#9aabbe"
        fadeDistance={38}
        fadeStrength={1.7}
        infiniteGrid
      />
      {/* Rug: two flat slabs, not RoundedBox. A 14 mm plate cannot carry a
          0.3 m corner radius - drei extrudes the radius into thickness, which
          turned the rug into a 1.4 m wall that swallowed the desks and every
          character's legs. Flat boxes keep it at floor level. */}
      <mesh position={[0, 0.004, 1.1]} receiveShadow>
        <boxGeometry args={[17.62, 0.008, 9.42]} />
        <meshStandardMaterial color="#adbdce" roughness={1} metalness={0} />
      </mesh>
      <mesh position={[0, 0.012, 1.1]} receiveShadow>
        <boxGeometry args={[17.4, 0.008, 9.2]} />
        <meshStandardMaterial color="#dbe6f2" roughness={1} metalness={0} />
      </mesh>
      <OfficePlant x={-8.6} z={1.4} />
      <OfficePlant x={8.6} z={1.4} scale={0.86} />
      <FloorLamp x={-8.2} z={-2.6} />
      <FloorLamp x={8.2} z={-2.6} />
      <Partition x={-5} />
      <Partition x={5} />
      <Cabinet x={-8.55} z={-8.9} />
      <WallClock x={8.3} y={2.95} z={-9.32} />
      <OfficeChair x={-7.9} z={0.35} accent="#8a93c9" rotation={0.7} />
      <OfficeChair x={7.9} z={0.35} accent="#8a93c9" rotation={-0.7} />
      <OfficePlant x={-6.9} z={-6.4} scale={1.75} />
      <OfficePlant x={6.9} z={-6.4} scale={1.55} />
      <Conveyor />
      {stages.map((stage) => (
        <StagePlatform
          key={stage.id}
          stage={stage}
          highlighted={snapshot.boss.targetStageId === stage.id && snapshot.boss.mode !== 'patrol'}
        />
      ))}
      {stages.map((stage) => {
        const devices = (snapshot.tools ?? []).filter((tool) => tool.stageId === stage.id)
        return (
          <group key={'devices-' + stage.id} position={[stage.position.x, stage.position.y, stage.position.z]}>
            {devices.map((tool, i) => (
              <ToolDevice
                key={tool.name}
                tool={tool}
                x={(i - (devices.length - 1) / 2) * 0.92}
                recent={tool.active || (tool.lastSeq > 0 && snapshot.seq - tool.lastSeq < 12)}
              />
            ))}
          </group>
        )
      })}
      {snapshot.workers.map((worker) => (
        <WorkerFigure
          key={worker.id}
          worker={worker}
          stage={stages.find((stage) => stage.id === worker.stageId)}
          selected={selectedWorkerId === worker.id}
          offsetX={offsets[worker.id] ?? 0}
          labelLift={labelLifts[worker.id] ?? 0}
        />
      ))}
      {/* Only the newest crates: finished ones stay mounted but hidden, so a
          long shift never grows an unbounded HTML label layer. */}
      {Array.from({ length: CRATE_SLOTS }, (_, index) => (
        <TaskCrate
          key={index}
          task={snapshot.tasks[snapshot.tasks.length - CRATE_SLOTS + index] ?? null}
          offset={((index % 3) - 1) * 0.36}
          stages={stages}
        />
      ))}
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
      camera={{ position: [0, 4.9, 11.2], fov: 36 }}
      onCreated={({ scene, camera }) => {
        ;(window as unknown as Record<string, unknown>).__MEDUSA = { scene, camera }
      }}
      dpr={[1, 2]}
      gl={{ antialias: false, alpha: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.97 }}
    >
      {/* No scene background: the CSS ceiling gradient shows through, which
          gives the horizon a soft falloff for free. */}
      <fog attach="fog" args={['#e2eaf2', 30, 64]} />
      {/* Ambient is deliberately low: the scene needs a direction of light or
          every pale surface flattens into the same white. */}
      <ambientLight intensity={0.3} />
      <hemisphereLight args={['#ffffff', '#b9c6d6', 0.46]} />
      <directionalLight
        position={[7, 13, 9]}
        intensity={1.6}
        color="#fff7ec"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-17}
        shadow-camera-right={17}
        shadow-camera-top={17}
        shadow-camera-bottom={-17}
        shadow-camera-near={0.5}
        shadow-camera-far={44}
        shadow-bias={-0.0002}
        shadow-normalBias={0.022}
      />
      <directionalLight position={[-9, 7, -7]} intensity={0.34} color="#c3d4ee" />

      {/* Self-hosted studio lighting: Lightformers bake into a cubemap in one
          frame, so there is no HDRI download and no CDN dependency. */}
      <Environment resolution={256} frames={1} environmentIntensity={0.6}>
        <Lightformer form="rect" intensity={1.5} color="#ffffff" scale={[12, 6, 1]} position={[0, 8, -6]} />
        <Lightformer form="rect" intensity={0.9} color="#dce7ff" scale={[8, 5, 1]} position={[-9, 4, 2]} rotation={[0, Math.PI / 2, 0]} />
        <Lightformer form="rect" intensity={0.75} color="#fff0dc" scale={[8, 5, 1]} position={[9, 4, 2]} rotation={[0, -Math.PI / 2, 0]} />
        <Lightformer form="circle" intensity={1.1} color="#ffffff" scale={[5, 5, 1]} position={[0, 10, 4]} rotation={[-Math.PI / 2, 0, 0]} />
      </Environment>
      <ContactShadows
        position={[0, 0.012, 0]}
        scale={38}
        opacity={0.64}
        blur={1.7}
        far={8}
        resolution={1024}
        color="#3f4b5c"
      />
      <Scene />
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={3}
        maxDistance={42}
        maxPolarAngle={Math.PI / 2.1}
        target={[0, 0.9, 0.6]}
      />
      <EffectComposer multisampling={4} frameBufferType={THREE.HalfFloatType}>
        <Bloom intensity={0.3} luminanceThreshold={0.92} luminanceSmoothing={0.24} mipmapBlur radius={0.55} />
        <Vignette offset={0.32} darkness={0.24} />
      </EffectComposer>
    </Canvas>
  )
}
