import { describe, expect, test } from 'bun:test'
import {
  buildTurnNavigationItems,
  resolveMinimapLogicalTarget,
  resolveMinimapNavigationViewportPosition,
  resolveMinimapWheelScrollTop,
  resolveTurnBarVisualState,
  SCROLL_MINIMAP_LAYOUT_CLASSES,
} from './scroll-minimap'

describe('ZCode turn navigator in Domi', () => {
  test('Given 多组用户与助手消息 When 生成导航 Then 每个提问只对应一条横杠及问答预览', () => {
    expect(buildTurnNavigationItems([
      { id: 'u1', role: 'user', preview: '第一个问题' },
      { id: 'a1', role: 'assistant', preview: '第一次回复' },
      { id: 's1', role: 'status', preview: '状态更新' },
      { id: 'u2', role: 'user', preview: '第二个问题' },
      { id: 'a2', role: 'assistant', preview: '第二次回复' },
    ])).toEqual([
      { id: 'u1', userPreview: '第一个问题', assistantPreview: '第一次回复\n状态更新' },
      { id: 'u2', userPreview: '第二个问题', assistantPreview: '第二次回复' },
    ])
  })

  test('Given 会话从助手消息开始 When 生成导航 Then 仍可以跳到首条消息', () => {
    expect(buildTurnNavigationItems([{ id: 'a1', role: 'assistant', preview: '欢迎' }]))
      .toEqual([{ id: 'a1', userPreview: '助手消息', assistantPreview: '欢迎' }])
  })

  test('Given 指针掠过横杠 When 渲染山峰 Then 使用 ZCode 的焦点与邻近缩放梯度', () => {
    expect(resolveTurnBarVisualState(4, 4)).toEqual({ opacity: 1, scaleX: 2.6, tone: 'focus' })
    expect(resolveTurnBarVisualState(5, 4)).toEqual({ opacity: 0.86, scaleX: 1.7, tone: 'muted' })
    expect(resolveTurnBarVisualState(6, 4)).toEqual({ opacity: 0.72, scaleX: 1.25, tone: 'muted' })
    expect(resolveTurnBarVisualState(8)).toEqual({ opacity: 0.58, scaleX: 1, tone: 'muted' })
  })

  test('Given 消息区域居中 When 定位导航 Then 固定在左侧边界、消息视口垂直中心', () => {
    expect(resolveMinimapNavigationViewportPosition({ left: 240, top: 80, height: 800 }, { left: 184 }))
      .toEqual({ left: 188, top: 480 })
    expect(SCROLL_MINIMAP_LAYOUT_CLASSES.navigation).toContain('fixed')
    expect(SCROLL_MINIMAP_LAYOUT_CLASSES.progress).toContain('right-1')
  })

  test('Given 长会话只挂载局部历史 When 拖动进度条 Then 可以跳到末尾消息', () => {
    expect(resolveMinimapLogicalTarget(100, 0.955)).toEqual({ index: 95, offsetRatio: 0.5 })
    expect(resolveMinimapLogicalTarget(100, 1)).toEqual({ index: 99, offsetRatio: 1 })
  })

  test('Given 在右侧滚动条滚轮向上 When 离开底部 Then 保持在内容边界内', () => {
    expect(resolveMinimapWheelScrollTop({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800, deltaY: -120, deltaMode: 0 }))
      .toBe(1080)
  })
})
