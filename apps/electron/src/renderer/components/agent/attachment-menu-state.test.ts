import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAttachmentMenuTooltipOpen } from './attachment-menu-state'

describe('Agent attachment menu click-only state', () => {
  test('forces the toolbar tooltip closed while the attachment menu is open', () => {
    expect(resolveAttachmentMenuTooltipOpen(true)).toBe(false)
  })

  test('returns tooltip control to normal hover behavior after the menu closes', () => {
    expect(resolveAttachmentMenuTooltipOpen(false)).toBeUndefined()
  })

  test('the attachment menu has no hover-open or delayed-close handlers', () => {
    const source = readFileSync(resolve(import.meta.dir, 'AgentView.tsx'), 'utf8')
    const attachmentBlock = source.slice(
      source.indexOf("key: 'attach-content'"),
      source.indexOf("key: 'session-status'"),
    )

    expect(attachmentBlock).not.toContain('onPointerEnter')
    expect(attachmentBlock).not.toContain('onPointerLeave')
    expect(attachmentBlock).not.toContain('onMouseEnter')
    expect(attachmentBlock).not.toContain('onMouseLeave')
    expect(attachmentBlock).toContain('<DropdownMenu open={attachmentMenuOpen} onOpenChange={setAttachmentMenuOpen}>')
  })

  test('keeps an accessible label and suppresses the visual tooltip while the menu is open', () => {
    const source = readFileSync(resolve(import.meta.dir, 'AgentView.tsx'), 'utf8')
    const attachmentBlock = source.slice(
      source.indexOf("key: 'attach-content'"),
      source.indexOf("key: 'session-status'"),
    )

    expect(attachmentBlock).toContain('aria-label="附加文件或文件夹"')
    expect(attachmentBlock).toContain('<Tooltip open={resolveAttachmentMenuTooltipOpen(attachmentMenuOpen)}>')
    expect(attachmentBlock).toContain('<TooltipContent side="top"><p>附加文件或文件夹</p></TooltipContent>')
  })
})
