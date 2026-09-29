/**
 * AppearanceSettings - 外观设置页
 *
 * 主题模式切换（浅色/深色/跟随系统）+ 界面缩放 + Markdown 字号。
 * 界面风格已统一为 V2，特殊风格入口已隐藏；
 * 通过 Jotai atom 管理状态，持久化到 ~/.domi/settings.json。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import '@/i18n'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
} from './primitives'
import {
  themeModeAtom,
  updateThemeMode,
} from '@/atoms/theme'
import {
  markdownFontSizeAtom,
  updateMarkdownFontSize,
} from '@/atoms/markdown-font-size'
import type { ThemeMode, MarkdownFontSize } from '../../../types'

/** 根据语言生成主题选项 */
function getThemeOptions(t: TFunction<'settings'>): Array<{ value: string; label: string }> {
  const translate = t as unknown as (key: string) => string
  return [
    { value: 'light', label: translate('light') },
    { value: 'dark', label: translate('dark') },
    { value: 'system', label: translate('system') },
  ]
}

/** 根据语言生成 Markdown 字号选项 */
function getMarkdownFontSizeOptions(t: TFunction<'settings'>): Array<{ value: string; label: string }> {
  const translate = t as unknown as (key: string) => string
  return [
    { value: 'small', label: translate('small') },
    { value: 'medium', label: translate('medium') },
    { value: 'large', label: translate('large') },
  ]
}

/** 根据平台返回缩放快捷键提示 */
const isMac = navigator.userAgent.includes('Mac')
const ZOOM_HINT_KEY: 'zoomHintMac' | 'zoomHintWindows' = isMac ? 'zoomHintMac' : 'zoomHintWindows'

export function AppearanceSettings(): React.ReactElement {
  const { t } = useTranslation('settings')
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const themeOptions = getThemeOptions(t)
  const markdownFontSizeOptions = getMarkdownFontSizeOptions(t)
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)

  /** 切换主题模式 */
  const handleThemeChange = React.useCallback((value: string) => {
    const mode = value as ThemeMode
    setThemeMode(mode)
    updateThemeMode(mode)
  }, [setThemeMode])

  /** 切换 Markdown 字号 */
  const handleMarkdownFontSizeChange = React.useCallback((value: string) => {
    const size = value as MarkdownFontSize
    setMarkdownFontSize(size)
    updateMarkdownFontSize(size)
  }, [setMarkdownFontSize])

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t('appearanceTitle')}
        description={t('appearanceDescription')}
      >
        <SettingsCard>
          {/* 主题模式 */}
          <SettingsSegmentedControl
            label={t('themeMode')}
            description={t('themeModeDescription')}
            value={themeMode}
            onValueChange={handleThemeChange}
            options={themeOptions}
          />

          <SettingsRow
            label={t('zoom')}
            description={t(ZOOM_HINT_KEY)}
          />

          <SettingsSegmentedControl
            label={t('markdownFontSize')}
            description={t('markdownFontSizeDescription')}
            value={markdownFontSize}
            onValueChange={handleMarkdownFontSizeChange}
            options={markdownFontSizeOptions}
          />

        </SettingsCard>
      </SettingsSection>

    </div>
  )
}
