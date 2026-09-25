import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { userProfileAtom } from '@/atoms/user-profile'
import { interfaceVariantAtom, systemIsDarkAtom, themeModeAtom, themeStyleAtom } from '@/atoms/theme'
import { WORK_WELCOME_ACTIONS, WorkWelcomeEmptyState } from './WorkWelcomeEmptyState.tsx'

function renderWelcome(mode: 'light' | 'dark' | 'system' | 'special', variant: 'modern' | 'classic', systemDark = true): string {
  const store = createStore()
  store.set(userProfileAtom, { userName: '测试用户', avatar: '' })
  store.set(themeModeAtom, mode)
  store.set(interfaceVariantAtom, variant)
  store.set(systemIsDarkAtom, systemDark)
  if (mode === 'special') store.set(themeStyleAtom, 'ocean-light')

  return renderToStaticMarkup(
    <Provider store={store}>
      <WorkWelcomeEmptyState onPickPrompt={() => {}} />
    </Provider>,
  )
}

describe('WorkWelcomeEmptyState', () => {
  test('默认浅色现代界面显示 Domi 品牌字标的构造线稿与一句引导', () => {
    const html = renderWelcome('light', 'modern')

    expect(html).toContain('data-welcome-variant="quiet"')
    expect(html).toContain('domi-wordmark')
    expect(html).toContain('domi-mark')
    expect(html).toContain('domi-construction-outline')
    expect(html).toContain('M30 45H601M30 90H601M30 150H601')
    expect(html).toContain('从一个问题开始')
    expect(html).not.toContain('mask-image')
    expect(html).not.toContain('<button')
  })

  test.each(['dark', 'system', 'special'] as const)('%s 现代主题沿用留白空态', (mode) => {
    expect(renderWelcome(mode, 'modern')).toContain('data-welcome-variant="quiet"')
  })

  test('系统浅色与手动浅色使用相同的安静空态', () => {
    expect(renderWelcome('system', 'modern', false)).toContain('data-welcome-variant="quiet"')
  })

  test.each([['light', 'classic'], ['dark', 'classic'], ['special', 'classic']] as const)('%s/%s 保留原有欢迎入口', (mode, variant) => {
    const html = renderWelcome(mode, variant)

    expect(html).toContain('data-work-welcome-empty-state="true"')
    expect(html).toContain('测试用户，')
    expect(html).toContain('mask-image')
    expect(html.match(/<button/g)).toHaveLength(4)
    expect(html).toContain('sm:grid-cols-2')
    expect(html).not.toContain('grid-cols-4')

    for (const action of WORK_WELCOME_ACTIONS) {
      expect(html).toContain(action.title)
      expect(html).toContain(action.description)
    }
  })

  test('任务入口提供可继续补充的预填提示词', () => {
    expect(WORK_WELCOME_ACTIONS.map((action) => action.prompt)).toEqual([
      '帮我梳理这个项目的入口、核心模块和关键依赖',
      '帮我把这个想法拆解并实现成可验证的改动',
      '帮我复现这个问题，定位根因并完成修复',
      '帮我审查并整理当前工作，给出清晰的下一步',
    ])
  })
})
