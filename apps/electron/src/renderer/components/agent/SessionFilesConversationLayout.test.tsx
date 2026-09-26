import { describe, expect, test } from 'bun:test'
import React from 'react'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { sessionFilesPopoverReservationMapAtom } from '@/atoms/right-workspace-atoms'
import { SessionFilesConversationLayout } from './SessionFilesConversationLayout'

function renderLayout(sessionId: string, store: ReturnType<typeof createStore>): string {
  return renderToStaticMarkup(
    <Provider store={store}>
      <SessionFilesConversationLayout sessionId={sessionId}>
        <div className="conversation-column mx-auto">
          <div data-messages>消息</div>
          <div data-composer>输入框</div>
        </div>
      </SessionFilesConversationLayout>
    </Provider>,
  )
}

describe('会话文件浮窗的消息布局', () => {
  test('Given 当前会话打开浮窗且空间足够 Then 消息和输入框共同在扣除卡片宽度的区域居中', () => {
    const store = createStore()
    store.set(sessionFilesPopoverReservationMapAtom, new Map([['active', 369]]))
    const html = renderLayout('active', store)
    expect(html).toContain('style="padding-right:369px"')
    expect(html).toContain('conversation-column mx-auto')
    expect(html).toContain('data-messages')
    expect(html).toContain('data-composer')
  })

  test('Given 浮窗关闭或是其他会话的浮窗 Then 当前会话恢复原有居中区域', () => {
    const store = createStore()
    store.set(sessionFilesPopoverReservationMapAtom, new Map([['active', 369]]))
    expect(renderLayout('active', store)).toContain('padding-right:369px')
    store.set(sessionFilesPopoverReservationMapAtom, new Map())
    expect(renderLayout('active', store)).not.toContain('padding-right')
    store.set(sessionFilesPopoverReservationMapAtom, new Map([['other', 369]]))
    expect(renderLayout('active', store)).not.toContain('padding-right')
  })
})
