/**
 * TabContent — 标签内容渲染器
 *
 * 根据标签类型渲染参数化的 ChatView 或 AgentView。
 * 直接传递 sessionId/conversationId prop，无需桥接全局 atoms。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { tabsAtom } from '@/atoms/tab-atoms'
import { markdownTocPinnedAtom } from '@/atoms/markdown-toc'
import { ChatView } from '@/components/chat'
import { AgentView } from '@/components/agent'
import { PreviewTabContent } from '@/components/diff/PreviewTabContent'
import { MarkdownRichEditor } from '@/components/diff/MarkdownRichEditor'
import { MarkdownToc } from '@/components/diff/MarkdownToc'
import { TabErrorBoundary } from './TabErrorBoundary'

export interface TabContentProps {
  tabId: string
}

export function TabContent({ tabId }: TabContentProps): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const tab = tabs.find((t) => t.id === tabId)

  React.useEffect(() => {
    if (!tab) {
      console.warn(`[标签页] 未找到 tabId="${tabId}"`, { tabIds: tabs.map((item) => item.id) })
    }
  }, [tab, tabId, tabs])

  if (!tab) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        标签页不存在
      </div>
    )
  }

  if (tab.type === 'tutorial') {
    return <TutorialTabContent />
  }

  if (tab.type === 'chat') {
    return (
      <TabErrorBoundary key={tab.sessionId} sessionId={tab.sessionId}>
        <ChatView conversationId={tab.sessionId} />
      </TabErrorBoundary>
    )
  }

  if (tab.type === 'preview') {
    return (
      <TabErrorBoundary key={tab.id} sessionId={tab.sessionId}>
        <PreviewTabContent sessionId={tab.sessionId} />
      </TabErrorBoundary>
    )
  }

  return (
    <TabErrorBoundary key={tab.sessionId} sessionId={tab.sessionId}>
      <AgentView sessionId={tab.sessionId} />
    </TabErrorBoundary>
  )
}

function TutorialTabContent(): React.ReactElement {
  const [content, setContent] = React.useState('')
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [tocPinned, setTocPinned] = useAtom(markdownTocPinnedAtom)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    window.electronAPI.getTutorialContent()
      .then((result) => {
        if (result === null) {
          setLoadState('error')
          return
        }
        setContent(result)
        setLoadState('ready')
      })
      .catch((error) => {
        console.error(error)
        setLoadState('error')
      })
  }, [])

  if (loadState === 'loading') {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中...</div>
  }

  if (loadState === 'error') {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">教程加载失败</div>
  }

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <MarkdownToc
        containerRef={scrollRef as React.RefObject<HTMLElement>}
        contentKey={content.slice(0, 100)}
        enabled
        pinned={tocPinned}
        onPinnedChange={setTocPinned}
      />
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto scrollbar-thin p-8">
        <MarkdownRichEditor
          value={content}
          editing={false}
          onChange={() => {}}
          onSave={() => {}}
          onCancel={() => {}}
        />
      </div>
    </div>
  )
}
