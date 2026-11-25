'use client'

/**
 * Office dressing. Everything here is procedural: no downloaded meshes, no
 * licence to track, and it all inherits the scene's lighting instead of
 * fighting it. Kept separate from Workshop.tsx because the scene graph is
 * already long enough to read like a wiring diagram.
 */

import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'

const METAL = '#a3adb9'
const DARKMETAL = '#5b6472'
const SCREEN_BEZEL = '#292f38'

/** Fake IDE lines on the monitor. x-offset, width, y, colour. */
const CODE_LINES: [number, number, number, string][] = [
  [-0.27, 0.14, 0.556, '#7fc8a9'],
  [-0.22, 0.24, 0.522, '#8fa6c8'],
  [-0.26, 0.16, 0.488, '#b7c4d4'],
  [-0.19, 0.30, 0.454, '#7fc8a9'],
  [-0.24, 0.10, 0.420, '#b7c4d4'],
  [-0.21, 0.22, 0.386, '#d7b57c'],
  [-0.25, 0.18, 0.352, '#8fa6c8'],
  [-0.22, 0.26, 0.318, '#b7c4d4'],
  [-0.26, 0.12, 0.284, '#7fc8a9'],
]

function Monitor({ x, z, accent }: { x: number; z: number; accent: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, 0.14, 0]}>
      <RoundedBox args={[0.36, 0.02, 0.2]} radius={0.005} smoothness={3} position={[0, 0.01, 0.02]} castShadow>
        <meshStandardMaterial color={DARKMETAL} roughness={0.42} metalness={0.32} />
      </RoundedBox>
      <mesh position={[0, 0.155, 0.01]} castShadow>
        <cylinderGeometry args={[0.024, 0.032, 0.29, 12]} />
        <meshStandardMaterial color={METAL} roughness={0.32} metalness={0.52} />
      </mesh>
      <RoundedBox args={[0.8, 0.47, 0.042]} radius={0.010} smoothness={3} position={[0, 0.4, 0]} castShadow>
        <meshStandardMaterial color={SCREEN_BEZEL} roughness={0.4} metalness={0.24} />
      </RoundedBox>
      <mesh position={[0, 0.4, 0.023]}>
        <planeGeometry args={[0.74, 0.41]} />
        <meshStandardMaterial
          color="#111a27"
          emissive="#2c4d7c"
          emissiveIntensity={0.6}
          roughness={0.16}
          metalness={0.12}
        />
      </mesh>
      {CODE_LINES.map(([xo, w, y, c], i) => (
        <mesh key={i} position={[xo + w / 2, y, 0.0245]}>
          <planeGeometry args={[w, 0.011]} />
          <meshBasicMaterial color={c} transparent opacity={0.72} />
        </mesh>
      ))}
      {/* window chrome + a caret blink stand-in */}
      <mesh position={[0, 0.585, 0.0245]}>
        <planeGeometry args={[0.74, 0.026]} />
        <meshBasicMaterial color={accent} transparent opacity={0.35} />
      </mesh>
      <mesh position={[-0.3, 0.26, 0.025]}>
        <planeGeometry args={[0.09, 0.011]} />
        <meshBasicMaterial color="#eaf2ff" transparent opacity={0.9} />
      </mesh>
    </group>
  )
}

function Keyboard({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, 0.05, 0]}>
      <RoundedBox args={[0.42, 0.016, 0.145]} radius={0.005} smoothness={3} position={[0, 0.008, 0]} castShadow>
        <meshStandardMaterial color="#e6ebf1" roughness={0.6} />
      </RoundedBox>
      {[0, 1, 2, 3].map((row) => (
        <mesh key={row} position={[0, 0.017, -0.048 + row * 0.032]}>
          <boxGeometry args={[0.36, 0.003, 0.022]} />
          <meshStandardMaterial color="#c4cdd8" roughness={0.72} />
        </mesh>
      ))}
    </group>
  )
}

function Mouse({ x, z, accent }: { x: number; z: number; accent: string }) {
  return (
    <group position={[x, 0, z]}>
      <RoundedBox args={[0.075, 0.034, 0.12]} radius={0.007} smoothness={4} position={[0, 0.017, 0]} castShadow>
        <meshStandardMaterial color="#f2f5f8" roughness={0.5} />
      </RoundedBox>
      <mesh position={[0, 0.036, 0.008]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.004, 0.055]} />
        <meshStandardMaterial color={accent} roughness={0.6} />
      </mesh>
    </group>
  )
}

function PaperStack({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, -0.22, 0]}>
      {[0, 1, 2].map((i) => (
        <RoundedBox
          key={i}
          args={[0.26, 0.014, 0.34]}
          radius={0.004}
          smoothness={2}
          position={[i * 0.006, 0.008 + i * 0.015, i * 0.008]}
          rotation={[0, i * 0.04, 0]}
          castShadow
        >
          <meshStandardMaterial color={i === 2 ? '#fbfcfe' : '#eef2f7'} roughness={0.85} />
        </RoundedBox>
      ))}
      <mesh position={[0.05, 0.062, 0.06]} rotation={[0, 0.6, Math.PI / 2]}>
        <cylinderGeometry args={[0.005, 0.005, 0.13, 8]} />
        <meshStandardMaterial color="#3c5480" roughness={0.5} />
      </mesh>
    </group>
  )
}

function Mug({ x, z, accent }: { x: number; z: number; accent: string }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.062, 0]} castShadow>
        <cylinderGeometry args={[0.062, 0.052, 0.124, 20]} />
        <meshStandardMaterial color="#f6f8fa" roughness={0.42} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.124, 0]}>
        <circleGeometry args={[0.056, 20]} />
        <meshStandardMaterial color="#5a3f30" roughness={0.35} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0.072, 0.062, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.032, 0.009, 8, 18]} />
        <meshStandardMaterial color="#f6f8fa" roughness={0.42} />
      </mesh>
      <mesh position={[0, 0.07, 0.0635]}>
        <planeGeometry args={[0.05, 0.016]} />
        <meshStandardMaterial color={accent} roughness={0.6} />
      </mesh>
    </group>
  )
}

function PenCup({ x, z, accent }: { x: number; z: number; accent: string }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.052, 0]} castShadow>
        <cylinderGeometry args={[0.042, 0.038, 0.104, 16]} />
        <meshStandardMaterial color="#9fa9b6" roughness={0.42} metalness={0.35} />
      </mesh>
      {[
        [0.012, 0.16, 0.08, accent],
        [-0.014, 0.15, -0.06, '#c98a4c'],
        [0.004, 0.17, 0.02, '#3c5480'],
      ].map(([dx, h, tilt, c], i) => (
        <mesh
          key={i}
          position={[dx as number, 0.06 + (h as number) / 2, (i - 1) * 0.012]}
          rotation={[0, 0, tilt as number]}
        >
          <cylinderGeometry args={[0.005, 0.005, h as number, 6]} />
          <meshStandardMaterial color={c as string} roughness={0.55} />
        </mesh>
      ))}
    </group>
  )
}

function DeskLamp({ x, z, accent }: { x: number; z: number; accent: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, -0.5, 0]}>
      <mesh position={[0, 0.012, 0]} castShadow>
        <cylinderGeometry args={[0.085, 0.095, 0.024, 20]} />
        <meshStandardMaterial color={DARKMETAL} roughness={0.45} metalness={0.3} />
      </mesh>
      <mesh position={[0.02, 0.13, 0]} rotation={[0, 0, -0.24]} castShadow>
        <cylinderGeometry args={[0.011, 0.013, 0.24, 8]} />
        <meshStandardMaterial color={METAL} roughness={0.35} metalness={0.5} />
      </mesh>
      <mesh position={[0.075, 0.25, 0]} rotation={[0, 0, 0.9]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.13, 8]} />
        <meshStandardMaterial color={METAL} roughness={0.35} metalness={0.5} />
      </mesh>
      <mesh position={[0.135, 0.27, 0]} rotation={[0, 0, 0.35]} castShadow>
        <coneGeometry args={[0.075, 0.085, 20, 1, true]} />
        <meshStandardMaterial color={accent} roughness={0.55} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0.14, 0.243, 0]}>
        <sphereGeometry args={[0.028, 12, 10]} />
        <meshStandardMaterial color="#fff3da" emissive="#ffd79a" emissiveIntensity={1.6} />
      </mesh>
      <pointLight position={[0.14, 0.22, 0]} intensity={0.55} distance={1.9} color="#ffe3b6" />
    </group>
  )
}

/** Everything that sits on one stage's desk, on top of the 0.255 surface. */
export function DeskSetup({ accent }: { accent: string }) {
  return (
    <group position={[0, 0.175, 0]}>
      <Monitor x={-0.78} z={-0.58} accent={accent} />
      <Keyboard x={-0.78} z={-0.08} />
      <Mouse x={-0.42} z={-0.06} accent={accent} />
      <PaperStack x={0.36} z={-0.56} />
      <Mug x={0.36} z={-0.08} accent={accent} />
      <PenCup x={0.68} z={-0.26} accent={accent} />
      <DeskLamp x={0.88} z={-0.54} accent={accent} />
    </group>
  )
}

export function OfficeChair({
  x, z, accent, rotation = 0,
}: { x: number; z: number; accent: string; rotation?: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {[0, 1, 2, 3, 4].map((i) => (
        <group key={i} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
          <mesh position={[0, 0.05, 0.17]} rotation={[0.14, 0, 0]} castShadow>
            <boxGeometry args={[0.05, 0.042, 0.32]} />
            <meshStandardMaterial color={DARKMETAL} roughness={0.48} metalness={0.32} />
          </mesh>
          <mesh position={[0, 0.024, 0.32]}>
            <sphereGeometry args={[0.04, 12, 10]} />
            <meshStandardMaterial color="#2f343b" roughness={0.62} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.034, 0.044, 0.3, 12]} />
        <meshStandardMaterial color={METAL} roughness={0.32} metalness={0.52} />
      </mesh>
      <RoundedBox args={[0.48, 0.1, 0.46]} radius={0.030} smoothness={4} position={[0, 0.37, 0]} castShadow>
        <meshStandardMaterial color={accent} roughness={0.74} />
      </RoundedBox>
      <mesh position={[0, 0.47, -0.2]} rotation={[-0.16, 0, 0]} castShadow>
        <boxGeometry args={[0.07, 0.2, 0.04]} />
        <meshStandardMaterial color={DARKMETAL} roughness={0.48} metalness={0.3} />
      </mesh>
      <RoundedBox
        args={[0.44, 0.42, 0.085]} radius={0.028} smoothness={4}
        position={[0, 0.63, -0.225]} rotation={[-0.14, 0, 0]} castShadow
      >
        <meshStandardMaterial color={accent} roughness={0.74} />
      </RoundedBox>
      {[-0.24, 0.24].map((sx) => (
        <group key={sx} position={[sx, 0.4, -0.02]}>
          <mesh position={[0, 0.1, 0]} castShadow>
            <boxGeometry args={[0.028, 0.2, 0.03]} />
            <meshStandardMaterial color={DARKMETAL} roughness={0.5} metalness={0.3} />
          </mesh>
          <mesh position={[0, 0.2, 0.09]} rotation={[0, 0, 0]}>
            <boxGeometry args={[0.04, 0.026, 0.2]} />
            <meshStandardMaterial color="#3d434d" roughness={0.62} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** Three linear pendants. Emissive surfaces + a faint floor pool instead of
    real point lights: the scene already spends four on the floor lamps and
    every extra light recompiles every material. */
export function CeilingPendants() {
  return (
    <group>
      {[-6.6, 0.2, 7.0].map((x) => (
        <group key={x} position={[x, 0, 0.9]}>
          {[-1.5, 1.5].map((z) => (
            <mesh key={z} position={[0, 4.4, z]}>
              <cylinderGeometry args={[0.007, 0.007, 3.2, 6]} />
              <meshStandardMaterial color={METAL} metalness={0.5} roughness={0.4} />
            </mesh>
          ))}
          <RoundedBox args={[0.22, 0.1, 3.42]} radius={0.030} smoothness={3} position={[0, 2.82, 0]} castShadow>
            <meshStandardMaterial color="#e9eef4" roughness={0.46} metalness={0.28} />
          </RoundedBox>
          <mesh position={[0, 2.764, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.185, 3.32]} />
            <meshStandardMaterial color="#fffbf2" emissive="#ffeccd" emissiveIntensity={1.6} />
          </mesh>
          <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[3.6, 2.8]} />
            <meshBasicMaterial color="#ffe9c6" transparent opacity={0.05} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

const BOOKS: [number, number, string][] = [
  [0.052, 0.24, '#9c6f6a'],
  [0.044, 0.21, '#6f849c'],
  [0.06, 0.26, '#c3a271'],
  [0.04, 0.19, '#7f9b7d'],
  [0.055, 0.23, '#8d7f9c'],
  [0.046, 0.2, '#b58a8a'],
  [0.058, 0.25, '#6d8b94'],
  [0.042, 0.18, '#a08a6c'],
]

export function Cabinet({ x, z, rotation = 0 }: { x: number; z: number; rotation?: number }) {
  const books = useMemo(() => {
    let cursor = -0.78
    return BOOKS.map(([w, h, c]) => {
      const bx = cursor + w / 2
      cursor += w + 0.006
      return { bx, w, h, c }
    })
  }, [])
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      <RoundedBox args={[1.92, 0.66, 0.44]} radius={0.028} smoothness={3} position={[0, 0.33, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#eef3f8" roughness={0.72} />
      </RoundedBox>
      <mesh position={[0, 0.66, 0]}>
        <boxGeometry args={[1.96, 0.03, 0.48]} />
        <meshStandardMaterial color="#dfe6ee" roughness={0.6} />
      </mesh>
      {[-0.48, 0.48].map((dx) => (
        <mesh key={dx} position={[dx, 0.33, 0.223]}>
          <boxGeometry args={[0.007, 0.52, 0.004]} />
          <meshStandardMaterial color="#c2ccd8" roughness={0.8} />
        </mesh>
      ))}
      {[-0.06, 0.06].map((dx) => (
        <mesh key={dx} position={[dx, 0.42, 0.228]} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[0.008, 0.1, 0.008]} />
          <meshStandardMaterial color="#9aa6b4" roughness={0.4} metalness={0.5} />
        </mesh>
      ))}
      {books.map(({ bx, w, h, c }, i) => (
        <mesh key={i} position={[bx, 0.675 + h / 2, 0.02]} rotation={[0, 0, i === BOOKS.length - 1 ? -0.16 : 0]} castShadow>
          <boxGeometry args={[w, h, 0.26]} />
          <meshStandardMaterial color={c} roughness={0.82} />
        </mesh>
      ))}
      {/* a small plant on the open half */}
      <group position={[0.62, 0.675, 0]}>
        <mesh position={[0, 0.055, 0]} castShadow>
          <cylinderGeometry args={[0.075, 0.06, 0.11, 16]} />
          <meshStandardMaterial color="#c9beb0" roughness={0.88} />
        </mesh>
        {[[0, 0.17, 0, 0.085], [0.05, 0.2, 0.02, 0.06], [-0.045, 0.19, -0.02, 0.055]].map(([lx, ly, lz, r], i) => (
          <mesh key={i} position={[lx as number, ly as number, lz as number]} castShadow>
            <icosahedronGeometry args={[r as number, 1]} />
            <meshStandardMaterial color={i % 2 ? '#79957a' : '#69876e'} roughness={0.86} flatShading />
          </mesh>
        ))}
      </group>
    </group>
  )
}

export function WallClock({ x, y, z }: { x: number; y: number; z: number }) {
  const minute = useRef<THREE.Group>(null)
  const hour = useRef<THREE.Group>(null)
  // Wall clock follows real time, so the office feels like it is running.
  useFrame(() => {
    const now = new Date()
    const m = now.getMinutes() + now.getSeconds() / 60
    const h = (now.getHours() % 12) + m / 60
    if (minute.current) minute.current.rotation.z = -(m / 60) * Math.PI * 2
    if (hour.current) hour.current.rotation.z = -(h / 12) * Math.PI * 2
  })
  return (
    <group position={[x, y, z]} rotation={[Math.PI / 2, 0, 0]}>
      <mesh castShadow>
        <cylinderGeometry args={[0.36, 0.36, 0.05, 40]} />
        <meshStandardMaterial color="#3c4450" roughness={0.5} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0.028, 0]}>
        <circleGeometry args={[0.322, 40]} />
        <meshStandardMaterial color="#fdfefe" roughness={0.6} />
      </mesh>
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2
        const big = i % 3 === 0
        return (
          <mesh key={i} position={[Math.sin(a) * 0.272, 0.031, Math.cos(a) * 0.272]} rotation={[0, -a, 0]}>
            <boxGeometry args={[big ? 0.016 : 0.009, 0.004, big ? 0.042 : 0.026]} />
            <meshStandardMaterial color="#4c5666" roughness={0.7} />
          </mesh>
        )
      })}
      <group ref={hour} position={[0, 0.036, 0]}>
        <mesh position={[0, 0, 0.075]}>
          <boxGeometry args={[0.016, 0.006, 0.15]} />
          <meshStandardMaterial color="#2f3644" roughness={0.6} />
        </mesh>
      </group>
      <group ref={minute} position={[0, 0.04, 0]}>
        <mesh position={[0, 0, 0.105]}>
          <boxGeometry args={[0.011, 0.006, 0.21]} />
          <meshStandardMaterial color="#2f3644" roughness={0.6} />
        </mesh>
      </group>
      <mesh position={[0, 0.045, 0]}>
        <cylinderGeometry args={[0.016, 0.016, 0.01, 12]} />
        <meshStandardMaterial color="#b3615c" roughness={0.5} />
      </mesh>
    </group>
  )
}

function WindowUnit({ x, y, z }: { x: number; y: number; z: number }) {
  return (
    <group position={[x, y, z]}>
      {/* sky above, softer haze at the sill: two panes read as depth */}
      <mesh position={[0, 0.42, 0]}>
        <planeGeometry args={[2.9, 1.16]} />
        <meshStandardMaterial color="#b4d2f6" emissive="#9cc4f4" emissiveIntensity={0.95} roughness={0.18} />
      </mesh>
      <mesh position={[0, -0.46, 0]}>
        <planeGeometry args={[2.9, 0.76]} />
        <meshStandardMaterial color="#d9e9fb" emissive="#c6ddf6" emissiveIntensity={0.55} roughness={0.26} />
      </mesh>
      {/* frame */}
      {[
        [0, 1.02, 3.16, 0.12],
        [0, -1.02, 3.16, 0.12],
        [-1.52, 0, 0.12, 2.16],
        [1.52, 0, 0.12, 2.16],
        [0, 0, 0.07, 2.02],
        [0, 0, 2.96, 0.07],
      ].map(([bx, by, bw, bh], i) => (
        <mesh key={i} position={[bx, by, 0.035]}>
          <boxGeometry args={[bw, bh, 0.07]} />
          <meshStandardMaterial color="#c9d5e2" roughness={0.5} metalness={0.16} />
        </mesh>
      ))}
      {/* sill */}
      <mesh position={[0, -1.08, 0.08]}>
        <boxGeometry args={[3.3, 0.07, 0.26]} />
        <meshStandardMaterial color="#eef3f8" roughness={0.7} />
      </mesh>
    </group>
  )
}

/** Back wall, side walls, skirting and two windows. Gives the floor a horizon
    so the room reads as an interior instead of objects floating in fog. */
export function RoomShell() {
  return (
    <group>
      <mesh position={[0, 2.7, -9.4]} receiveShadow>
        <planeGeometry args={[34, 6.6]} />
        <meshStandardMaterial color="#dbe3ef" roughness={0.97} />
      </mesh>
      {/* a dado line keeps the back wall from reading as one flat slab */}
      <mesh position={[0, 1.02, -9.38]}>
        <boxGeometry args={[34, 0.035, 0.02]} />
        <meshStandardMaterial color="#c5d1df" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.1, -9.36]}>
        <boxGeometry args={[34, 0.2, 0.07]} />
        <meshStandardMaterial color="#c1ccda" roughness={0.86} />
      </mesh>
      {[-13.2, 13.2].map((x) => (
        <mesh
          key={x}
          position={[x, 2.7, 0.6]}
          rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]}
          receiveShadow
        >
          <planeGeometry args={[24, 6.6]} />
          <meshStandardMaterial color="#d7e0ec" roughness={0.97} />
        </mesh>
      ))}
      <WindowUnit x={-4.9} y={2.55} z={-9.37} />
      <WindowUnit x={4.9} y={2.55} z={-9.37} />
    </group>
  )
}
