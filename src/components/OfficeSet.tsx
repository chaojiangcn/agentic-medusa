'use client'

/**
 * Studio-office kit. Everything here is procedural: no downloaded meshes, no
 * licence to track, and it all inherits the scene's lighting instead of
 * fighting it.
 *
 * The reference the room is modelled on is a white photography studio that
 * happens to have desks in it: matte white surfaces, thin metal, no visible
 * skirting, and props (plants, paper towers, binders, a plaster bust) doing
 * the work that colour usually does. So the palette here is nearly
 * monochrome on purpose - the coloured accents come from the data.
 */

import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'

/** Desk surface height. Chibi figures are ~1.3 m tall, so a life-size 0.75 m
    desk would sit at their chin; 0.58 m puts it at chest height, which is
    what the reference studio does. */
export const DESK_H = 0.55
/** Chair seat height: feet reach the floor at this height for the seated rig. */
export const SEAT_H = 0.33
export const DESK_W = 1.9
export const DESK_D = 1.25

const TOP = '#fcfdfe'
const SHELL = '#f8fafc'
const PANEL = '#eef2f7'
const METAL = '#c6cdd6'
const DARK = '#727b87'
const SCREEN = '#f6faff'

/** Fake IDE lines on the monitor: x offset, width, y, colour. */
const CODE: [number, number, number, string][] = [
  [-0.29, 0.13, 0.52, '#7fc8a9'],
  [-0.24, 0.22, 0.487, '#8fa6c8'],
  [-0.28, 0.15, 0.454, '#b7c4d4'],
  [-0.21, 0.27, 0.421, '#7fc8a9'],
  [-0.27, 0.10, 0.388, '#b7c4d4'],
  [-0.23, 0.21, 0.355, '#d7b57c'],
  [-0.27, 0.17, 0.322, '#8fa6c8'],
  [-0.24, 0.24, 0.289, '#b7c4d4'],
  [-0.28, 0.11, 0.256, '#7fc8a9'],
  [-0.25, 0.18, 0.223, '#b7c4d4'],
]

/** The worker sits on the -z side of the desk and faces +z, so the screen has
    to point at -z: originally the panel faced the camera and the seated
    worker only ever saw the back of the monitor. Rotating the whole group by
    ~180 degrees puts the lit panel in front of the worker and leaves the
    (detailed) back shell facing the room. */
function Monitor({ x, z }: { x: number; z: number }) {
  return (
    <group name="workstation-monitor" position={[x, DESK_H, z]} rotation={[0, Math.PI - 0.15, 0]}>
      <RoundedBox args={[0.3, 0.016, 0.17]} radius={0.006} smoothness={3} position={[0, 0.008, 0]} castShadow>
        <meshStandardMaterial color={PANEL} roughness={0.5} metalness={0.18} />
      </RoundedBox>
      <mesh position={[0, 0.13, -0.02]} castShadow>
        <cylinderGeometry args={[0.019, 0.026, 0.26, 12]} />
        <meshStandardMaterial color={METAL} roughness={0.36} metalness={0.5} />
      </mesh>
      <RoundedBox args={[0.7, 0.44, 0.026]} radius={0.012} smoothness={3} position={[0, 0.345, 0]} castShadow>
        <meshStandardMaterial color="#59626f" roughness={0.42} metalness={0.16} />
      </RoundedBox>

      {/* Back shell: the room looks at this side. A blank dark slab would read
          as a hole in a white studio, so give it a light housing, a brand bar,
          vents and a power LED. */}
      <RoundedBox args={[0.688, 0.428, 0.008]} radius={0.01} smoothness={3} position={[0, 0.345, -0.016]} castShadow>
        <meshStandardMaterial color="#e8edf4" roughness={0.62} metalness={0.08} />
      </RoundedBox>
      <mesh position={[0, 0.41, -0.024]}>
        <boxGeometry args={[0.12, 0.011, 0.004]} />
        <meshStandardMaterial color="#aab7c7" roughness={0.55} metalness={0.25} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, 0.3 - i * 0.015, -0.024]}>
          <boxGeometry args={[0.28, 0.004, 0.004]} />
          <meshStandardMaterial color="#c7d1de" roughness={0.72} />
        </mesh>
      ))}
      <mesh position={[0.29, 0.16, -0.024]}>
        <boxGeometry args={[0.012, 0.012, 0.004]} />
        <meshStandardMaterial color="#7fd8b4" emissive="#4fc79b" emissiveIntensity={0.9} />
      </mesh>

      {/* Screen face: local +z is world -z, i.e. toward the seated worker. */}
      <mesh name="monitor-screen" position={[0, 0.345, 0.015]}>
        <planeGeometry args={[0.66, 0.4]} />
        <meshStandardMaterial color={SCREEN} emissive="#eaf3ff" emissiveIntensity={0.7} roughness={0.2} />
      </mesh>
      <mesh position={[0, 0.545, 0.016]}>
        <planeGeometry args={[0.66, 0.022]} />
        <meshBasicMaterial color="#dfe8f4" />
      </mesh>
      {CODE.map(([xo, w, y, c], i) => (
        <mesh key={i} position={[xo + w / 2, y, 0.017]}>
          <planeGeometry args={[w, 0.011]} />
          <meshBasicMaterial color={c} transparent opacity={0.8} />
        </mesh>
      ))}
      {/* a window card in the corner keeps the screen from reading as a form */}
      <mesh position={[0.18, 0.29, 0.0175]}>
        <planeGeometry args={[0.26, 0.1]} />
        <meshBasicMaterial color="#eef6ff" transparent opacity={0.9} />
      </mesh>
    </group>
  )
}

function Keyboard({ x, z }: { x: number; z: number }) {
  return (
    <group name="workstation-keyboard" position={[x, DESK_H, z]} rotation={[0, 0.03, 0]}>
      <RoundedBox args={[0.4, 0.014, 0.14]} radius={0.005} smoothness={3} position={[0, 0.007, 0]} castShadow>
        <meshStandardMaterial color="#eef2f7" roughness={0.55} />
      </RoundedBox>
      {[0, 1, 2, 3].map((row) => (
        <mesh key={row} position={[0, 0.015, -0.045 + row * 0.03]}>
          <boxGeometry args={[0.34, 0.003, 0.02]} />
          <meshStandardMaterial color="#dfe5ee" roughness={0.7} />
        </mesh>
      ))}
    </group>
  )
}

function Mouse({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, DESK_H, z]}>
      <RoundedBox args={[0.07, 0.03, 0.11]} radius={0.014} smoothness={4} position={[0, 0.015, 0]} castShadow>
        <meshStandardMaterial color="#fbfcfd" roughness={0.5} />
      </RoundedBox>
    </group>
  )
}

function PaperStack({ x, z, layers = 4 }: { x: number; z: number; layers?: number }) {
  return (
    <group position={[x, DESK_H, z]} rotation={[0, -0.26, 0]}>
      {Array.from({ length: layers }, (_, i) => (
        <RoundedBox
          key={i}
          args={[0.24, 0.012, 0.32]}
          radius={0.002}
          smoothness={2}
          position={[i * 0.004, 0.006 + i * 0.013, i * 0.005]}
          rotation={[0, i * 0.03, 0]}
          castShadow
        >
          <meshStandardMaterial color={i === layers - 1 ? '#ffffff' : '#f3f5f9'} roughness={0.9} />
        </RoundedBox>
      ))}
    </group>
  )
}

function Mug({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, DESK_H, z]}>
      <mesh position={[0, 0.055, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.047, 0.11, 20]} />
        <meshStandardMaterial color="#ffffff" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.1105, 0]}>
        <circleGeometry args={[0.05, 20]} />
        <meshStandardMaterial color="#6b4c39" roughness={0.4} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0.063, 0.055, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.028, 0.008, 8, 16]} />
        <meshStandardMaterial color="#ffffff" roughness={0.42} />
      </mesh>
    </group>
  )
}

function PenCup({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, DESK_H, z]}>
      <mesh position={[0, 0.045, 0]} castShadow>
        <cylinderGeometry args={[0.038, 0.034, 0.09, 16]} />
        <meshStandardMaterial color="#eef2f7" roughness={0.5} metalness={0.15} />
      </mesh>
      {[
        [0.01, 0.15, 0.07, '#8a94a6'],
        [-0.012, 0.14, -0.05, '#c98a4c'],
        [0.003, 0.16, 0.02, '#5b7fa8'],
      ].map(([dx, h, tilt, c], i) => (
        <mesh key={i} position={[dx as number, 0.05 + (h as number) / 2, (i - 1) * 0.01]} rotation={[0, 0, tilt as number]}>
          <cylinderGeometry args={[0.0045, 0.0045, h as number, 6]} />
          <meshStandardMaterial color={c as string} roughness={0.55} />
        </mesh>
      ))}
    </group>
  )
}

/** A stack of ring binders: the ref image is full of these and they read as
    "work in progress" better than another cube. */
function BinderStack({ x, z }: { x: number; z: number }) {
  const colors = ['#dfe6ef', '#cfd9e6', '#e8ecf2', '#d6dfea']
  return (
    <group position={[x, DESK_H, z]} rotation={[0, 0.14, 0]}>
      {colors.map((c, i) => (
        <group key={i} position={[0, 0.026 + i * 0.048, 0]} rotation={[0, i * 0.02, 0]}>
          <RoundedBox args={[0.2, 0.044, 0.27]} radius={0.008} smoothness={3} castShadow>
            <meshStandardMaterial color={c} roughness={0.72} />
          </RoundedBox>
          <mesh position={[0.101, 0, 0]}>
            <boxGeometry args={[0.004, 0.044, 0.24]} />
            <meshStandardMaterial color="#ffffff" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function DeskPlant({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, DESK_H, z]}>
      <mesh position={[0, 0.055, 0]} castShadow>
        <cylinderGeometry args={[0.062, 0.05, 0.11, 16]} />
        <meshStandardMaterial color="#ffffff" roughness={0.55} />
      </mesh>
      {[
        [0, 0.17, 0, 0.075],
        [0.05, 0.2, 0.02, 0.055],
        [-0.045, 0.185, -0.02, 0.05],
        [0.01, 0.235, -0.03, 0.04],
      ].map(([lx, ly, lz, r], i) => (
        <mesh key={i} position={[lx as number, ly as number, lz as number]} castShadow>
          <icosahedronGeometry args={[r as number, 1]} />
          <meshStandardMaterial color={i % 2 ? '#7c9a7c' : '#6d8b71'} roughness={0.86} flatShading />
        </mesh>
      ))}
    </group>
  )
}

/** Desk + everything that lives on it. Devices are rendered by the caller so
    the scene keeps ownership of the tool data. */
export function DeskKit({ accent }: { accent: string }) {
  return (
    <group>
      {/* Desk orientation: the seated worker is at z = -0.9 and faces +z.
          So the monitor sits at the FAR edge (+z) with its screen pointing
          back at the worker, and the keyboard/mouse sit on the near edge
          between the worker and the screen. Everything else keeps to the
          right-hand half so it never blocks that sight line. */}
      <Monitor x={-0.4} z={0.4} />
      <Keyboard x={-0.4} z={-0.14} />
      <Mouse x={0.0} z={-0.12} />
      <PaperStack x={0.2} z={0.14} />
      <Mug x={0.0} z={0.38} />
      <PenCup x={0.55} z={0.3} />
      <BinderStack x={0.28} z={-0.36} />
      <DeskPlant x={0.8} z={0.04} />
      {/* a sticky note on the front edge, in the stage's accent colour */}
      <mesh position={[0.42, DESK_H + 0.002, 0.44]} rotation={[-Math.PI / 2, 0, -0.12]}>
        <planeGeometry args={[0.13, 0.13]} />
        <meshStandardMaterial color={accent} roughness={0.8} transparent opacity={0.75} />
      </mesh>
    </group>
  )
}

function DrawerUnit({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <RoundedBox args={[0.42, 0.5, 0.52]} radius={0.012} smoothness={3} position={[0, 0.25, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f4f7fa" roughness={0.62} />
      </RoundedBox>
      {[0.41, 0.265, 0.12].map((y, i) => (
        <group key={y}>
          <mesh position={[0, y, 0.262]}>
            <boxGeometry args={[0.39, 0.13, 0.012]} />
            <meshStandardMaterial color="#fbfcfd" roughness={0.5} />
          </mesh>
          <mesh position={[0, y, 0.271]}>
            <boxGeometry args={[0.14, 0.012, 0.012]} />
            <meshStandardMaterial color={METAL} roughness={0.36} metalness={0.5} />
          </mesh>
          <mesh position={[0, y + 0.055, 0.268]}>
            <boxGeometry args={[0.02, 0.004, 0.006]} />
            <meshStandardMaterial color="#c8d0da" roughness={0.7} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** White desk: thin top, two end panels, no modesty board so the seated legs
    stay visible from an angled camera. */
export function Desk({
  accent = '#dfe4ea', drawers = true,
}: { accent?: string; drawers?: boolean }) {
  const w = DESK_W
  const d = DESK_D
  return (
    <group>
      <RoundedBox args={[w, 0.042, d]} radius={0.012} smoothness={3} position={[0, DESK_H - 0.021, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={TOP} roughness={0.4} metalness={0.04} />
      </RoundedBox>
      {/* micro-bevel shadow line under the top, so it does not look like paper */}
      <mesh position={[0, DESK_H - 0.05, 0]}>
        <boxGeometry args={[w - 0.05, 0.014, d - 0.05]} />
        <meshStandardMaterial color="#e7ecf3" roughness={0.8} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (w / 2 - 0.06), (DESK_H - 0.06) / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.04, DESK_H - 0.06, d - 0.1]} />
          <meshStandardMaterial color="#f3f6fa" roughness={0.5} metalness={0.03} />
        </mesh>
      ))}
      {/* back beam */}
      <mesh position={[0, DESK_H - 0.14, -d / 2 + 0.07]} castShadow>
        <boxGeometry args={[w - 0.18, 0.075, 0.05]} />
        <meshStandardMaterial color="#eaf0f6" roughness={0.62} />
      </mesh>
      {/* accent shadow gap along the front edge - the only colour on the desk */}
      <mesh position={[0, DESK_H - 0.043, d / 2 - 0.004]}>
        <boxGeometry args={[w - 0.2, 0.006, 0.006]} />
        <meshStandardMaterial color={accent} roughness={0.5} emissive={accent} emissiveIntensity={0.45} />
      </mesh>
      {drawers && <DrawerUnit x={w / 2 - 0.32} z={-0.1} />}
    </group>
  )
}

/** Five-star task chair with casters. */
export function TaskChair({
  x = 0, z = 0, rotation = 0, accent = '#e7ebf1',
}: { x?: number; z?: number; rotation?: number; accent?: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {[0, 1, 2, 3, 4].map((i) => (
        <group key={i} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
          <mesh position={[0, 0.075, 0.165]} rotation={[0.16, 0, 0]} castShadow>
            <boxGeometry args={[0.048, 0.036, 0.3]} />
            <meshStandardMaterial color="#eef2f7" roughness={0.45} metalness={0.15} />
          </mesh>
          <mesh position={[0, 0.04, 0.315]}>
            <sphereGeometry args={[0.036, 12, 10]} />
            <meshStandardMaterial color="#b9c2cd" roughness={0.55} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.175, 0]} castShadow>
        <cylinderGeometry args={[0.032, 0.042, 0.2, 12]} />
        <meshStandardMaterial color={METAL} roughness={0.3} metalness={0.55} />
      </mesh>
      <RoundedBox args={[0.44, 0.085, 0.42]} radius={0.03} smoothness={4} position={[0, SEAT_H - 0.043, 0]} castShadow>
        <meshStandardMaterial color="#fbfcfd" roughness={0.62} />
      </RoundedBox>
      {/* back: a light shell with a visible spine */}
      <mesh position={[0, 0.44, -0.205]} rotation={[-0.16, 0, 0]} castShadow>
        <boxGeometry args={[0.05, 0.2, 0.028]} />
        <meshStandardMaterial color={METAL} roughness={0.4} metalness={0.4} />
      </mesh>
      <RoundedBox
        args={[0.46, 0.4, 0.06]} radius={0.028} smoothness={4}
        position={[0, 0.57, -0.245]} rotation={[-0.15, 0, 0]} castShadow
      >
        <meshStandardMaterial color={accent} roughness={0.66} />
      </RoundedBox>
      {[-0.215, 0.215].map((sx) => (
        <group key={sx} position={[sx, 0.36, -0.03]}>
          <mesh position={[0, 0.06, 0]} castShadow>
            <boxGeometry args={[0.026, 0.14, 0.026]} />
            <meshStandardMaterial color={METAL} roughness={0.42} metalness={0.35} />
          </mesh>
          <mesh position={[0, 0.125, 0.05]}>
            <boxGeometry args={[0.035, 0.022, 0.19]} />
            <meshStandardMaterial color="#e4e9f0" roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** Floor plant. Blades are flattened capsules fanned around a stem, which
    reads as foliage from any angle without a texture. */
export function Plant({
  x, z, scale = 1, pot = '#ffffff',
}: { x: number; z: number; scale?: number; pot?: string }) {
  const blades = useMemo(
    () => Array.from({ length: 13 }, (_, i) => {
      const a = (i / 13) * Math.PI * 2 + Math.sin(i * 2.3) * 0.5
      const tilt = 0.42 + ((i * 7) % 5) * 0.11
      const len = 0.36 + ((i * 5) % 4) * 0.06
      const lift = 0.42 + ((i * 3) % 4) * 0.13
      return { a, tilt, len, lift, tone: i % 3 }
    }),
    [],
  )
  return (
    <group position={[x, 0, z]} scale={scale}>
      <mesh position={[0, 0.19, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.19, 0.15, 0.38, 22]} />
        <meshStandardMaterial color={pot} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.381, 0]}>
        <cylinderGeometry args={[0.175, 0.175, 0.014, 22]} />
        <meshStandardMaterial color="#4e463c" roughness={1} />
      </mesh>
      {blades.map((b, i) => (
        <group key={i} position={[0, 0.39, 0]} rotation={[0, b.a, 0]}>
          <group position={[0, b.lift, 0.03]} rotation={[b.tilt, 0, 0]}>
            <mesh position={[0, b.len * 0.42, 0]} scale={[0.082, b.len, 0.02]} castShadow>
              <sphereGeometry args={[1, 8, 8]} />
              <meshStandardMaterial
                color={b.tone === 0 ? '#8fae8e' : b.tone === 1 ? '#7d9f83' : '#9cbb98'}
                roughness={0.78}
              />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  )
}

const BINDERS = ['#dfe6ef', '#cfd9e6', '#e9edf3', '#d8e1ec', '#c6d2e2', '#eef2f7']
const BOXES = ['#f7f9fc', '#eef3f9', '#f2f5f9']

/** Open shelving against the back wall: binders, archive boxes, a plant. */
export function ShelfUnit({
  x, z, rotation = 0, width = 1.7,
}: { x: number; z: number; rotation?: number; width?: number }) {
  const rows = [0.42, 0.84, 1.26, 1.68]
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (width / 2 - 0.02), 0.9, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.04, 1.8, 0.34]} />
          <meshStandardMaterial color="#f3f6fa" roughness={0.55} />
        </mesh>
      ))}
      <mesh position={[0, 1.79, 0]} castShadow>
        <boxGeometry args={[width, 0.035, 0.36]} />
        <meshStandardMaterial color="#f7f9fc" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.9, -0.16]}>
        <boxGeometry args={[width - 0.06, 1.78, 0.02]} />
        <meshStandardMaterial color="#eef3f9" roughness={0.8} />
      </mesh>
      {rows.map((y) => (
        <mesh key={y} position={[0, y, 0]} castShadow receiveShadow>
          <boxGeometry args={[width - 0.06, 0.026, 0.34]} />
          <meshStandardMaterial color="#f7f9fc" roughness={0.5} />
        </mesh>
      ))}
      {/* row 1: binders */}
      {BINDERS.slice(0, 5).map((c, i) => (
        <mesh key={c} position={[-width / 2 + 0.16 + i * 0.062, 0.42 + 0.125, 0.02]} castShadow>
          <boxGeometry args={[0.056, 0.24, 0.26]} />
          <meshStandardMaterial color={c} roughness={0.72} />
        </mesh>
      ))}
      {/* row 2: archive boxes */}
      {[0, 1].map((i) => (
        <group key={i} position={[-width / 2 + 0.32 + i * 0.46, 0.84 + 0.14, 0.01]}>
          <mesh castShadow>
            <boxGeometry args={[0.4, 0.26, 0.3]} />
            <meshStandardMaterial color={BOXES[i]} roughness={0.85} />
          </mesh>
          <mesh position={[0, 0.02, 0.151]}>
            <boxGeometry args={[0.16, 0.08, 0.004]} />
            <meshStandardMaterial color="#c9d3df" roughness={0.8} />
          </mesh>
        </group>
      ))}
      {/* row 3: a leaning stack + more binders */}
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[-width / 2 + 0.2 + i * 0.055, 1.26 + 0.12, 0.01]} rotation={[0, 0, 0.02]} castShadow>
          <boxGeometry args={[0.05, 0.23, 0.25]} />
          <meshStandardMaterial color={BINDERS[(i + 2) % BINDERS.length]} roughness={0.72} />
        </mesh>
      ))}
      <group position={[width / 2 - 0.3, 1.26, 0]}>
        <mesh position={[0, 0.075, 0]} castShadow>
          <cylinderGeometry args={[0.075, 0.062, 0.13, 16]} />
          <meshStandardMaterial color="#ffffff" roughness={0.55} />
        </mesh>
        {[[0, 0.19, 0, 0.08], [0.05, 0.22, 0.02, 0.06], [-0.05, 0.21, -0.02, 0.055]].map(([lx, ly, lz, r], i) => (
          <mesh key={i} position={[lx as number, ly as number, lz as number]} castShadow>
            <icosahedronGeometry args={[r as number, 1]} />
            <meshStandardMaterial color={i % 2 ? '#7c9a7c' : '#6d8b71'} roughness={0.86} flatShading />
          </mesh>
        ))}
      </group>
      {/* row 4: a few flat boxes */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[-0.4 + i * 0.4, 1.68 + 0.05, 0]} castShadow>
          <boxGeometry args={[0.34, 0.09, 0.26]} />
          <meshStandardMaterial color="#f4f7fb" roughness={0.85} />
        </mesh>
      ))}
    </group>
  )
}

/** Paper tower: the ref image is full of these and they sell "studio" faster
    than any furniture. */
export function PaperTower({ x, z, count = 9 }: { x: number; z: number; count?: number }) {
  return (
    <group position={[x, 0, z]}>
      {Array.from({ length: count }, (_, i) => (
        <RoundedBox
          key={i}
          args={[0.36, 0.022, 0.46]}
          radius={0.002}
          smoothness={2}
          position={[Math.sin(i * 1.7) * 0.012, 0.012 + i * 0.024, Math.cos(i * 2.1) * 0.012]}
          rotation={[0, Math.sin(i) * 0.08, 0]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color={i % 3 === 0 ? '#eef2f7' : '#fafbfd'} roughness={0.92} />
        </RoundedBox>
      ))}
    </group>
  )
}

/** Plaster bust on a plinth - the one non-furniture object in the room, and
    the thing that makes it read as a studio rather than a call centre. */
export function Bust({ x, z, rotation = 0 }: { x: number; z: number; rotation?: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.44, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.34, 0.88, 0.34]} />
        <meshStandardMaterial color="#f4f5f6" roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.885, 0]}>
        <boxGeometry args={[0.38, 0.03, 0.38]} />
        <meshStandardMaterial color="#eceded" roughness={0.7} />
      </mesh>
      <group position={[0, 0.9, 0]} rotation={[0, 0.5, 0]}>
        {/* shoulders */}
        <mesh position={[0, 0.13, 0]} scale={[1, 0.62, 0.78]} castShadow>
          <sphereGeometry args={[0.21, 22, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#f6f6f5" roughness={0.62} />
        </mesh>
        {/* neck */}
        <mesh position={[0, 0.26, 0]}>
          <cylinderGeometry args={[0.06, 0.075, 0.1, 14]} />
          <meshStandardMaterial color="#f6f6f5" roughness={0.62} />
        </mesh>
        {/* head */}
        <mesh position={[0, 0.38, 0]} scale={[0.9, 1.1, 0.92]} castShadow>
          <sphereGeometry args={[0.13, 22, 18]} />
          <meshStandardMaterial color="#f7f7f6" roughness={0.6} />
        </mesh>
        {/* nose + brow ridge: enough to read as a face in silhouette */}
        <mesh position={[0, 0.37, 0.125]} scale={[0.5, 0.9, 0.9]}>
          <sphereGeometry args={[0.022, 10, 8]} />
          <meshStandardMaterial color="#f2f2f1" roughness={0.66} />
        </mesh>
        <mesh position={[0, 0.415, 0.115]}>
          <boxGeometry args={[0.13, 0.014, 0.02]} />
          <meshStandardMaterial color="#eceae8" roughness={0.7} />
        </mesh>
      </group>
    </group>
  )
}

/** Drafting easel with a canvas: a studio prop that also fills the empty
    upper-left of the frame. */
export function Easel({ x, z, rotation = 0 }: { x: number; z: number; rotation?: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {[-0.34, 0.34].map((lx) => (
        <mesh key={lx} position={[lx, 0.66, 0]} rotation={[0, 0, lx > 0 ? -0.09 : 0.09]} castShadow>
          <boxGeometry args={[0.045, 1.34, 0.05]} />
          <meshStandardMaterial color="#e8dcc8" roughness={0.72} />
        </mesh>
      ))}
      <mesh position={[0, 0.62, 0.26]} rotation={[-0.24, 0, 0]} castShadow>
        <boxGeometry args={[0.045, 1.3, 0.045]} />
        <meshStandardMaterial color="#e8dcc8" roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.72, 0.05]} rotation={[-0.06, 0, 0]} castShadow>
        <boxGeometry args={[0.86, 0.02, 0.06]} />
        <meshStandardMaterial color="#e3d5bd" roughness={0.7} />
      </mesh>
      <group position={[0, 0.98, 0.03]} rotation={[-0.06, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.78, 0.94, 0.028]} />
          <meshStandardMaterial color="#fdfdfc" roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.06, 0.016]}>
          <planeGeometry args={[0.34, 0.5]} />
          <meshStandardMaterial color="#dfe9f2" roughness={0.9} />
        </mesh>
        <mesh position={[0.14, -0.18, 0.017]}>
          <planeGeometry args={[0.2, 0.26]} />
          <meshStandardMaterial color="#efe6d8" roughness={0.9} />
        </mesh>
      </group>
    </group>
  )
}

/** Low sideboard along the back of the studio. */
export function Credenza({ x, z, rotation = 0, width = 3.4 }: { x: number; z: number; rotation?: number; width?: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      <RoundedBox args={[width, 0.62, 0.5]} radius={0.02} smoothness={3} position={[0, 0.33, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f7f9fc" roughness={0.6} />
      </RoundedBox>
      <mesh position={[0, 0.645, 0]}>
        <boxGeometry args={[width + 0.04, 0.03, 0.54]} />
        <meshStandardMaterial color="#ffffff" roughness={0.44} />
      </mesh>
      {Array.from({ length: 3 }, (_, i) => (
        <group key={i} position={[-width / 3 + i * (width / 3), 0.33, 0.252]}>
          <mesh>
            <boxGeometry args={[width / 3 - 0.04, 0.5, 0.012]} />
            <meshStandardMaterial color="#f2f5f9" roughness={0.55} />
          </mesh>
          <mesh position={[0, 0.1, 0.008]}>
            <boxGeometry args={[0.18, 0.012, 0.012]} />
            <meshStandardMaterial color={METAL} roughness={0.4} metalness={0.45} />
          </mesh>
        </group>
      ))}
      {/* <Html>-free dressing: books, a lamp-less plant, stacks */}
      <PaperTower x={-width / 2 + 0.4} z={0.02} count={5} />
      <group position={[width / 2 - 0.55, 0.66, 0]}>
        <mesh position={[0, 0.1, 0]} castShadow>
          <cylinderGeometry args={[0.1, 0.085, 0.2, 18]} />
          <meshStandardMaterial color="#ffffff" roughness={0.5} />
        </mesh>
        {[[0, 0.3, 0, 0.11], [0.07, 0.35, 0.02, 0.08], [-0.07, 0.33, -0.03, 0.075], [0.01, 0.43, 0, 0.06]].map(([lx, ly, lz, r], i) => (
          <mesh key={i} position={[lx as number, ly as number, lz as number]} castShadow>
            <icosahedronGeometry args={[r as number, 1]} />
            <meshStandardMaterial color={i % 2 ? '#7c9a7c' : '#6d8b71'} roughness={0.86} flatShading />
          </mesh>
        ))}
      </group>
    </group>
  )
}

export function WallClock({ x, y, z }: { x: number; y: number; z: number }) {
  const minute = useRef<THREE.Group>(null)
  const hour = useRef<THREE.Group>(null)
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
        <cylinderGeometry args={[0.3, 0.3, 0.04, 40]} />
        <meshStandardMaterial color="#eef1f5" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.023, 0]}>
        <circleGeometry args={[0.268, 40]} />
        <meshStandardMaterial color="#ffffff" roughness={0.55} />
      </mesh>
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2
        const big = i % 3 === 0
        return (
          <mesh key={i} position={[Math.sin(a) * 0.222, 0.026, Math.cos(a) * 0.222]} rotation={[0, -a, 0]}>
            <boxGeometry args={[big ? 0.013 : 0.007, 0.004, big ? 0.034 : 0.02]} />
            <meshStandardMaterial color="#b9c2cd" roughness={0.7} />
          </mesh>
        )
      })}
      <group ref={hour} position={[0, 0.03, 0]}>
        <mesh position={[0, 0, 0.062]}>
          <boxGeometry args={[0.012, 0.006, 0.124]} />
          <meshStandardMaterial color="#7c8794" roughness={0.6} />
        </mesh>
      </group>
      <group ref={minute} position={[0, 0.034, 0]}>
        <mesh position={[0, 0, 0.088]}>
          <boxGeometry args={[0.009, 0.006, 0.176]} />
          <meshStandardMaterial color="#7c8794" roughness={0.6} />
        </mesh>
      </group>
      <mesh position={[0, 0.038, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 0.008, 12]} />
        <meshStandardMaterial color="#c07a72" roughness={0.6} />
      </mesh>
    </group>
  )
}

/** Seamless white studio: back wall, side walls, soft wall panels. No
    windows and no skirting - the reference room has neither. */
export function RoomShell() {
  return (
    <group>
      <mesh position={[0, 2.9, -7.8]} receiveShadow>
        <planeGeometry args={[44, 7]} />
        <meshStandardMaterial color={SHELL} roughness={0.98} />
      </mesh>
      {/* Two very pale panels give the wall a scale reference without drawing
          a rectangle the eye will latch onto. */}
      {[-4.9, 4.9].map((x) => (
        <mesh key={x} position={[x, 2.5, -7.77]}>
          <planeGeometry args={[4.4, 3.6]} />
          <meshStandardMaterial color="#f6f9fd" roughness={0.95} />
        </mesh>
      ))}
      {[-15.5, 15.5].map((x) => (
        <mesh
          key={x}
          position={[x, 2.9, -0.4]}
          rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]}
          receiveShadow
        >
          <planeGeometry args={[26, 7]} />
          <meshStandardMaterial color={SHELL} roughness={0.98} />
        </mesh>
      ))}
    </group>
  )
}

/** Archive boxes on the floor. Cheap, and they are what makes a room look
    lived-in rather than staged. */
export function BoxStack({
  x, z, rotation = 0,
}: { x: number; z: number; rotation?: number }) {
  const boxes = [
    { y: 0.14, w: 0.44, h: 0.28, d: 0.38, c: '#f8fafc', r: 0.02 },
    { y: 0.41, w: 0.38, h: 0.24, d: 0.34, c: '#eff4fa', r: -0.06 },
    { y: 0.64, w: 0.3, h: 0.18, d: 0.28, c: '#f5f8fc', r: 0.1 },
  ]
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      {boxes.map((b, i) => (
        <group key={i} position={[0, b.y, 0]} rotation={[0, b.r, 0]}>
          <RoundedBox args={[b.w, b.h, b.d]} radius={0.008} smoothness={2} castShadow receiveShadow>
            <meshStandardMaterial color={b.c} roughness={0.88} />
          </RoundedBox>
          <mesh position={[0, b.h / 2 - 0.006, 0]}>
            <boxGeometry args={[b.w + 0.004, 0.008, b.d + 0.004]} />
            <meshStandardMaterial color="#dfe7f0" roughness={0.85} />
          </mesh>
          <mesh position={[0, 0.01, b.d / 2 + 0.002]}>
            <boxGeometry args={[b.w * 0.3, b.h * 0.26, 0.004]} />
            <meshStandardMaterial color="#ffffff" roughness={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** A plain framed print. Two of them stop the back wall from reading as an
    empty white field without adding colour noise. */
export function WallArt({
  x, y, z, w = 1.1, h = 1.3,
}: { x: number; y: number; z: number; w?: number; h?: number }) {
  return (
    <group position={[x, y, z]}>
      <mesh castShadow>
        <boxGeometry args={[w, h, 0.045]} />
        <meshStandardMaterial color="#fbfcfd" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, 0.026]}>
        <planeGeometry args={[w - 0.1, h - 0.1]} />
        <meshStandardMaterial color="#eaf0f7" roughness={0.92} />
      </mesh>
      <mesh position={[-w * 0.12, h * 0.1, 0.028]}>
        <planeGeometry args={[w * 0.4, h * 0.44]} />
        <meshStandardMaterial color="#dbe6f1" roughness={0.92} />
      </mesh>
    </group>
  )
}
