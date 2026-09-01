import { describe, expect, test } from 'bun:test'
import { THEME_STYLES } from './settings'

describe('特殊主题白名单', () => {
  test('给定用户选择桃岚映水时，应识别为合法特殊主题', () => {
    expect(THEME_STYLES).toContain('blossom-mist-light')
  })

  test('给定用户选择云阙新霁时，应识别为合法特殊主题', () => {
    expect(THEME_STYLES).toContain('cloud-citadel-light')
  })

  test('给定 Tailwind 构建特殊主题时，应保留所有运行时拼接的主题类', async () => {
    const config = await Bun.file(new URL('../../tailwind.config.js', import.meta.url)).text()

    for (const style of THEME_STYLES) {
      if (style === 'default') continue
      expect(config).toContain(`'theme-${style}'`)
    }
  })
})
