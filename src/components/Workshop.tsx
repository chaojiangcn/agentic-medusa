'use client'

import { Canvas, useFrame } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useRef } from 'react'
import { selectSnapshot, useMedusaStore } from '@/lib/store'
import type { Boss, Stage, Worker, WorkTask } from '@/lib/contract'

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
      <Html center distanceFactor={14} position={[0, 0.95, -1.05]}>
        <div className="stage-tag">{stage.name}</div>
      </Html>
    </group>
  )
}

function WorkerFigure({
  worker,
  stage,
  selected,
}: {
  worker: Worker
  stage?: Stage
  selected: boolean
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
    <group ref={group} position={[stage?.position.x ?? 0, 0.6, (stage?.position.z ?? 0) - 0.15]}>
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
      <Html center distanceFactor={12} position={[0, 1.18, 0]}>
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
      <Html center distanceFactor={18} position={[0, 0.5, 0]}>
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
  const color = boss.mode === 'intervene' ? '#d93f3f' : boss.mode === 'inspect' ? '#ba7517' : '#3c3489'
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
      <Html center distanceFactor={12} position={[0, 1.6, 0]}>
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

function Scene() {
  const snapshot = useMedusaStore(selectSnapshot)
  const selectedWorkerId = useMedusaStore((state) => state.selectedWorkerId)
  if (!snapshot) return null
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#eef2f7" />
      </mesh>
      <gridHelper args={[30, 30, '#c3ccd9', '#dde3ec']} position={[0, 0, 0]} />
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
      {snapshot.workers.map((worker) => (
        <WorkerFigure
          key={worker.id}
          worker={worker}
          stage={snapshot.stages.find((stage) => stage.id === worker.stageId)}
          selected={selectedWorkerId === worker.id}
        />
      ))}
      {snapshot.tasks.map((task, index) => (
        <TaskCrate key={task.id} task={task} offset={((index % 3) - 1) * 0.36} />
      ))}
      <BossFigure boss={snapshot.boss} />
    </>
  )
}

export default function Workshop() {
  return (
    <Canvas shadows camera={{ position: [0, 10, 17], fov: 45 }} dpr={[1, 2]}>
      <color attach="background" args={['#eef2f7']} />
      <ambientLight intensity={1.6} />
      <directionalLight position={[6, 12, 8]} intensity={1.5} castShadow />
      <directionalLight position={[-8, 5, -6]} intensity={0.5} color="#c9d6ff" />
      <Scene />
      <OrbitControls enableDamping minDistance={8} maxDistance={40} maxPolarAngle={Math.PI / 2.1} />
    </Canvas>
  )
}
