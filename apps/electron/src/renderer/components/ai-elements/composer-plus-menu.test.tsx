import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerPlusMenu } from './composer-plus-menu.tsx'

const tools = {
  onAttachFile: () => {},
  onAttachDirectory: () => {},
  onOpenStatus: () => {},
  minimalPresetEnabled: false,
  presetDisabled: false,
  onSetPreset: () => {},
}

describe('ComposerPlusMenu', () => {
  test('现代 Work 未选择渠道时「+」入口仍可打开以查看会话状态', () => {
    const html = renderToStaticMarkup(<ComposerPlusMenu tools={tools} disabled />)
    expect(html).toContain('aria-label="更多输入工具"')
    expect(html).not.toContain(' disabled=""')
  })

  test('现代 Work 需要处理时在「+」入口标记状态', () => {
    const html = renderToStaticMarkup(<ComposerPlusMenu tools={{ ...tools, statusNeedsAttention: true }} />)
    expect(html).toContain('aria-label="更多输入工具，会话需要处理"')
    expect(html).toContain('bg-amber-500')
  })

  test('Chat 与经典界面的引用菜单继续遵守禁用状态', () => {
    const html = renderToStaticMarkup(<ComposerPlusMenu disabled />)
    expect(html).toContain('aria-label="插入引用或调用"')
    expect(html).toContain('disabled=""')
  })
})
