import { expect, test } from 'bun:test'
import { shouldCloseSidebarHoverPreview } from './sidebar-hover-preview'

const preview = { left: 0, right: 300, top: 0, bottom: 800 }

test('轨道切换为浮层时的离开事件仍落在浮层区域，不应立即关闭', () => {
  expect(shouldCloseSidebarHoverPreview({ x: 26, y: 70 }, preview, false)).toBe(false)
  expect(shouldCloseSidebarHoverPreview({ x: 170, y: 70 }, preview, false)).toBe(false)
})

test('真正离开浮层时收起，菜单交互期间保留浮层', () => {
  expect(shouldCloseSidebarHoverPreview({ x: 325, y: 70 }, preview, false)).toBe(true)
  expect(shouldCloseSidebarHoverPreview({ x: 325, y: 70 }, preview, true)).toBe(false)
  expect(shouldCloseSidebarHoverPreview({ x: 170, y: -2 }, preview, false)).toBe(true)
  expect(shouldCloseSidebarHoverPreview({ x: 26, y: 70 }, null, false)).toBe(true)
})
