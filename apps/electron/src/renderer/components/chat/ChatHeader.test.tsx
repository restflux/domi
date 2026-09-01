import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { ConversationProvider } from '@/contexts/session-context.tsx'
import { ChatHeader } from './ChatHeader.tsx'

describe('ChatHeader', () => {
  test('不再重复标签页标题，并把低频管理操作收进菜单', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ConversationProvider conversationId="conversation-1">
          <TooltipProvider>
            <ChatHeader conversation={{
              id: 'conversation-1',
              title: '这个对话标题只显示在标签页',
              createdAt: 1,
              updatedAt: 2,
            }} />
          </TooltipProvider>
        </ConversationProvider>
      </Provider>,
    )

    expect(html).toContain('data-session-toolbar="chat"')
    expect(html).toContain('aria-label="更多会话操作"')
    expect(html).not.toContain('这个对话标题只显示在标签页')
    expect(html).not.toContain('aria-label="编辑标题"')
    expect(html).not.toContain('置顶对话')
  })
})
