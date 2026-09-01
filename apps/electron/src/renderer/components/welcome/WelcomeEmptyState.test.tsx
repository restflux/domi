import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { userProfileAtom } from '@/atoms/user-profile'
import { WelcomeEmptyState } from './WelcomeEmptyState.tsx'

function renderWelcome(compact = false): string {
  const store = createStore()
  store.set(userProfileAtom, { userName: '测试用户', avatar: '' })

  return renderToStaticMarkup(
    <Provider store={store}>
      <WelcomeEmptyState compact={compact} />
    </Provider>,
  )
}

describe('WelcomeEmptyState', () => {
  test('空状态只保留问候语：无模式切换、无 Tips 装饰', () => {
    const html = renderWelcome()

    expect(html).toContain('测试用户，')
    expect(html).toContain('data-welcome-empty-state="centered"')
    // Hero 构图保持干净：模式切换已收敛到侧边栏，Tips 提示也已移除
    expect(html).not.toContain('<button')
    expect(html).not.toContain('lightbulb')
  })

  test('compact 形态用于新会话 Hero 布局，以自然高度渲染在输入框上方', () => {
    const html = renderWelcome(true)

    expect(html).toContain('data-welcome-empty-state="compact"')
    expect(html).toContain('测试用户，')
    expect(html).not.toContain('<button')
  })
})
