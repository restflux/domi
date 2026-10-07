import { describe, expect, test } from 'bun:test'
import {
  SHORT_MESSAGE_THRESHOLD,
  createFallbackTitle,
  isShortTitleMessage,
  sanitizeGeneratedTitle,
} from './title-generation'

describe('isShortTitleMessage 短消息判定', () => {
  test('Given 长度不超过阈值的消息 Then 判定为短消息（直接用原文做标题，不打标题 API）', () => {
    expect(isShortTitleMessage('hi')).toBe(true)
    expect(isShortTitleMessage('你好')).toBe(true)
    expect(isShortTitleMessage('a'.repeat(SHORT_MESSAGE_THRESHOLD))).toBe(true)
  })

  test('Given 长度超过阈值的消息 Then 不判定为短消息', () => {
    expect(isShortTitleMessage('a'.repeat(SHORT_MESSAGE_THRESHOLD + 1))).toBe(false)
    expect(isShortTitleMessage('新会话的自动命名功能经常失败')).toBe(false)
  })

  test('Given 首尾带空白的短消息 Then 按去除空白后的长度判定', () => {
    expect(isShortTitleMessage('  hi  ')).toBe(true)
    expect(isShortTitleMessage(`  ${'a'.repeat(SHORT_MESSAGE_THRESHOLD + 1)}  `)).toBe(false)
  })
})

describe('createFallbackTitle 首行兜底标题', () => {
  test('Given 多行消息 Then 取第一段非空行作为标题', () => {
    expect(createFallbackTitle('\n\n帮我修一个 bug\n顺便看看日志')).toBe('帮我修一个 bug')
  })

  test('Given 带引号或 Markdown 前缀的消息 Then 清理后作为标题', () => {
    expect(createFallbackTitle('## 重构登录模块')).toBe('重构登录模块')
  })

  test('Given 超长首行 Then 截断到最大标题长度', () => {
    expect(createFallbackTitle('一'.repeat(50))).toBe('一'.repeat(20))
  })

  test('Given 空白消息 Then 返回 null', () => {
    expect(createFallbackTitle('   \n  ')).toBeNull()
  })
})

describe('sanitizeGeneratedTitle 模型标题清洗', () => {
  test('Given 推理模型返回内容块数组 Then 拼接文本并清洗', () => {
    expect(sanitizeGeneratedTitle([{ type: 'text', text: ' “登录修复” ' }])).toBe('登录修复')
  })

  test('Given 模型返回空正文（思考耗尽预算的典型表现）Then 返回 null', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull()
    expect(sanitizeGeneratedTitle([])).toBeNull()
  })

  test('Given 正常标题 Then 去除包裹符号并保留', () => {
    expect(sanitizeGeneratedTitle('「自动命名修复」')).toBe('自动命名修复')
  })
})
