import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Medusa · agentic 流水线车间',
  description: '把 agentic 系统抽象成一间流水线工作室：LLM 是工人，老板在里面巡逻',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
