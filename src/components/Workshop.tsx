'use client'

import { Canvas, useFrame } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useRef } from 'react'
import { selectSnapshot, useMedusaStore } from '@/lib/store'
import type { Boss, DispatchRecord, Stage, ToolView, Worker, WorkTask } from '@/lib/contract'

const STATUS_COLOR: Record<string, string> = {
  busy: '#534ab7',
  idle: '#888780',
  blocked: '#d93f3f',
  paused: '#ba7517',
}

function StagePlatform({ stage, highlighted }: { stage: Stage; highlighted: boolean }) {
  return (
    <group position={[stage.position.x, stage.position.y, stage.position.z]}>
      <mesh receiveShadow>
        <boxGeometry args={[3.2, 0.25, 2.4]} />
        <meshStandardMaterial color={highlighted ? '#d9d3f7' : '#ffffff'} />
      </mesh>
      <mesh position={[0, 0.14, 0]}>
        <boxGeometry args={[3.0, 0.02, 2.2]} />
        <meshStandardMaterial color={stage.color} />
      </mesh>
      <Html center zIndexRange={[5, 0]} distanceFactor={14} position={[0, 0.95, -1.05]}>
        <div className="stage-tag">{stage.name}</div>
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
  useFrame(({ clock }) => {
    if (!group.current) return
    const t = clock.getElapsedTime()
    const bob = worker.status === 'busy' ? 0.06 : 0.02
    group.current.position.y = (stage?.position.y ?? 0) + 0.62 + Math.sin(t * 2 + worker.id.length) * bob
    group.current.rotation.y = Math.sin(t * 0.6) * 0.16
  })
  const color = STATUS_COLOR[worker.status] ?? '#534ab7'
  return (
    <group ref={group} position={[(stage?.position.x ?? 0) + offsetX, 0.6, (stage?.position.z ?? 0) - 0.15]}>
      <mesh castShadow>
        <cylinderGeometry args={[0.28, 0.34, 0.8, 16]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.62, 0]} castShadow>
        <sphereGeometry args={[0.26, 20, 16]} />
        <meshStandardMaterial color={color} roughness={0.4} />
      </mesh>
      <mesh position={[0.36, 0.04, 0]}>
        <boxGeometry args={[0.34, 0.2, 0.28]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, 0]}>
          <ringGeometry args={[0.5, 0.64, 32]} />
          <meshBasicMaterial color="#534ab7" side={THREE.DoubleSide} />
        </mesh>
      )}
      <Html center zIndexRange={[5, 0]} distanceFactor={12} position={[0, 1.18 + labelLift, 0]}>
        <div className="worker-tag">
          {worker.name} · {worker.status}
        </div>
      </Html>
    </group>
  )
}

function TaskCrate({ task, offset }: { task: WorkTask; offset: number }) {
  if (task.status === 'done') return null
  const x = -6 + (task.stageIndex + task.progress) * 4
  const color = task.status === 'failed' ? '#d93f3f' : '#185fa5'
  return (
    <group position={[x, 0.6, 3.2 + offset]}>
      <mesh castShadow>
        <boxGeometry args={[0.46, 0.38, 0.46]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <Html center zIndexRange={[5, 0]} distanceFactor={18} position={[0, 0.5, 0]}>
        <div className="task-tag">{task.id}</div>
      </Html>
    </group>
  )
}

function BossFigure({ boss }: { boss: Boss }) {
  const group = useRef<THREE.Group>(null)
  const targetX = useRef(boss.x)
  targetX.current = boss.x
  useFrame(() => {
    if (!group.current) return
    group.current.position.x += (targetX.current - group.current.position.x) * 0.09
    group.current.rotation.y = Math.sin(targetX.current) * 0.2
  })
  const color = boss.mode === 'intervene'
    ? '#d93f3f'
    : boss.mode === 'inspect'
      ? '#ba7517'
      : boss.mode === 'dispatch'
        ? '#1d9e75'
        : '#3c3489'
  return (
    <group ref={group} position={[boss.x, 0, boss.z]}>
      <mesh castShadow>
        <cylinderGeometry args={[0.32, 0.4, 1.0, 16]} />
        <meshStandardMaterial color={color} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.76, 0]} castShadow>
        <sphereGeometry args={[0.3, 20, 16]} />
        <meshStandardMaterial color={color} roughness={0.4} />
      </mesh>
      <mesh position={[0, 1.04, 0]}>
        <cylinderGeometry args={[0.44, 0.44, 0.09, 20]} />
        <meshStandardMaterial color="#2c2c2a" />
      </mesh>
      <Html center zIndexRange={[5, 0]} distanceFactor={12} position={[0, 2.05, 0]}>
        <div className={`boss-tag ${boss.mode}`}>老板 · {boss.note || boss.mode}</div>
      </Html>
    </group>
  )
}

function Conveyor() {
  return (
    <group position={[0, 0.15, 3.2]}>
      <mesh receiveShadow>
        <boxGeometry args={[15, 0.3, 1.5]} />
        <meshStandardMaterial color="#d7dde6" />
      </mesh>
      <mesh position={[0, 0.17, 0]}>
        <boxGeometry args={[14.6, 0.02, 1.3]} />
        <meshStandardMaterial color="#b9c2d0" />
      </mesh>
      {Array.from({ length: 15 }, (_, i) => (
        <mesh key={i} position={[-7 + i, 0.19, 0]}>
          <boxGeometry args={[0.06, 0.02, 1.2]} />
          <meshStandardMaterial color="#ffffff" />
        </mesh>
      ))}
    </group>
  )
}

function ToolDevice({ tool, x, recent }: { tool: ToolView; x: number; recent: boolean }) {
  const color = recent ? '#1d9e75' : tool.permission === 'approval' ? '#ba7517' : '#9aa3b2'
  return (
    <group position={[x, 0.38, 0.95]}>
      <mesh castShadow>
        <boxGeometry args={[0.5, 0.44, 0.38]} />
        <meshStandardMaterial color={color} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.06, 0.195]}>
        <boxGeometry args={[0.36, 0.2, 0.02]} />
        <meshStandardMaterial color={recent ? '#d7f5e8' : '#e9edf3'} />
      </mesh>
      <mesh position={[0, 0.28, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 0.14, 8]} />
        <meshStandardMaterial color={recent ? '#0f6e56' : '#6b7280'} />
      </mesh>
      {recent && tool.lastReceipt && (
        <Html center zIndexRange={[5, 0]} distanceFactor={16} position={[0, 0.78, 0]}>
          <div className="tool-receipt">
            {tool.lastReceipt.length > 14 ? tool.lastReceipt.slice(0, 13) + '…' : tool.lastReceipt}
          </div>
        </Html>
      )}
      <Html center zIndexRange={[5, 0]} distanceFactor={18} position={[0, -0.34, 0]}>
        <div className={'tool-tag' + (recent ? ' active' : '')}>{tool.label}</div>
      </Html>
    </group>
  )
}

function DispatchBoard({ record }: { record?: DispatchRecord }) {
  return (
    <group position={[0, 0, -3.3]}>
      <mesh position={[0, 2.25, 0]} castShadow>
        <boxGeometry args={[3.6, 1.15, 0.14]} />
        <meshStandardMaterial color="#3c3489" roughness={0.4} />
      </mesh>
      <mesh position={[0, 2.25, 0.085]}>
        <boxGeometry args={[3.35, 0.95, 0.02]} />
        <meshStandardMaterial color="#f7f6ff" />
      </mesh>
      <mesh position={[-1.3, 3.2, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.9, 6]} />
        <meshStandardMaterial color="#6b7280" />
      </mesh>
      <mesh position={[1.3, 3.2, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.9, 6]} />
        <meshStandardMaterial color="#6b7280" />
      </mesh>
      <Html center zIndexRange={[5, 0]} distanceFactor={22} position={[0, 2.25, 0.12]}>
        <div className="dispatch-board">
          <span>派单台 / DISPATCH</span>
          <b>{record ? `${record.taskId} → ${record.stageId}` : '待命中'}</b>
          <small>{record ? `${record.workerName} · ${record.score.toFixed(2)}` : '等待新工单'}</small>
        </div>
      </Html>
    </group>
  )
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

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#eef2f7" />
      </mesh>
      <gridHelper args={[40, 40, '#c3ccd9', '#dde3ec']} position={[0, 0, 0]} />
      <Conveyor />
      <mesh position={[0, 0.01, 5.2]}>
        <boxGeometry args={[13, 0.02, 0.14]} />
        <meshBasicMaterial color="#7f77dd" transparent opacity={0.4} />
      </mesh>
      {snapshot.stages.map((stage) => (
        <StagePlatform
          key={stage.id}
          stage={stage}
          highlighted={snapshot.boss.targetStageId === stage.id && snapshot.boss.mode !== 'patrol'}
        />
      ))}
      {snapshot.stages.map((stage) => {
        const devices = (snapshot.tools ?? []).filter((tool) => tool.stageId === stage.id)
        return (
          <group key={'devices-' + stage.id} position={[stage.position.x, stage.position.y, stage.position.z]}>
            {devices.map((tool, i) => (
              <ToolDevice
                key={tool.name}
                tool={tool}
                x={(i - (devices.length - 1) / 2) * 1.05}
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
          stage={snapshot.stages.find((stage) => stage.id === worker.stageId)}
          selected={selectedWorkerId === worker.id}
          offsetX={offsets[worker.id] ?? 0}
          labelLift={labelLifts[worker.id] ?? 0}
        />
      ))}
      {snapshot.tasks.map((task, index) => (
        <TaskCrate key={task.id} task={task} offset={((index % 3) - 1) * 0.36} />
      ))}
      <DispatchBoard record={lastDispatch} />
      <BossFigure boss={snapshot.boss} />
    </>
  )
}

export default function Workshop() {
  return (
    <Canvas shadows camera={{ position: [0, 11, 20], fov: 48 }} dpr={[1, 2]}>
      <color attach="background" args={['#eef2f7']} />
      <ambientLight intensity={1.6} />
      <directionalLight position={[6, 12, 8]} intensity={1.5} castShadow />
      <directionalLight position={[-8, 5, -6]} intensity={0.5} color="#c9d6ff" />
      <Scene />
      <OrbitControls enableDamping minDistance={8} maxDistance={40} maxPolarAngle={Math.PI / 2.1} />
    </Canvas>
  )
}
