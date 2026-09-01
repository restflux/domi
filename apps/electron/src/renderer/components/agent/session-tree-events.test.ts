import { describe, expect, test } from 'bun:test'
import { scrollSessionTreeMessageIntoView } from './session-tree-events'

describe('Session Tree 消息流联动', () => {
  test('浮窗节点仍按 session 和消息序号滚动消息流', () => {
    let scrollOptions: ScrollIntoViewOptions | undefined
    const message = {
      scrollIntoView: (options: ScrollIntoViewOptions) => { scrollOptions = options },
    } as HTMLElement
    const sessionRoot = {
      dataset: { agentSessionId: 'session-a' },
      querySelectorAll: (selector: string) => selector === '[data-message-role]' ? [message] : [],
    } as unknown as HTMLElement
    const otherRoot = {
      dataset: { agentSessionId: 'session-b' },
      querySelectorAll: () => [],
    } as unknown as HTMLElement
    const documentLike = {
      querySelectorAll: () => [otherRoot, sessionRoot],
    }

    expect(scrollSessionTreeMessageIntoView('session-a', 0, documentLike)).toBe(true)
    expect(scrollOptions).toEqual({ behavior: 'smooth', block: 'center' })
  })

  test('目标消息不存在时不触发滚动', () => {
    const documentLike = { querySelectorAll: () => [] }
    expect(scrollSessionTreeMessageIntoView('missing', 2, documentLike)).toBe(false)
  })
})
