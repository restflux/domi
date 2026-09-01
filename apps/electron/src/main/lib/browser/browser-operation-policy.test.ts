import { describe, expect, test } from 'bun:test'
import {
  assertBrowserClickTarget,
  assertBrowserTypeInput,
  normalizeBrowserExtractText,
  resolveBrowserScrollDelta,
} from './browser-operation-policy.ts'

describe('浏览器原子操作策略', () => {
  test('Given an enabled interactive node When validating a click Then it is allowed', () => {
    expect(() => assertBrowserClickTarget({
      ref: 'e1',
      pageId: 'page-1',
      navigationEpoch: 3,
      backendDOMNodeId: 11,
      role: 'button',
      name: '继续',
    })).not.toThrow()
  })

  test('Given a disabled or non-interactive node When validating a click Then it fails closed', () => {
    expect(() => assertBrowserClickTarget({
      ref: 'e1',
      pageId: 'page-1',
      navigationEpoch: 3,
      backendDOMNodeId: 11,
      role: 'button',
      disabled: true,
    })).toThrow('不可点击')
    expect(() => assertBrowserClickTarget({
      ref: 'e2',
      pageId: 'page-1',
      navigationEpoch: 3,
      backendDOMNodeId: 12,
      role: 'paragraph',
    })).toThrow('不可点击')
  })

  test('Given an editable textbox and ordinary text When validating type Then only bounded metadata is returned', () => {
    expect(assertBrowserTypeInput({
      ref: 'e1',
      pageId: 'page-1',
      navigationEpoch: 3,
      backendDOMNodeId: 11,
      role: 'textbox',
      multiline: false,
    }, '你好 Domi')).toEqual({ text: '你好 Domi', textLength: 7 })
  })

  test('Given password, readonly, unsupported, secret-like or invalid text When validating type Then it fails closed', () => {
    const base = {
      ref: 'e1',
      pageId: 'page-1',
      navigationEpoch: 3,
      backendDOMNodeId: 11,
      role: 'textbox',
    }
    expect(() => assertBrowserTypeInput({ ...base, password: true }, 'hello')).toThrow('密码')
    expect(() => assertBrowserTypeInput({ ...base, readonly: true }, 'hello')).toThrow('只读')
    expect(() => assertBrowserTypeInput({ ...base, role: 'button' }, 'hello')).toThrow('不可输入')
    expect(() => assertBrowserTypeInput(base, 'sk-abcdefghijklmnop')).toThrow('敏感凭据')
    expect(() => assertBrowserTypeInput(base, 'hello\0world')).toThrow('控制字符')
  })

  test('Given a fixed scroll direction and distance When resolving delta Then arbitrary values are impossible', () => {
    expect(resolveBrowserScrollDelta('down', 'small', { width: 1000, height: 800 })).toEqual({ deltaX: 0, deltaY: 240 })
    expect(resolveBrowserScrollDelta('up', 'large', { width: 1000, height: 800 })).toEqual({ deltaX: 0, deltaY: -720 })
    expect(resolveBrowserScrollDelta('right', 'medium', { width: 1000, height: 800 })).toEqual({ deltaX: 500, deltaY: 0 })
  })

  test('Given extracted page text When normalizing Then whitespace is stable and output is bounded', () => {
    expect(normalizeBrowserExtractText('  hello\n\n   world  ', 100)).toEqual({ text: 'hello\nworld', truncated: false })
    expect(normalizeBrowserExtractText('abcdef', 4)).toEqual({ text: 'abcd', truncated: true })
  })
})
