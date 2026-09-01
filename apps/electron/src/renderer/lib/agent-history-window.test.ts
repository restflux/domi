import { describe, expect, test } from 'bun:test'
import {
  expandAgentHistoryWindow,
  expandAgentHistoryWindowForward,
  resolveAgentHistoryLoadDirection,
  resolveAgentHistoryNavigationRange,
  resolveAgentHistoryPreservedScrollTop,
  resolveAgentHistoryRangeForSession,
  resolveAgentHistoryWindow,
} from './agent-history-window'

const ids = (count: number, start = 0): string[] =>
  Array.from({ length: count }, (_, index) => `group-${start + index}`)

const getId = (value: string): string => value

describe('agent history window', () => {
  test('Given 普通长度历史 When 首次解析 Then 全部挂载且没有可见折叠入口所需的剩余计数', () => {
    const result = resolveAgentHistoryWindow(ids(26), null, getId)

    expect(result.mountedItems).toEqual(ids(26))
    expect(result.remainingCount).toBe(0)
    expect(result.remainingAfterCount).toBe(0)
    expect(result.anchorId).toBe('group-0')
  })

  test('Given 长历史 When 首次解析 Then 只挂载尾部窗口但不要求把派生锚点写回状态', () => {
    const result = resolveAgentHistoryWindow(ids(100), null, getId)

    expect(result.mountedItems).toEqual(ids(40, 60))
    expect(result.remainingCount).toBe(60)
    expect(result.anchorId).toBe('group-60')
    expect(result.endAnchorId).toBeNull()
  })

  test('Given 结束过渡帧暂时只有最后 live turn When 完整 persisted 历史恢复 Then 空显式 range 会重新得到完整普通历史', () => {
    const transient = resolveAgentHistoryWindow(['group-21'], null, getId)
    const restored = resolveAgentHistoryWindow(ids(22), null, getId)

    expect(transient.mountedItems).toEqual(['group-21'])
    expect(restored.mountedItems).toEqual(ids(22))
    expect(restored.remainingCount).toBe(0)
  })

  test('Given 用户向上滚动到窗口顶部 When 自动扩展 Then 新历史加入前方且保留当前结束边界', () => {
    const items = ids(100)
    const anchor = expandAgentHistoryWindow(items, 'group-60', getId)
    const result = resolveAgentHistoryWindow(items, anchor, getId)

    expect(anchor).toBe('group-20')
    expect(result.mountedItems).toEqual(ids(80, 20))
    expect(result.remainingCount).toBe(20)
  })

  test('Given 导航跳到历史中部的有界窗口 When 向下接近边界 Then 可渐进扩展后续消息', () => {
    const items = ids(120)
    const range = resolveAgentHistoryNavigationRange(items, 'group-30', getId)
    expect(range).toEqual({ startId: 'group-17', endId: 'group-57' })

    const initial = resolveAgentHistoryWindow(items, range!.startId, getId, 40, range!.endId)
    const nextEnd = expandAgentHistoryWindowForward(items, initial.endAnchorId, getId)
    const expanded = resolveAgentHistoryWindow(items, range!.startId, getId, 40, nextEnd)

    expect(initial.mountedItems).toEqual(ids(40, 17))
    expect(initial.remainingAfterCount).toBe(63)
    expect(nextEnd).toBe('group-97')
    expect(expanded.mountedItems).toEqual(ids(80, 17))
  })

  test('Given 尾部追加消息 When 用户已有显式起点 Then 已加载历史不会被新消息挤出 DOM', () => {
    const result = resolveAgentHistoryWindow(ids(110), 'group-80', getId)

    expect(result.anchorId).toBe('group-80')
    expect(result.mountedItems).toHaveLength(30)
    expect(result.mountedItems.at(-1)).toBe('group-109')
  })

  test('Given 分支替换导致显式 range 失效 When 解析 Then 安全回退到新的尾窗', () => {
    const replacementBranch = ids(75, 200)
    const result = resolveAgentHistoryWindow(replacementBranch, 'group-80', getId, 40, 'group-100')

    expect(result.mountedItems).toEqual(ids(40, 235))
    expect(result.anchorId).toBe('group-235')
    expect(result.remainingCount).toBe(35)
  })

  test('Given 顶部自动补入历史 When DOM 高度增加 Then 同一旧首消息保持原视口位置', () => {
    expect(resolveAgentHistoryPreservedScrollTop({
      previousScrollTop: 60,
      previousScrollHeight: 1_200,
      nextScrollHeight: 2_000,
      previousAnchorOffset: 40,
      nextAnchorOffset: 840,
    })).toBe(860)
    expect(resolveAgentHistoryPreservedScrollTop({
      previousScrollTop: 60,
      previousScrollHeight: 1_200,
      nextScrollHeight: 2_000,
      previousAnchorOffset: null,
      nextAnchorOffset: null,
    })).toBe(860)
  })

  test('Given 用户连续滚动接近窗口边界 When 判断加载方向 Then 顶部向上与底部向下才会自动扩展', () => {
    expect(resolveAgentHistoryLoadDirection({
      scrollTop: 80,
      scrollHeight: 2_000,
      clientHeight: 800,
      intent: 'up',
      canLoadEarlier: true,
      canLoadLater: false,
    })).toBe('earlier')
    expect(resolveAgentHistoryLoadDirection({
      scrollTop: 1_160,
      scrollHeight: 2_000,
      clientHeight: 800,
      intent: 'down',
      canLoadEarlier: false,
      canLoadLater: true,
    })).toBe('later')
    expect(resolveAgentHistoryLoadDirection({
      scrollTop: 80,
      scrollHeight: 2_000,
      clientHeight: 800,
      intent: 'down',
      canLoadEarlier: true,
      canLoadLater: false,
    })).toBeNull()
  })

  test('Given 切换会话 When 读取显式 range Then 旧会话锚点不会污染新会话或再次返回后的默认尾窗', () => {
    const stored = { sessionId: 'session-a', startId: 'group-20', endId: null }

    expect(resolveAgentHistoryRangeForSession(stored, 'session-a')).toEqual({ startId: 'group-20', endId: null })
    expect(resolveAgentHistoryRangeForSession(stored, 'session-b')).toBeNull()
    expect(resolveAgentHistoryRangeForSession(null, 'session-a')).toBeNull()
  })
})
