import { describe, expect, test } from 'bun:test'
import {
  hasChromeDevtoolsIntent,
  shouldInjectChromeDevtoolsMcp,
  shouldRequireChromeDevtoolsRestartForQueuedMessage,
} from './chrome-devtools-intent'

describe('Chrome DevTools 意图判定', () => {
  test.each([
    '请用浏览器打开这个页面并截图',
    '检查网页的控制台报错和网络请求',
    '给这个网站跑一次性能分析',
    '点击页面元素并输入测试账号',
    '找出无法点击的元素',
  ])('Given 中文浏览器需求 %s When 判定意图 Then 命中', (message) => {
    expect(hasChromeDevtoolsIntent(message)).toBe(true)
  })

  test.each([
    'Open this website in Chrome and take a screenshot',
    'Use DevTools to inspect the element',
    'Check the browser console and network requests',
    'Run a Lighthouse performance audit',
    'Analyze page performance and click the element',
  ])('Given 英文浏览器需求 %s When 判定意图 Then 命中', (message) => {
    expect(hasChromeDevtoolsIntent(message)).toBe(true)
  })

  test.each([
    '修复 agent-orchestrator.ts 的类型错误并补单测',
    'Refactor the retry policy and run the focused unit test',
    '为 API 增加参数校验，不要修改无关文件',
    '优化 page.tsx 的点击事件性能',
    '修复这个页面组件的 DOM diff 问题',
    'Refactor click handler in page.tsx',
    'Improve element rendering performance',
    'Refactor the network request handler',
    '升级 Element Plus 组件',
  ])('Given 普通 coding 消息 %s When 判定意图 Then 不命中', (message) => {
    expect(hasChromeDevtoolsIntent(message)).toBe(false)
  })

  test.each(['', '   ', '\n\t'])('Given 空消息 When 判定意图 Then 不命中', (message) => {
    expect(hasChromeDevtoolsIntent(message)).toBe(false)
  })

  test.each([
    '检查 http://localhost:3000',
    '看看 https://example.com 是否正常',
  ])('Given 新 run 消息仅包含浏览器地址 %s When 判定意图 Then 预加载 Chrome', (message) => {
    expect(hasChromeDevtoolsIntent(message)).toBe(true)
  })

  test('Given 开关关闭 When 消息有浏览器意图 Then 不注入', () => {
    expect(shouldInjectChromeDevtoolsMcp(false, '请用浏览器截图')).toBe(false)
  })

  test('Given 开关启用但无浏览器意图 When 判断注入 Then 不注入', () => {
    expect(shouldInjectChromeDevtoolsMcp(true, '修复这个 TypeScript 类型错误')).toBe(false)
  })

  test('Given 开关启用且显式提及 MCP When 消息无关键词 Then 注入', () => {
    expect(shouldInjectChromeDevtoolsMcp(true, '用这个看看', true)).toBe(true)
  })

  test('Given active run 未加载 Chrome When 队列消息请求浏览器 Then 要求重启工具集', () => {
    expect(shouldRequireChromeDevtoolsRestartForQueuedMessage(
      true,
      '请用浏览器截图',
      false,
      false,
    )).toBe(true)
  })

  test('Given active run 已加载 Chrome When 队列消息请求浏览器 Then 允许继续', () => {
    expect(shouldRequireChromeDevtoolsRestartForQueuedMessage(
      true,
      '请用浏览器截图',
      false,
      true,
    )).toBe(false)
  })

  test('Given 队列消息没有浏览器意图 When active run 未加载 Chrome Then 不阻止普通消息', () => {
    expect(shouldRequireChromeDevtoolsRestartForQueuedMessage(
      true,
      '继续修复这个类型错误',
      false,
      false,
    )).toBe(false)
  })

  test.each([
    '这个 API 是 https://example.com/v1',
    '继续处理 localhost:3000 的配置常量',
  ])('Given queued 消息仅顺带包含地址 %s When active run 未加载 Chrome Then 不误阻', (message) => {
    expect(shouldRequireChromeDevtoolsRestartForQueuedMessage(
      true,
      message,
      false,
      false,
    )).toBe(false)
  })
})
