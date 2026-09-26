import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppearanceSettings } from './AppearanceSettings'

describe('Work 消息视图切换入口', () => {
  test('外观设置同时提供 V1 和 V2，明确说明只切换 Work 消息呈现', () => {
    const html = renderToStaticMarkup(<AppearanceSettings />)

    expect(html).toContain('Work 消息视图')
    expect(html).toContain('V1 · 经典过程')
    expect(html).toContain('V2 · 工作时间线')
    expect(html).toContain('随时可切回 V1')
  })
})
