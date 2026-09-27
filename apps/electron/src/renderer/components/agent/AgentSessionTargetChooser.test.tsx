import { describe, expect, test } from 'bun:test'
import { Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { AgentSessionTargetChooser } from './AgentSessionTarget.tsx'

describe('new Work session location', () => {
  test('Given a new session without a selected project When composer renders Then project picker is still available', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <TooltipProvider>
          <AgentSessionTargetChooser
            sessionId="draft-without-project"
            projectName="当前项目"
            workspaces={[]}
            onSelectProject={async () => undefined}
            onOpenLocalProject={async () => undefined}
          />
        </TooltipProvider>
      </Provider>,
    )
    expect(html).toContain('aria-label="选择项目"')
  })

  test('Given an unbound session When composer renders Then project can be selected without a Local badge', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <TooltipProvider>
          <AgentSessionTargetChooser
            sessionId="draft-1"
            projectName="domi"
            projectRootPath="/example/domi"
            workspaceId="workspace-1"
            workspaces={[{ id: 'workspace-1', slug: 'domi', name: 'domi', createdAt: 1, updatedAt: 1 }]}
            onSelectProject={async () => undefined}
          />
        </TooltipProvider>
      </Provider>,
    )
    expect(html).toContain('aria-label="选择项目"')
    expect(html).toContain('domi')
    expect(html).toContain('Worktree')
    expect(html).not.toContain('>Local<')
  })
})
