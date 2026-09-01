import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_AGENT_QUEUE_ENTER_KIND,
  getAgentQueueKindLabel,
  getAgentQueueSubmitKind,
} from './agent-queue-enter-kind'

describe('Agent queue Enter kind setting', () => {
  test('运行中普通提交固定加入队列，不再读取旧的默认类型设置', () => {
    expect(DEFAULT_AGENT_QUEUE_ENTER_KIND).toBe('followUp')
    expect(getAgentQueueSubmitKind(false)).toBe('followUp')
  })

  test('Alt/Option+Enter 固定直接调整方向', () => {
    expect(getAgentQueueSubmitKind(true)).toBe('steering')
  })

  test('队列卡片使用面向用户的动作名称', () => {
    expect(getAgentQueueKindLabel('followUp')).toBe('加入队列')
    expect(getAgentQueueKindLabel('steering')).toBe('调整方向')
  })
})
