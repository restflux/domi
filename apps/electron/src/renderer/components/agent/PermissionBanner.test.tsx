import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest } from '@domi/shared'
import { allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import { PermissionBanner } from './PermissionBanner.tsx'

function renderRequest(request: PermissionRequest): string {
  const store = createStore()
  store.set(allPendingPermissionRequestsAtom, new Map([[request.sessionId, [request]]]))
  return renderToStaticMarkup(
    <Provider store={store}>
      <PermissionBanner sessionId={request.sessionId} />
    </Provider>,
  )
}

describe('PermissionBanner policy explanation', () => {
  test('renders the real Execution Policy category, reason, scope, mode, and workflow', () => {
    const html = renderRequest({
      requestId: 'request-policy',
      sessionId: 'session-1',
      toolName: 'Bash',
      toolInput: { command: 'python scripts/custom-task.py' },
      command: 'python scripts/custom-task.py',
      description: '执行 Bash',
      dangerLevel: 'dangerous',
      allowAlways: false,
      policy: {
        category: 'opaque-command',
        reason: '无法可靠证明该工具调用仅产生安全的项目内副作用',
        scope: 'single',
        executionPolicy: 'controlled',
        workflow: 'direct',
        decisionCode: 'shell-analysis-opaque',
      },
    })

    expect(html).toContain('分类：')
    expect(html).toContain('opaque-command')
    expect(html).toContain('无法可靠证明该工具调用仅产生安全的项目内副作用')
    expect(html).toContain('Execution Policy：')
    expect(html).toContain('controlled')
    expect(html).toContain('Workflow：')
    expect(html).toContain('direct')
    expect(html).toContain('判定：')
    expect(html).toContain('shell-analysis-opaque')
  })
})

describe('PermissionBanner session capability', () => {
  test('renders a bounded Git push trust decision instead of a generic dangerous command approval', () => {
    const html = renderRequest({
      requestId: 'request-1',
      sessionId: 'session-1',
      toolName: 'RequestGitPushSessionTrust',
      toolInput: { reason: '用户要求完成后推送' },
      description: '请求普通 push 会话授权',
      dangerLevel: 'dangerous',
      allowAlways: false,
      sessionCapability: {
        grantId: 'grant-1',
        kind: 'git_push_current_source',
        sessionId: 'session-1',
        remoteName: 'origin',
        remoteDisplay: 'github.com/example/domi',
        targetBranch: 'main',
        recommendedCommand: 'git push --no-verify --no-follow-tags --no-push-option origin HEAD:main',
        createdAt: 1,
      },
    })

    expect(html).toContain('信任本会话普通 Git push？')
    expect(html).toContain('data-session-capability="git-push"')
    expect(html).toContain('origin/main')
    expect(html).toContain('github.com/example/domi')
    expect(html).toContain('git push --no-verify --no-follow-tags --no-push-option origin HEAD:main')
    expect(html).toContain('信任本会话普通 Push')
    expect(html).not.toContain('本次会话总是允许')
    expect(html).not.toContain('危险操作需要确认')
  })
})
