import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const shell = readFileSync(resolve(import.meta.dir, 'AppShell.tsx'), 'utf8')

test('现代折叠态悬浮预览不改写保存的折叠偏好，也不卸载完整导航能力', () => {
  expect(shell).toContain('sidebarCollapsed && !isClassic && sidebarPreviewOpen && !settingsOpen')
  expect(shell).toContain('onPointerEnter={scheduleSidebarHover}')
  expect(shell).toContain('onPointerMove={(event) => {')
  expect(shell).toContain('schedulePreviewClose()')
  expect(shell).toContain('shouldCloseSidebarHoverPreview(lastPointerRef.current, bounds, popupOpen)')
  expect(shell).toContain('onFocusCapture={(event) => {')
  expect(shell).toContain('onBlurCapture={(event) => {')
  expect(shell).toContain('event.pointerType !== \'mouse\' || (isMac && event.clientY < 50)')
  expect(shell).toContain("button.getAttribute('aria-label') !== 'Domi，预览或固定展开侧边栏'")
  expect(shell).toContain("event.target.getAttribute('aria-label') !== 'Domi，预览或固定展开侧边栏'")
  expect(shell).toContain('document.addEventListener(\'pointermove\', handleOutsidePointer)')
  expect(shell).toContain('next.closest(\'[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]\')')
  expect(shell).toContain('<LeftSidebar width={clampedLeftSidebarWidth} previewExpanded noTransition />')
  expect(shell).toContain('<SidebarTitlebarToggle')
  expect(shell).toContain('setSidebarPreviewOpen(false)')
  expect(shell).toContain('setSidebarCollapsed(!sidebarCollapsed)')
})
