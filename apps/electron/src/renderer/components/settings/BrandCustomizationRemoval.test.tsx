import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppearanceSettings } from './AppearanceSettings.tsx'
import { BotHubSettings } from './BotHubSettings.tsx'

describe('旧品牌自定义入口', () => {
  test('外观设置不再展示旧应用图标选择器', () => {
    const html = renderToStaticMarkup(<AppearanceSettings />)

    expect(html).not.toContain('应用图标')
    expect(html).not.toContain('自定义 Dock 栏中的应用图标样式')
  })

  test('远程连接不再展示旧品牌素材页', () => {
    const html = renderToStaticMarkup(<BotHubSettings />)

    expect(html).not.toContain('品牌素材')
    expect(html).not.toContain('品牌 Logo')
  })
})
