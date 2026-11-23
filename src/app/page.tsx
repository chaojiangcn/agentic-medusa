'use client'

import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import { UI } from '@/components/UI'
import { useMedusaStore } from '@/lib/store'

const Workshop = dynamic(() => import('@/components/Workshop'), {
  ssr: false,
  loading: () => <div className="loading">车间加载中…</div>,
})

export default function Home() {
  const connect = useMedusaStore((state) => state.connect)
  useEffect(() => {
    connect()
  }, [connect])

  return (
    <main className="app">
      <div className="canvas-layer">
        <Workshop />
      </div>
      <UI />
    </main>
  )
}
