import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const shell = readFileSync(resolve(import.meta.dir, 'AppShell.tsx'), 'utf8')
const styles = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')

test('现代折叠态悬浮预览不改写保存的折叠偏好，也不卸载完整导航能力', () => {
  expect(shell).toContain('sidebarCollapsed && !isClassic && sidebarPreviewOpen && !settingsOpen')
  expect(shell).toContain('onPointerEnter={scheduleSidebarHover}')
  expect(shell).toContain('onPointerMove={(event) => {')
  expect(shell).toContain('schedulePreviewClose()')
  expect(shell).toContain('shouldCloseSidebarHoverPreview(lastPointerRef.current, bounds, popupOpen, Boolean(preview?.contains(document.activeElement)))')
  expect(shell).toContain('onFocusCapture={(event) => {')
  expect(shell).toContain('onBlurCapture={(event) => {')
  expect(shell).toContain('event.pointerType !== \'mouse\' || (isMac && event.clientY < 50)')
  expect(shell).toContain("button.getAttribute('aria-label') !== 'Domi，预览或固定展开侧边栏'")
  expect(shell).toContain("event.target.getAttribute('aria-label') !== 'Domi，预览或固定展开侧边栏'")
  expect(shell).toContain('document.addEventListener(\'pointermove\', handleOutsidePointer)')
  expect(shell).toContain('next.closest(\'[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]\')')
  expect(shell).toContain('<LeftSidebar width={clampedLeftSidebarWidth} previewExpanded noTransition />')
  expect(shell).toContain('previewRendered && (')
  expect(shell).toContain('element.inert = !previewActive')
  expect(shell).toContain('data-state={previewActive && previewShown ? \'open\' : \'closing\'}')
  expect(shell).toContain('<SidebarTitlebarToggle')
  expect(shell).toContain('setSidebarPreviewOpen(false)')
  expect(shell).toContain('setSidebarCollapsed(!sidebarCollapsed)')
})

test('浮窗的固定命中外壳不位移，动画仅作用于视觉表面且退出立即禁用交互', () => {
  expect(shell).toContain('data-sidebar-preview="true"')
  expect(shell).toContain('element.inert = !previewActive')
  expect(shell).toContain("!previewActive && 'pointer-events-none'")
  expect(shell).toContain('SIDEBAR_PREVIEW_EXIT_MS')
  expect(styles).toContain('.sidebar-hover-preview-surface[data-state="open"]')
  expect(styles).toContain('transition: opacity 160ms ease-in, transform 160ms ease-in')
  expect(styles).toContain('translateX(-8px)')
  expect(styles).toContain('@media (prefers-reduced-motion: reduce) {\n  .sidebar-hover-preview-surface { transition: none; }')
  expect(shell).toContain('requestAnimationFrame(() => setPreviewShown(true))')
})
