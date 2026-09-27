import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppearanceSettings } from './AppearanceSettings'

describe('外观设置', () => {
  test('界面风格已统一为 V2：不再提供切换入口与特殊风格，其余设置保持可用', () => {
    const html = renderToStaticMarkup(<AppearanceSettings />)

    expect(html).not.toContain('Work 消息视图')
    expect(html).not.toContain('V1 · 经典过程')
    expect(html).not.toContain('V2 · 工作时间线')
    // 界面风格切换入口已移除（统一为 V2，不给用户切换）
    expect(html).not.toContain('界面风格')
    expect(html).not.toContain('右侧工作区 v2')
    expect(html).not.toContain('经典')
    expect(html).not.toContain('现代')
    // 特殊风格入口已隐藏
    expect(html).not.toContain('特殊风格')
    expect(html).not.toContain('云朵舞者')
    expect(html).not.toContain('晴空碧海')
    expect(html).not.toContain('旧屏微光')
    // 其余主题设置保持可用
    expect(html).toContain('主题模式')
    expect(html).toContain('浅色')
    expect(html).toContain('深色')
    expect(html).toContain('跟随系统')
    expect(html).toContain('界面缩放')
    expect(html).toContain('Markdown 字号')
  })
})
