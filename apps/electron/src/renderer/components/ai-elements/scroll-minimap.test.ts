import { describe, expect, test } from 'bun:test'
import type { MinimapItem } from './scroll-minimap'
import {
  resolveMinimapDragRatio,
  resolveMinimapLogicalProgress,
  resolveMinimapLogicalTarget,
  resolveMinimapScrollbarMetrics,
  resolveMinimapThumbRatio,
  resolveMinimapWheelScrollTop,
  shouldPreserveMinimapSearchPanel,
} from './scroll-minimap'

const items: MinimapItem[] = Array.from({ length: 100 }, (_, index) => ({
  id: `group-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  preview: `消息 ${index}`,
}))

describe('ScrollMinimap search interaction', () => {
  test('Given 中文 IME 正在组合输入 When 原生候选窗触发 mouseleave Then 搜索面板保持打开', () => {
    expect(shouldPreserveMinimapSearchPanel({
      isFocused: false,
      isComposing: true,
    })).toBe(true)
  })

  test('Given 搜索框仍有焦点 When 指针暂时离开面板 Then 搜索面板保持打开', () => {
    expect(shouldPreserveMinimapSearchPanel({
      isFocused: true,
      isComposing: false,
    })).toBe(true)
  })

  test('Given 搜索框已失焦且未组合输入 When 指针离开面板 Then 允许关闭搜索面板', () => {
    expect(shouldPreserveMinimapSearchPanel({
      isFocused: false,
      isComposing: false,
    })).toBe(false)
  })
})

describe('ScrollMinimap complete-history navigation', () => {
  test('Given 同一长会话滚动经过消息疏密不同的区域 When 可见消息数量变化 Then 滑块长度保持稳定', () => {
    const sparseProgress = resolveMinimapLogicalProgress(
      items,
      new Set(['group-95']),
      'group-95',
      0.5,
    )
    const denseProgress = resolveMinimapLogicalProgress(
      items,
      new Set(['group-94', 'group-95', 'group-96']),
      'group-95',
      0.5,
    )
    const initialThumbRatio = resolveMinimapThumbRatio({
      itemCount: items.length,
      mountedItemCount: 40,
      clientHeight: 800,
      scrollHeight: 6_400,
    })
    const expandedThumbRatio = resolveMinimapThumbRatio({
      itemCount: items.length,
      mountedItemCount: 80,
      clientHeight: 800,
      scrollHeight: 12_800,
    })

    expect(sparseProgress.centerRatio).toBeCloseTo(0.955)
    expect(denseProgress.centerRatio).toBeCloseTo(0.955)
    expect(initialThumbRatio).toBeCloseTo(0.05)
    expect(expandedThumbRatio).toBeCloseTo(initialThumbRatio)
  })

  test('Given 少量超高消息已完整挂载且正文位于底部 When 计算滚动条位置 Then 使用真实像素进度贴住轨道底端', () => {
    expect(resolveMinimapScrollbarMetrics({
      hasUnmountedItems: false,
      scrollTop: 3_200,
      scrollHeight: 4_000,
      clientHeight: 800,
      logicalProgressRatio: 0.7,
      logicalThumbRatio: 0.1,
    })).toEqual({
      progressRatio: 1,
      thumbRatio: 0.2,
    })

    expect(resolveMinimapScrollbarMetrics({
      hasUnmountedItems: true,
      scrollTop: 3_200,
      scrollHeight: 4_000,
      clientHeight: 800,
      logicalProgressRatio: 0.7,
      logicalThumbRatio: 0.1,
    })).toEqual({
      progressRatio: 0.7,
      thumbRatio: 0.1,
    })
  })

  test('Given 用户拖动长会话滑块 When 指针移动 Then 比例映射覆盖实际可移动轨道并定位到消息内部', () => {
    expect(resolveMinimapDragRatio({
      startRatio: 0.5,
      pointerDelta: 360,
      trackHeight: 800,
      thumbRatio: 0.1,
    })).toBe(1)

    expect(resolveMinimapLogicalTarget(items.length, 0.955)).toEqual({
      index: 95,
      offsetRatio: 0.5,
    })
    expect(resolveMinimapLogicalTarget(items.length, 1)).toEqual({
      index: 99,
      offsetRatio: 1,
    })
  })

  test('Given 指针停在右侧滚动进度条且会话位于底部 When 向上滚轮 Then 主消息区离开底部并遵守滚动边界', () => {
    expect(resolveMinimapWheelScrollTop({
      scrollTop: 1_200,
      scrollHeight: 2_000,
      clientHeight: 800,
      deltaY: -120,
      deltaMode: 0,
    })).toBe(1_080)

    expect(resolveMinimapWheelScrollTop({
      scrollTop: 20,
      scrollHeight: 2_000,
      clientHeight: 800,
      deltaY: -3,
      deltaMode: 1,
    })).toBe(0)
  })
})
