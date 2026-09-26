import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppearanceSettings } from './AppearanceSettings'

describe('Work 消息区统一视图', () => {
  test('外观设置不再提供 Work 消息版本切换，其他主题设置保持可用', () => {
    const html = renderToStaticMarkup(<AppearanceSettings />)

    expect(html).not.toContain('Work 消息视图')
    expect(html).not.toContain('V1 · 经典过程')
    expect(html).not.toContain('V2 · 工作时间线')
    expect(html).toContain('主题模式')
    expect(html).toContain('界面风格')
  })
})
