import { expect, test } from 'bun:test'
import { shouldCloseSidebarHoverPreview, shouldRenderSidebarHoverPreview } from './sidebar-hover-preview'

const preview = { left: 0, right: 300, top: 0, bottom: 800 }

test('退出动画只在现代折叠态保留浮窗；固定展开、设置或经典立即卸载', () => {
  expect(shouldRenderSidebarHoverPreview(true, false, true, false, false)).toBe(true)
  expect(shouldRenderSidebarHoverPreview(false, true, true, false, false)).toBe(true)
  expect(shouldRenderSidebarHoverPreview(true, true, false, false, false)).toBe(false)
  expect(shouldRenderSidebarHoverPreview(false, true, true, false, true)).toBe(false)
  expect(shouldRenderSidebarHoverPreview(false, true, true, true, false)).toBe(false)
  expect(shouldRenderSidebarHoverPreview(false, false, true, false, false)).toBe(false)
})

test('轨道切换为浮层时的离开事件仍落在浮层区域，不应立即关闭', () => {
  expect(shouldCloseSidebarHoverPreview({ x: 26, y: 70 }, preview, false)).toBe(false)
  expect(shouldCloseSidebarHoverPreview({ x: 170, y: 70 }, preview, false)).toBe(false)
})

test('真正离开浮层时收起，菜单或浮层内焦点仍在时保留浮层', () => {
  expect(shouldCloseSidebarHoverPreview({ x: 325, y: 70 }, preview, false)).toBe(true)
  expect(shouldCloseSidebarHoverPreview({ x: 325, y: 70 }, preview, true)).toBe(false)
  expect(shouldCloseSidebarHoverPreview({ x: 325, y: 70 }, preview, false, true)).toBe(false)
  expect(shouldCloseSidebarHoverPreview({ x: 170, y: -2 }, preview, false)).toBe(true)
  expect(shouldCloseSidebarHoverPreview({ x: 26, y: 70 }, null, false)).toBe(true)
})
