'use client'

/**
 * Four built-in humanoids plus an optional GLB override. These are real
 * meshes (head, torso, limbs, face, clothing), not a capsule with a badge.
 * Status colour is passed in so a busy/blocked worker still reads at a glance.
 */

import { RoundedBox, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { Suspense, useMemo } from 'react'
import { Component } from 'react'
import type { ReactNode } from 'react'
import { glbUrl } from '@/lib/appearance'

const SKIN = '#e9cba9'
const SKIN_DARK = '#d9b592'
const HAIR = '#3c342f'
const DARK = '#3f4450'
const STEEL = '#aab3bd'
const WHITE = '#f5f7fa'

const HEAD_TOP: Record<string, number> = {
  office: 0.68,
  blocky: 0.75,
  robot: 0.86,
  capsule: 0.9,
}

function Mat({
  color, roughness = 0.62, metalness = 0.06, emissive, intensity = 0,
}: {
  color: string
  roughness?: number
  metalness?: number
  emissive?: string
  intensity?: number
}) {
  return (
    <meshStandardMaterial
      color={color}
      roughness={roughness}
      metalness={metalness}
      emissive={emissive ?? '#000000'}
      emissiveIntensity={intensity}
    />
  )
}

/** Office worker: shirt, tie, badge, parted hair, eyes and mouth. */
function Office({ color }: { color: string }) {
  return (
    <group>
      {[-0.13, 0.13].map((x) => (
        <group key={x}>
          <RoundedBox args={[0.16, 0.09, 0.26]} radius={0.03} smoothness={3} position={[x, -0.5, 0.04]} castShadow>
            <Mat color={DARK} roughness={0.5} />
          </RoundedBox>
          <mesh position={[x, -0.29, 0]} castShadow>
            <cylinderGeometry args={[0.077, 0.088, 0.44, 12]} />
            <Mat color="#4a5262" roughness={0.8} />
          </mesh>
        </group>
      ))}
      <RoundedBox args={[0.44, 0.5, 0.28]} radius={0.07} smoothness={4} position={[0, 0.02, 0]} castShadow>
        <Mat color={color} roughness={0.56} />
      </RoundedBox>
      {/* Collar, tie and the little ID badge. */}
      <mesh position={[0, 0.255, 0.142]}>
        <boxGeometry args={[0.16, 0.09, 0.012]} />
        <Mat color={WHITE} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.115, 0.146]}>
        <boxGeometry args={[0.05, 0.23, 0.014]} />
        <Mat color="#a4574f" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.225, 0.149]}>
        <coneGeometry args={[0.036, 0.07, 3]} />
        <Mat color="#a4574f" roughness={0.6} />
      </mesh>
      <mesh position={[0.14, 0.055, 0.151]}>
        <boxGeometry args={[0.095, 0.12, 0.012]} />
        <Mat color={WHITE} roughness={0.55} />
      </mesh>
      <mesh position={[0.14, 0.085, 0.158]}>
        <boxGeometry args={[0.06, 0.012, 0.004]} />
        <Mat color={color} roughness={0.5} />
      </mesh>
      {[-0.28, 0.28].map((x) => (
        <group key={x} position={[x, 0.03, 0]} rotation={[0, 0, x < 0 ? -0.12 : 0.12]}>
          <mesh castShadow>
            <capsuleGeometry args={[0.062, 0.3, 6, 12]} />
            <Mat color={color} roughness={0.58} />
          </mesh>
          <mesh position={[0, -0.22, 0]} castShadow>
            <sphereGeometry args={[0.062, 12, 10]} />
            <Mat color={SKIN} roughness={0.7} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.3, 0]}>
        <cylinderGeometry args={[0.068, 0.068, 0.09, 12]} />
        <Mat color={SKIN_DARK} roughness={0.75} />
      </mesh>
      <mesh position={[0, 0.47, 0]} castShadow>
        <sphereGeometry args={[0.2, 20, 16]} />
        <Mat color={SKIN} roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.49, 0]} castShadow>
        <sphereGeometry args={[0.205, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <Mat color={HAIR} roughness={0.85} />
      </mesh>
      <RoundedBox args={[0.36, 0.065, 0.16]} radius={0.02} smoothness={3} position={[0, 0.6, 0.09]}>
        <Mat color={HAIR} roughness={0.85} />
      </RoundedBox>
      {[-0.072, 0.072].map((x) => (
        <mesh key={x} position={[x, 0.475, 0.182]}>
          <sphereGeometry args={[0.018, 8, 8]} />
          <Mat color="#2c2a2a" roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, 0.412, 0.19]}>
        <boxGeometry args={[0.06, 0.009, 0.006]} />
        <Mat color="#a86f63" roughness={0.6} />
      </mesh>
    </group>
  )
}

/** Kenney-ish blocky character: every part is a box. */
function Blocky({ color }: { color: string }) {
  return (
    <group>
      {[-0.11, 0.11].map((x) => (
        <group key={x}>
          <mesh position={[x, -0.53, 0.03]} castShadow>
            <boxGeometry args={[0.17, 0.09, 0.22]} />
            <Mat color={DARK} roughness={0.7} />
          </mesh>
          <mesh position={[x, -0.33, 0]} castShadow>
            <boxGeometry args={[0.145, 0.38, 0.16]} />
            <Mat color="#4a5262" roughness={0.85} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.08, 0]} castShadow>
        <boxGeometry args={[0.42, 0.48, 0.27]} />
        <Mat color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0.13, 0.1, 0.14]}>
        <boxGeometry args={[0.09, 0.11, 0.012]} />
        <Mat color={WHITE} roughness={0.65} />
      </mesh>
      {[-0.27, 0.27].map((x) => (
        <group key={x} position={[x, 0.06, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.1, 0.36, 0.12]} />
            <Mat color={color} roughness={0.72} />
          </mesh>
          <mesh position={[0, -0.22, 0]} castShadow>
            <boxGeometry args={[0.105, 0.09, 0.125]} />
            <Mat color={SKIN} roughness={0.75} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[0.34, 0.33, 0.3]} />
        <Mat color={SKIN} roughness={0.75} />
      </mesh>
      <mesh position={[0, 0.665, 0]} castShadow>
        <boxGeometry args={[0.36, 0.075, 0.32]} />
        <Mat color={HAIR} roughness={0.9} />
      </mesh>
      {[-0.08, 0.08].map((x) => (
        <mesh key={x} position={[x, 0.51, 0.152]}>
          <boxGeometry args={[0.032, 0.038, 0.008]} />
          <Mat color="#2c2a2a" roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, 0.44, 0.152]}>
        <boxGeometry args={[0.07, 0.012, 0.008]} />
        <Mat color="#a86f63" roughness={0.6} />
      </mesh>
    </group>
  )
}

/** Robot: screen face, glowing joints, antenna. */
function Robot({ color }: { color: string }) {
  return (
    <group>
      {[-0.13, 0.13].map((x) => (
        <group key={x}>
          <RoundedBox args={[0.18, 0.1, 0.26]} radius={0.03} smoothness={3} position={[x, -0.51, 0.03]} castShadow>
            <Mat color={DARK} roughness={0.55} metalness={0.2} />
          </RoundedBox>
          <mesh position={[x, -0.3, 0]} castShadow>
            <cylinderGeometry args={[0.075, 0.085, 0.4, 12]} />
            <Mat color={STEEL} roughness={0.42} metalness={0.5} />
          </mesh>
          <mesh position={[x, -0.1, 0]}>
            <sphereGeometry args={[0.09, 12, 10]} />
            <Mat color={color} roughness={0.35} emissive={color} intensity={0.4} />
          </mesh>
        </group>
      ))}
      <RoundedBox args={[0.48, 0.5, 0.33]} radius={0.08} smoothness={4} position={[0, 0.04, 0]} castShadow>
        <Mat color={color} roughness={0.44} metalness={0.16} />
      </RoundedBox>
      <mesh position={[0, 0.07, 0.169]}>
        <boxGeometry args={[0.24, 0.05, 0.012]} />
        <Mat color="#dff3ff" roughness={0.3} emissive="#79c7ff" intensity={0.85} />
      </mesh>
      <mesh position={[0, -0.09, 0.17]}>
        <boxGeometry args={[0.16, 0.02, 0.012]} />
        <Mat color="#dff3ff" roughness={0.3} emissive="#79c7ff" intensity={0.45} />
      </mesh>
      {[-0.28, 0.28].map((x) => (
        <group key={x} position={[x, 0.06, 0]}>
          <mesh position={[0, 0.19, 0]}>
            <sphereGeometry args={[0.1, 12, 10]} />
            <Mat color={STEEL} roughness={0.4} metalness={0.45} />
          </mesh>
          <mesh castShadow>
            <capsuleGeometry args={[0.065, 0.28, 6, 12]} />
            <Mat color={color} roughness={0.48} metalness={0.18} />
          </mesh>
          <mesh position={[0, -0.21, 0]}>
            <sphereGeometry args={[0.07, 12, 10]} />
            <Mat color={STEEL} roughness={0.4} metalness={0.5} />
          </mesh>
        </group>
      ))}
      <RoundedBox args={[0.44, 0.38, 0.36]} radius={0.06} smoothness={4} position={[0, 0.51, 0]} castShadow>
        <Mat color="#e2e8ef" roughness={0.4} metalness={0.2} />
      </RoundedBox>
      <mesh position={[0, 0.51, 0.184]}>
        <planeGeometry args={[0.32, 0.2]} />
        <Mat color="#1d2735" roughness={0.25} emissive="#3f6bb0" intensity={0.3} />
      </mesh>
      {[-0.075, 0.075].map((x) => (
        <mesh key={x} position={[x, 0.515, 0.19]}>
          <sphereGeometry args={[0.026, 10, 8]} />
          <Mat color="#9fe8ff" roughness={0.2} emissive="#57c8ff" intensity={1.5} />
        </mesh>
      ))}
      <mesh position={[0, 0.76, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 0.16, 8]} />
        <Mat color={STEEL} roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.85, 0]}>
        <sphereGeometry args={[0.042, 12, 10]} />
        <Mat color={color} roughness={0.3} emissive={color} intensity={1.2} />
      </mesh>
    </group>
  )
}

/** The original capsule, kept as the light-weight option. */
function Capsule({ color }: { color: string }) {
  return (
    <group>
      <mesh castShadow>
        <capsuleGeometry args={[0.27, 0.48, 8, 20]} />
        <meshPhysicalMaterial color={color} roughness={0.44} metalness={0.05} clearcoat={0.35} clearcoatRoughness={0.42} />
      </mesh>
      <mesh position={[0, -0.04, 0]} castShadow>
        <torusGeometry args={[0.272, 0.024, 10, 28]} />
        <Mat color={WHITE} roughness={0.32} metalness={0.12} />
      </mesh>
      <mesh position={[0, 0.66, 0]} castShadow>
        <sphereGeometry args={[0.245, 24, 18]} />
        <meshPhysicalMaterial color={color} roughness={0.38} metalness={0.05} clearcoat={0.4} clearcoatRoughness={0.35} />
      </mesh>
      <mesh position={[0, 0.665, 0.225]}>
        <circleGeometry args={[0.135, 24]} />
        <meshStandardMaterial color="#f4f6f8" roughness={0.3} metalness={0.15} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function BuiltinAvatar({ model, color }: { model: string; color: string }) {
  switch (model) {
    case 'office': return <Office color={color} />
    case 'blocky': return <Blocky color={color} />
    case 'robot': return <Robot color={color} />
    default: return <Capsule color={color} />
  }
}

/** A GLB placed in /public/models can be used as-is. Materials are cloned so
    tinting one character never mutates another instance of the same file. */
function GlbAvatar({ url, color }: { url: string; color: string }) {
  const { scene } = useGLTF(url)
  const object = useMemo(() => {
    const clone = scene.clone(true)
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      const tint = (source: THREE.Material) => {
        const cloned = source.clone()
        const mat = cloned as THREE.MeshStandardMaterial
        if (mat.color) mat.color.lerp(new THREE.Color(color), 0.32)
        return cloned
      }
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(tint)
        : tint(mesh.material)
    })
    // Normalise to roughly the same height as the built-ins.
    const box = new THREE.Box3().setFromObject(clone)
    const size = new THREE.Vector3()
    box.getSize(size)
    const h = Math.max(size.y, 0.001)
    clone.scale.setScalar(1.3 / h)
    const center = new THREE.Vector3()
    box.getCenter(center)
    clone.position.y -= (center.y - 0.05) * (1.3 / h)
    return clone
  }, [scene, color])
  return <primitive object={object} />
}

class ModelBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export function Avatar({
  model, color, boss = false, scale = 1,
}: {
  model: string
  color: string
  boss?: boolean
  scale?: number
}) {
  const headTop = HEAD_TOP[model] ?? HEAD_TOP.capsule
  const fallback = <BuiltinAvatar model="capsule" color={color} />
  return (
    <group scale={scale}>
      {model.startsWith('glb:') ? (
        <ModelBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <GlbAvatar url={glbUrl(model)} color={color} />
          </Suspense>
        </ModelBoundary>
      ) : (
        <BuiltinAvatar model={model} color={color} />
      )}
      {/* Status beacon sits above every model, so state survives a swap. */}
      <mesh position={[0, headTop + 0.14, 0]}>
        <sphereGeometry args={[0.062, 12, 10]} />
        <Mat color={color} roughness={0.3} emissive={color} intensity={1.3} />
      </mesh>
      {boss && (
        <group position={[0, headTop + 0.03, 0]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.33, 0.33, 0.07, 24]} />
            <Mat color={DARK} roughness={0.55} metalness={0.2} />
          </mesh>
          <mesh position={[0, 0.07, 0]} castShadow>
            <cylinderGeometry args={[0.24, 0.26, 0.15, 24]} />
            <Mat color={DARK} roughness={0.55} metalness={0.2} />
          </mesh>
        </group>
      )}
    </group>
  )
}
