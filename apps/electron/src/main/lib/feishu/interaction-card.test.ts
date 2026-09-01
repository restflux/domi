import { describe, expect, test } from 'bun:test'
import {
  buildFeishuInteractionCard,
  parseFeishuInteractionActionValue,
} from './interaction-card'
import type { BridgeInteractionView } from '../bridge-interaction-coordinator'

function view(overrides: Partial<BridgeInteractionView> = {}): BridgeInteractionView {
  return {
    requestId: 'request-1',
    sessionId: 'session-1',
    chatId: 'chat-1',
    generation: 1,
    kind: 'ask_user',
    title: '需要你的回答',
    prompt: '请选择范围',
    options: [
      { id: '1', label: '仅前端', actionId: 'option:1' },
      { id: '2', label: '前后端', actionId: 'option:2' },
    ],
    multiSelect: false,
    allowText: false,
    questionIndex: 0,
    questionCount: 1,
    desktopOnly: false,
    ...overrides,
  }
}

function collectButtons(node: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(node)) return node.flatMap(collectButtons)
  if (!node || typeof node !== 'object') return []
  const record = node as Record<string, unknown>
  const current = record.tag === 'button' ? [record] : []
  return [...current, ...Object.values(record).flatMap(collectButtons)]
}

describe('飞书 IM 确认卡片', () => {
  test('Given 单选请求 When 构建卡片 Then 每个按钮只携带 requestId 和受控 actionId', () => {
    const buttons = collectButtons(buildFeishuInteractionCard(view()))

    expect(buttons).toHaveLength(2)
    expect(buttons.map((button) => button.value)).toEqual([
      { kind: 'domi_bridge_interaction', requestId: 'request-1', actionId: 'option:1' },
      { kind: 'domi_bridge_interaction', requestId: 'request-1', actionId: 'option:2' },
    ])
  })

  test('Given 多选请求 When 构建卡片 Then 使用编号文本而不是错误的单击提交', () => {
    const card = buildFeishuInteractionCard(view({ multiSelect: true }))

    expect(collectButtons(card)).toHaveLength(0)
    expect(JSON.stringify(card)).toContain('直接回复多个序号')
  })

  test('Given 桌面专属请求 When 构建卡片 Then 不提供任何批准按钮', () => {
    const card = buildFeishuInteractionCard(view({ desktopOnly: true, kind: 'desktop_only' }))

    expect(collectButtons(card)).toHaveLength(0)
    expect(JSON.stringify(card)).toContain('请回 Domi 桌面处理')
  })

  test('Given 合法 callback When 解析 Then 只提取本地校验所需字段', () => {
    expect(parseFeishuInteractionActionValue({
      kind: 'domi_bridge_interaction',
      requestId: 'request-1',
      actionId: 'option:1',
      injected: 'ignored',
    })).toEqual({
      kind: 'domi_bridge_interaction',
      requestId: 'request-1',
      actionId: 'option:1',
    })
  })

  test('Given 任意或畸形 callback When 解析 Then fail closed', () => {
    expect(parseFeishuInteractionActionValue(null)).toBeNull()
    expect(parseFeishuInteractionActionValue({ kind: 'other', requestId: 'request-1', actionId: 'option:1' })).toBeNull()
    expect(parseFeishuInteractionActionValue({ kind: 'domi_bridge_interaction', requestId: '', actionId: 'option:1' })).toBeNull()
    expect(parseFeishuInteractionActionValue({ kind: 'domi_bridge_interaction', requestId: 'request-1', actionId: 1 })).toBeNull()
  })
})
