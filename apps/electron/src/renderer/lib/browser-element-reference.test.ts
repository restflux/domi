import { describe, expect, test } from 'bun:test'
import { createBrowserQuotedSelection } from './browser-element-reference'

describe('网页元素输入引用', () => {
  test('Given Main 校验后的元素 When 插入 Work 输入 Then 保留最小语义身份且不自动扩展敏感字段', () => {
    const quoted = createBrowserQuotedSelection({
      browserSessionId: 'browser-1',
      ownerSessionId: 'session-1',
      pageId: 'page-1',
      navigationEpoch: 3,
      pageTitle: 'Web form',
      pageUrl: 'https://example.com/form',
      tagName: 'button',
      role: 'button',
      name: 'Submit',
      text: 'Submit',
      truncated: false,
      contentTrust: 'untrusted-web-content',
    }, 42)

    expect(quoted).toMatchObject({
      text: 'Submit',
      filePath: 'https://example.com/form',
      sourceType: 'browser-element',
      sourceLabel: 'Web form · button · Submit',
      capturedAt: 42,
    })
    expect(quoted.browserElement).not.toHaveProperty('selector')
    expect(quoted.browserElement).not.toHaveProperty('value')
  })

  test('Given a form control without visible text When inserting Then only role or tag is used as the safe card text', () => {
    const quoted = createBrowserQuotedSelection({
      browserSessionId: 'browser-1',
      ownerSessionId: 'session-1',
      pageId: 'page-1',
      navigationEpoch: 3,
      pageTitle: '',
      pageUrl: 'https://example.com/form',
      tagName: 'input',
      role: 'textbox',
      text: '',
      truncated: false,
      contentTrust: 'untrusted-web-content',
    }, 42)

    expect(quoted.text).toBe('textbox 元素')
    expect(quoted.sourceLabel).toBe('网页 · textbox')
  })
})
