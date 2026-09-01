import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { userProfileAtom } from '@/atoms/user-profile'
import { WORK_WELCOME_ACTIONS, WorkWelcomeEmptyState } from './WorkWelcomeEmptyState.tsx'

function renderWelcome(): string {
  const store = createStore()
  store.set(userProfileAtom, { userName: '测试用户', avatar: '' })

  return renderToStaticMarkup(
    <Provider store={store}>
      <WorkWelcomeEmptyState onPickPrompt={() => {}} />
    </Provider>,
  )
}

describe('WorkWelcomeEmptyState', () => {
  test('展示个性化问候、品牌水印和两列 Domi 任务入口', () => {
    const html = renderWelcome()

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
