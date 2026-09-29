import { afterEach, describe, expect, test } from 'bun:test'
import i18n, { normalizeLocale } from './i18n'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('renderer i18n', () => {
  test('normalizes unsupported locales to the default language', () => {
    expect(normalizeLocale('en-US')).toBe('en-US')
    expect(normalizeLocale('fr-FR')).toBe('zh-CN')
    expect(normalizeLocale(undefined)).toBe('zh-CN')
  })

  test('switches translated resources and supports interpolation', async () => {
    await i18n.changeLanguage('en-US')
    expect(i18n.t('common:settings')).toBe('Settings')
    expect(i18n.t('welcome:greeting', { displayName: 'Wlait', greeting: 'Good morning' })).toBe('Wlait, Good morning')

    await i18n.changeLanguage('zh-CN')
    expect(i18n.t('common:settings')).toBe('设置')
  })
})
