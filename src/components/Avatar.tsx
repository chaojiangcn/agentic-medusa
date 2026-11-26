'use client'

/**
 * Built-in humanoids plus an optional GLB override.
 *
 * `human` is the default: a figure assembled from ~35 lathed/rounded parts
 * rather than stacked boxes - tapered torso, jointed arms, actual face
 * (eye whites, pupils, catchlights, brows, nose, smile curve), layered hair,
 * collar, cuffs and a lanyard badge. The other three are kept as deliberately
 * cheaper silhouettes, and a `glb:` path loads a real model when one is
 * dropped into /public/models.
 */

import { RoundedBox, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { Suspense, useMemo } from 'react'
import { Component } from 'react'
import type { ReactNode } from 'react'
import { glbUrl } from '@/lib/appearance'

const SKIN = '#f0d2b2'
const SKIN_DARK = '#e0bf9d'
const HAIR = '#3a312c'
const DARK = '#3f4450'
const STEEL = '#aab3bd'
const WHITE = '#f5f7fa'
const PANTS = '#525c70'
const SHOE = '#2f343b'

const HEAD_TOP: Record<string, number> = {
  human: 0.70,
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

/**
 * Half-silhouette of the torso, revolved around Y. Radii are narrow at the
 * waist and widest at the chest, which is what stops the figure from reading
 * as a cylinder. The lathe is squashed on Z afterwards so the body is deeper
 * than it is wide, like a person rather than a bottle.
 */
const TORSO_PROFILE: [number, number][] = [
  [0.004, -0.09],
  [0.122, -0.085],
  [0.142, -0.06],
  [0.147, -0.03],
  [0.157, 0.012],
  [0.177, 0.098],
  [0.193, 0.168],
  [0.196, 0.214],
  [0.178, 0.250],
  [0.132, 0.271],
  [0.004, 0.279],
]

const CLOTH = '#6d7793'

/** How far a seated figure has to be lifted so its soles touch the floor.
    Kept next to the rig because the scene needs the same number to seat a
    worker on a chair without measuring the geometry at runtime. */
export const SEATED_Y = 0.512

/** Standing legs: tapered thigh/calf, a slight outward stance and a two-part
    shoe. Two identical parallel boxes read as a bust on a plinth. */
function StandingLegs() {
  return (
    <group>
      {[-0.108, 0.108].map((x, i) => (
        <group
          key={`leg-${i}`}
          position={[x, 0, i === 0 ? 0.016 : -0.016]}
          rotation={[0, 0, x > 0 ? -0.035 : 0.035]}
        >
          <mesh position={[0, -0.596, 0.032]} castShadow>
            <boxGeometry args={[0.146, 0.08, 0.24]} />
            <Mat color={SHOE} roughness={0.5} metalness={0.06} />
          </mesh>
          <mesh position={[0, -0.632, 0.032]}>
            <boxGeometry args={[0.154, 0.024, 0.248]} />
            <Mat color="#f2f5f8" roughness={0.86} />
          </mesh>
          {/* toe cap, pushed forward so the shoe reads as a shoe */}
          <mesh position={[0, -0.572, 0.116]} castShadow>
            <boxGeometry args={[0.152, 0.056, 0.112]} />
            <Mat color={SHOE} roughness={0.56} />
          </mesh>
          {/* calf: narrower than the thigh */}
          <mesh position={[0, -0.468, 0]} castShadow>
            <boxGeometry args={[0.084, 0.20, 0.09]} />
            <Mat color={CLOTH} roughness={0.86} />
          </mesh>
          {/* knee */}
          <mesh position={[0, -0.373, 0.002]} castShadow>
            <sphereGeometry args={[0.047, 18, 14]} />
            <Mat color={CLOTH} roughness={0.86} />
          </mesh>
          {/* thigh: same cloth as the calf, the taper carries the shape */}
          <mesh position={[0, -0.278, 0]} castShadow>
            <boxGeometry args={[0.126, 0.192, 0.128]} />
            <Mat color={CLOTH} roughness={0.86} />
          </mesh>
          <mesh position={[0, -0.552, 0]}>
            <boxGeometry args={[0.096, 0.014, 0.104]} />
            <Mat color="#39404d" roughness={0.86} />
          </mesh>
          {/* outer seam keeps the taper legible at a distance */}
          <mesh position={[x > 0 ? 0.064 : -0.064, -0.30, 0.066]}>
            <boxGeometry args={[0.006, 0.17, 0.004]} />
            <Mat color="#525c70" roughness={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/**
 * Seated legs, built directly in the seated frame rather than rotating the
 * standing rig. The pivot is the hip (local y = -0.06), the thigh runs
 * forward, the shin drops vertically, and the sole lands at -0.512 so the
 * pelvis sits on a 0.33 m chair with both feet on the floor.
 */
function SeatedLegs() {
  return (
    <group>
      {[-0.105, 0.105].map((x, i) => (
        <group
          key={`seated-leg-${i}`}
          position={[x, -0.06, i === 0 ? 0.03 : -0.01]}
          rotation={[0, 0, x > 0 ? -0.045 : 0.045]}
        >
          {/* thigh, running forward from the hip */}
          <mesh position={[0, -0.038, 0.115]} rotation={[0.05, 0, 0]} castShadow>
            <boxGeometry args={[0.132, 0.148, 0.27]} />
            <Mat color={CLOTH} roughness={0.86} />
          </mesh>
          {/* knee */}
          <mesh position={[0, -0.072, 0.248]} castShadow>
            <sphereGeometry args={[0.052, 16, 12]} />
            <Mat color={CLOTH} roughness={0.86} />
          </mesh>
          {/* shin, back to vertical */}
          <mesh position={[0, -0.245, 0.243]} castShadow>
            <boxGeometry args={[0.09, 0.34, 0.098]} />
            <Mat color={CLOTH} roughness={0.86} />
          </mesh>
          {/* shoe + light sole */}
          <mesh position={[0, -0.404, 0.288]} castShadow>
            <boxGeometry args={[0.105, 0.062, 0.21]} />
            <Mat color={SHOE} roughness={0.5} />
          </mesh>
          <mesh position={[0, -0.442, 0.288]}>
            <boxGeometry args={[0.112, 0.02, 0.216]} />
            <Mat color="#f2f5f8" roughness={0.86} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function Human({ color, pose = 'stand' }: { color: string; pose?: 'stand' | 'sit' }) {
  const torso = useMemo(
    () => TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)),
    [],
  )

  return (
    <group>
      {pose === 'sit' ? <SeatedLegs /> : <StandingLegs />}

      {/* ---------- pelvis: a slab, not a sphere ----------
          A squashed sphere here swallowed the top of both thighs and made the
          figure read as a bust sitting on the desk. */}
      <mesh position={[0, -0.128, 0]} castShadow>
        <boxGeometry args={[0.268, 0.112, 0.198]} />
        <Mat color={PANTS} roughness={0.86} />
      </mesh>
      {/* belt + buckle: the waist should look like clothing, not a cut edge */}
      <mesh position={[0, -0.052, 0]} castShadow>
        <boxGeometry args={[0.278, 0.026, 0.206]} />
        <Mat color="#333a46" roughness={0.72} />
      </mesh>
      <mesh position={[0, -0.052, 0.107]}>
        <boxGeometry args={[0.042, 0.026, 0.008]} />
        <Mat color="#c9b27e" roughness={0.4} metalness={0.35} />
      </mesh>

      {/* ---------- torso ---------- */}
      <mesh scale={[1, 1, 0.8]} castShadow receiveShadow>
        <latheGeometry args={[torso, 36]} />
        <Mat color={color} roughness={0.62} />
      </mesh>

      {/* shoulder caps soften the arm seam */}
      {[-0.162, 0.162].map((x) => (
        <mesh key={x} position={[x, 0.206, 0]} scale={[1, 0.94, 0.94]} castShadow>
          <sphereGeometry args={[0.077, 20, 16]} />
          <Mat color={color} roughness={0.62} />
        </mesh>
      ))}

      {/* ---------- arms ---------- */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 0.226, 0.196, 0]} rotation={[0, 0, s * -0.15]}>
          <mesh position={[0, -0.082, 0]} castShadow>
            <capsuleGeometry args={[0.055, 0.13, 6, 16]} />
            <Mat color={color} roughness={0.62} />
          </mesh>
          <mesh position={[0, -0.174, 0]} castShadow>
            <sphereGeometry args={[0.053, 16, 12]} />
            <Mat color={color} roughness={0.62} />
          </mesh>
          {/* the right forearm lifts a little, so the silhouette is not a
              symmetrical monolith when seen from the default camera */}
          <group rotation={[s === 1 ? -0.42 : -0.16, 0, s * 0.03]}>
            <mesh position={[0, -0.252, 0.008]} castShadow>
              <capsuleGeometry args={[0.046, 0.112, 6, 16]} />
              <Mat color={color} roughness={0.62} />
            </mesh>
            {/* cuff */}
            <mesh position={[0, -0.315, 0.01]}>
              <cylinderGeometry args={[0.049, 0.049, 0.023, 18]} />
              <Mat color="#f4f7fa" roughness={0.7} />
            </mesh>
            {/* hand + thumb */}
            <mesh position={[0, -0.352, 0.014]} scale={[0.82, 1, 0.74]} castShadow>
              <sphereGeometry args={[0.049, 16, 12]} />
              <Mat color={SKIN} roughness={0.74} />
            </mesh>
            <mesh position={[s * 0.032, -0.348, 0.032]} rotation={[0, 0, s * -0.5]} scale={[0.7, 1, 0.7]}>
              <sphereGeometry args={[0.026, 12, 10]} />
              <Mat color={SKIN_DARK} roughness={0.76} />
            </mesh>
          </group>
        </group>
      ))}

      {/* ---------- neck ---------- */}
      <mesh position={[0, 0.286, -0.004]} castShadow>
        <cylinderGeometry args={[0.057, 0.066, 0.078, 18]} />
        <Mat color={SKIN} roughness={0.76} />
      </mesh>

      {/* open collar: two leaves + the strip of chest between them. These sit
          on the *lathed* surface, which is squashed to 0.8 on Z, so every
          decal needs a shallower Z than the torso radius suggests. */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.05, 0.25, 0.144]} rotation={[0.2, 0, s * 0.5]}>
          <boxGeometry args={[0.072, 0.052, 0.017]} />
          <Mat color="#f8fafc" roughness={0.7} />
        </mesh>
      ))}
      <mesh position={[0, 0.246, 0.14]} rotation={[0.18, 0, 0]}>
        <boxGeometry args={[0.044, 0.046, 0.014]} />
        <Mat color={SKIN} roughness={0.76} />
      </mesh>
      {/* tie */}
      <mesh position={[0, 0.19, 0.158]} rotation={[0.06, 0, 0]}>
        <boxGeometry args={[0.036, 0.082, 0.015]} />
        <Mat color="#a4574f" roughness={0.56} />
      </mesh>
      <mesh position={[0, 0.231, 0.15]} rotation={[0, 0, Math.PI / 4]}>
        <boxGeometry args={[0.05, 0.05, 0.014]} />
        <Mat color="#a4574f" roughness={0.56} />
      </mesh>

      {/* ---------- lanyard + badge ---------- */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.03, 0.19, 0.154]} rotation={[0, 0, s * 0.4]}>
          <boxGeometry args={[0.011, 0.115, 0.008]} />
          <Mat color="#4c5566" roughness={0.72} />
        </mesh>
      ))}
      <RoundedBox
        args={[0.076, 0.096, 0.013]} radius={0.008} smoothness={3}
        position={[0, 0.118, 0.156]}
      >
        <Mat color="#fbfdff" roughness={0.56} />
      </RoundedBox>
      <mesh position={[0, 0.143, 0.164]}>
        <boxGeometry args={[0.056, 0.011, 0.004]} />
        <Mat color={color} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.122, 0.164]}>
        <boxGeometry args={[0.042, 0.005, 0.003]} />
        <Mat color="#c3cbd6" roughness={0.6} />
      </mesh>

      {/* ---------- head ---------- */}
      <group position={[0, 0.478, 0]}>
        <mesh scale={[1, 1.03, 0.97]} castShadow>
          <sphereGeometry args={[0.192, 30, 22]} />
          <Mat color={SKIN} roughness={0.74} />
        </mesh>
        {/* jaw */}
        <mesh position={[0, -0.07, 0.016]} scale={[0.93, 0.78, 0.93]} castShadow>
          <sphereGeometry args={[0.155, 24, 16]} />
          <Mat color={SKIN} roughness={0.74} />
        </mesh>
        {/* ears */}
        {[-1, 1].map((s) => (
          <mesh key={s} position={[s * 0.187, -0.006, -0.004]} scale={[0.4, 1, 0.72]}>
            <sphereGeometry args={[0.05, 14, 12]} />
            <Mat color={SKIN_DARK} roughness={0.78} />
          </mesh>
        ))}
        {/* nose */}
        <mesh position={[0, -0.026, 0.182]} scale={[0.85, 1.05, 1.3]} castShadow>
          <sphereGeometry args={[0.025, 14, 12]} />
          <Mat color={SKIN} roughness={0.72} />
        </mesh>
        {/* eyes: white, iris, catchlight */}
        {[-1, 1].map((s) => (
          <group key={s} position={[s * 0.069, 0.016, 0.166]}>
            <mesh scale={[1, 1.1, 0.42]}>
              <sphereGeometry args={[0.037, 18, 14]} />
              <Mat color="#fdfefe" roughness={0.32} />
            </mesh>
            <mesh position={[0, -0.002, 0.013]} scale={[1, 1.06, 0.4]}>
              <sphereGeometry args={[0.0205, 16, 12]} />
              <Mat color="#2b2a2e" roughness={0.26} />
            </mesh>
            <mesh position={[s * -0.006, 0.007, 0.019]}>
              <sphereGeometry args={[0.0072, 10, 8]} />
              <Mat color="#ffffff" roughness={0.18} emissive="#ffffff" intensity={0.5} />
            </mesh>
          </group>
        ))}
        {/* brows */}
        {[-1, 1].map((s) => (
          <mesh key={s} position={[s * 0.071, 0.071, 0.169]} rotation={[0.12, 0, s * -0.13]}>
            <boxGeometry args={[0.06, 0.013, 0.015]} />
            <Mat color={HAIR} roughness={0.88} />
          </mesh>
        ))}
        {/* smile */}
        <mesh position={[0, -0.106, 0.163]} rotation={[0, 0, Math.PI]}>
          <torusGeometry args={[0.029, 0.0068, 8, 26, Math.PI * 0.86]} />
          <Mat color="#b8746a" roughness={0.58} />
        </mesh>

        {/* Hair: a full sphere pushed back behind the face, plus fringe slabs
            at the hairline. A hemisphere cap cannot work here - its rim always
            lands across the eyes and the figure reads as a faceless blob. */}
        <mesh position={[0, 0.022, -0.04]} scale={[1.025, 1, 1]} castShadow>
          <sphereGeometry args={[0.2, 30, 22]} />
          <Mat color={HAIR} roughness={0.9} />
        </mesh>
        {[
          { x: -0.074, y: 0.112, z: 0.146, rz: 0.36, w: 0.074 },
          { x: 0.002, y: 0.132, z: 0.152, rz: 0.05, w: 0.082 },
          { x: 0.077, y: 0.108, z: 0.144, rz: -0.32, w: 0.068 },
        ].map((f, i) => (
          <RoundedBox
            key={i} args={[f.w, 0.054, 0.05]} radius={0.018} smoothness={3}
            position={[f.x, f.y, f.z]} rotation={[0.42, 0, f.rz]} castShadow
          >
            <Mat color={HAIR} roughness={0.9} />
          </RoundedBox>
        ))}
        {[-1, 1].map((s) => (
          <RoundedBox
            key={s} args={[0.024, 0.092, 0.062]} radius={0.011} smoothness={3}
            position={[s * 0.178, 0.03, 0.056]} rotation={[0, 0, s * 0.14]} castShadow
          >
            <Mat color={HAIR} roughness={0.9} />
          </RoundedBox>
        ))}
      </group>
    </group>
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

function BuiltinAvatar({ model, color, pose = 'stand' }: { model: string; color: string; pose?: 'stand' | 'sit' }) {
  switch (model) {
    case 'human': return <Human color={color} pose={pose} />
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
  model, color, boss = false, scale = 1, pose = 'stand',
}: {
  model: string
  color: string
  boss?: boolean
  scale?: number
  pose?: 'stand' | 'sit'
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
        <BuiltinAvatar model={model} color={color} pose={pose} />
      )}
      {/* Status beacon sits above every model, so state survives a swap. */}
      <mesh position={[0, headTop + 0.14, 0]}>
        <sphereGeometry args={[0.062, 12, 10]} />
        <Mat color={color} roughness={0.3} emissive={color} intensity={1.3} />
      </mesh>
      {boss && (
        <group position={[0, headTop - 0.045, 0]}>
          {/* Brim, crown and a gold band - sized to the head, not to the body. */}
          <mesh castShadow>
            <cylinderGeometry args={[0.252, 0.252, 0.024, 36]} />
            <Mat color="#2f3540" roughness={0.62} metalness={0.1} />
          </mesh>
          <mesh position={[0, 0.026, 0]}>
            <cylinderGeometry args={[0.198, 0.2, 0.03, 36]} />
            <Mat color="#8a6a3f" roughness={0.5} metalness={0.28} />
          </mesh>
          <mesh position={[0, 0.078, 0]} castShadow>
            <cylinderGeometry args={[0.168, 0.194, 0.108, 36]} />
            <Mat color="#2f3540" roughness={0.6} metalness={0.1} />
          </mesh>
        </group>
      )}
    </group>
  )
}
