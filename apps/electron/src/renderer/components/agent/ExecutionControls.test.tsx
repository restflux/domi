import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentSessionCapabilityGrantsMapAtom,
  agentSessionsAtom,
  agentTemporaryExecutionRunTokensAtom,
} from '@/atoms/agent-atoms'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { ExecutionControls } from './ExecutionControls.tsx'

function renderControls(
  workflow: 'direct' | 'read-only' | 'plan-first',
  executionPolicy: 'controlled' | 'autonomous' | 'full-access',
  withPushGrant = false,
  temporaryExecution = false,
  targetProtectionReason?: 'delivered' | 'retained' | 'preview_active',
): string {
  const store = createStore()
  store.set(agentSessionsAtom, [{
    id: 'session-1',
    title: 'Test',
    workflow,
    executionPolicy,
    createdAt: 1,
    updatedAt: 1,
  }])
  if (temporaryExecution) {
    store.set(agentTemporaryExecutionRunTokensAtom, new Map([['session-1', 7]]))
  }
  if (withPushGrant) {
    store.set(agentSessionCapabilityGrantsMapAtom, new Map([['session-1', [{
      grantId: 'grant-1',
      kind: 'git_push_current_source',
      sessionId: 'session-1',
      remoteName: 'origin',
      remoteDisplay: 'github.com/example/domi',
      targetBranch: 'main',
      recommendedCommand: 'git push --no-verify --no-follow-tags --no-push-option origin HEAD:main',
      createdAt: 1,
    }]]]))
  }
  return renderToStaticMarkup(
    <Provider store={store}>
      <TooltipProvider>
        <ExecutionControls sessionId="session-1" targetProtectionReason={targetProtectionReason} />
      </TooltipProvider>
    </Provider>,
  )
}

describe('ExecutionControls compact entry', () => {
  test('shows Research as one of only two work modes', () => {
    const html = renderControls('read-only', 'controlled')

    expect(html).toContain('aria-label="工作方式：研究"')
    expect(html).toContain('>研究<')
    expect(html).not.toContain('>计划<')
    expect(html).not.toContain('标准保护')
    expect(html).not.toContain('自主执行')
    expect(html).not.toContain('权限与安全')
  })

  test('normalizes legacy Plan First presentation back to Research', () => {
    const html = renderControls('plan-first', 'autonomous')
    expect(html).toContain('aria-label="工作方式：研究"')
    expect(html).not.toContain('>计划<')
  })

  test('shows an amber PlugZap temporary state while Research has a current-run execution lease', () => {
    const html = renderControls('read-only', 'full-access', false, true)

    expect(html).toContain('aria-label="工作方式：本次执行"')
    expect(html).toContain('>本次执行<')
    expect(html).toContain('text-amber-600')
    expect(html).toContain('lucide-plug-zap')
    expect(html).not.toContain('aria-label="工作方式：执行"')
  })

  test('does not replace persistent Execute with the temporary presentation', () => {
    const html = renderControls('direct', 'full-access', false, true)

    expect(html).toContain('aria-label="工作方式：执行"')
    expect(html).not.toContain('>本次执行<')
  })

  test('shows the selected workflow independently of delivered project protection', () => {
    const html = renderControls('direct', 'full-access', false, false, 'delivered')
    expect(html).toContain('aria-label="工作方式：执行"')
    expect(html).not.toContain('已交付 · 只读')
    expect(renderControls('read-only', 'full-access', false, false, 'retained'))
      .toContain('aria-label="工作方式：研究"')
  })

  test('shows preview protection without overriding the workflow', () => {
    const html = renderControls('direct', 'full-access', false, false, 'preview_active')

    expect(html).toContain('aria-label="工作方式：执行"')
    expect(html).toContain('修改项目需要先撤回验收')
  })

  test('shows an explicit compact indicator while code upload authorization is active', () => {
    const html = renderControls('direct', 'full-access', true)

    expect(html).toContain('代码上传授权：origin/main')
    expect(html).toContain('data-session-capability-indicator="git-push"')
    expect(html).toContain('title="允许上传到 origin/main"')
  })

  test('describes Execute without exposing Full Access or a second confirmation dialog', () => {
    const html = renderControls('direct', 'full-access')

    expect(html).toContain('aria-label="工作方式：执行"')
    expect(html).not.toContain('>完全访问<')
    expect(html).not.toContain('切换到执行？')
    expect(html).not.toContain('确认切换到执行')
  })
})
