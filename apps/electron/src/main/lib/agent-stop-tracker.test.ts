import { describe, expect, test } from 'bun:test'
import { normalizeAgentStopSource } from './agent-stop-source'
import { AgentStopTracker } from './agent-stop-tracker'

describe('Agent stop source', () => {
  test('仅接受宿主定义的停止来源，未知 renderer 输入降级为 unknown', () => {
    expect(normalizeAgentStopSource('renderer-ask-user-dismiss')).toBe('renderer-ask-user-dismiss')
    expect(normalizeAgentStopSource('work-activity-panel')).toBe('work-activity-panel')
    expect(normalizeAgentStopSource('forged-source')).toBe('unknown')
    expect(normalizeAgentStopSource(undefined)).toBe('unknown')
  })
})

describe('AgentStopTracker', () => {
  test('无活动 run 的迟到 stop 不会创建可污染下一轮的停止标记', () => {
    const tracker = new AgentStopTracker()

    expect(tracker.request('session-1', undefined, 'renderer-stop-control')).toBe(false)
    expect(tracker.consume('session-1', 2)).toBeUndefined()
  })

  test('停止标记只允许同一 run generation 消费', () => {
    const tracker = new AgentStopTracker()

    expect(tracker.request('session-1', 10, 'renderer-queue-abort')).toBe(true)
    expect(tracker.has('session-1')).toBeTrue()
    expect(tracker.consume('session-1', 11)).toBeUndefined()
    expect(tracker.has('session-1')).toBeTrue()
    expect(tracker.consume('session-1', 10)).toBe('renderer-queue-abort')
    expect(tracker.has('session-1')).toBeFalse()
    expect(tracker.consume('session-1', 10)).toBeUndefined()
  })

  test('新的活动 run 停止请求会覆盖同会话遗留记录并保留来源', () => {
    const tracker = new AgentStopTracker()

    tracker.request('session-1', 10, 'renderer-stop-control')
    tracker.request('session-1', 11, 'feishu-command')

    expect(tracker.consume('session-1', 10)).toBeUndefined()
    expect(tracker.consume('session-1', 11)).toBe('feishu-command')
  })
})
