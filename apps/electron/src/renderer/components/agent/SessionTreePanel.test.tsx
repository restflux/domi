import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionTreeResult } from '@domi/shared'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DEFAULT_SESSION_TREE_FILTER,
  filterSessionTreeNodes,
  SESSION_TREE_DIALOG_MODAL,
  SESSION_TREE_DIALOG_POSITION_CLASS,
  SessionTreePanelView,
  type SessionTreeFilter,
} from './SessionTreePanel'

const tree: SessionTreeResult = {
  activeLeafId: 'a3',
  branchCount: 2,
  nodes: [
    {
      id: 'u1', parentId: null, role: 'user', summary: '第一问', timestamp: '2026-08-03T10:00:00+08:00',
      toolCount: 0, branchMessageIndex: 0, isOnActiveBranch: true,
    },
    {
      id: 'a1', parentId: 'u1', role: 'assistant', summary: '第一答', timestamp: '2026-08-03T10:01:00+08:00',
      toolCount: 3, branchMessageIndex: 1, isOnActiveBranch: true,
    },
    {
      id: 'u2', parentId: 'a1', role: 'user', summary: '原分支', timestamp: '2026-08-03T10:02:00+08:00',
      toolCount: 0, branchMessageIndex: 2, isOnActiveBranch: false,
    },
    {
      id: 'a2', parentId: 'u2', role: 'assistant', summary: '原回答', timestamp: '2026-08-03T10:03:00+08:00',
      toolCount: 1, branchMessageIndex: 3, isOnActiveBranch: false,
    },
    {
      id: 'u3', parentId: 'a1', role: 'user', summary: '新分支', timestamp: '2026-08-03T10:04:00+08:00',
      toolCount: 0, branchMessageIndex: 2, isOnActiveBranch: true,
    },
    {
      id: 'a3', parentId: 'u3', role: 'assistant', summary: '新回答', timestamp: '2026-08-03T10:05:00+08:00',
      toolCount: 2, branchMessageIndex: 3, isOnActiveBranch: true,
    },
  ],
}

function renderView(filter: SessionTreeFilter = DEFAULT_SESSION_TREE_FILTER): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SessionTreePanelView
        tree={tree}
        loading={false}
        filter={filter}
        busyEntryId={null}
        onFilterChange={() => {}}
        onClose={() => {}}
        onScroll={() => {}}
        onNavigate={() => {}}
      />
    </TooltipProvider>,
  )
}

describe('SessionTreePanel 极简视图', () => {
  test('浮窗使用视口中央偏上的非模态定位', () => {
    expect(SESSION_TREE_DIALOG_MODAL).toBe(false)
    expect(SESSION_TREE_DIALOG_POSITION_CLASS).toContain('top-[18%]')
    expect(SESSION_TREE_DIALOG_POSITION_CLASS).toContain('left-[50%]')
    expect(SESSION_TREE_DIALOG_POSITION_CLASS).toContain('w-[min(460px,calc(100vw-32px))]')
  })

  test('默认过滤为全部并直接显示 user 与 assistant 节点', () => {
    const html = renderView()
    expect(DEFAULT_SESSION_TREE_FILTER).toBe('all')
    expect(html).toContain('data-session-tree-filter="all"')
    expect(html).toContain('data-session-tree-node-role="user"')
    expect(html).toContain('data-session-tree-node-role="assistant"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>全部/)
    expect(html).not.toContain('次工具调用')
  })

  test('user 以主题色实心点和较高字重突出，assistant 使用中性小点弱化', () => {
    const html = renderView()
    expect(html).toContain('data-session-tree-role-marker="user"')
    expect(html).toContain('border-primary/60 bg-primary/25')
    expect(html).toContain('text-[12px] font-medium text-foreground/90')
    expect(html).toContain('data-session-tree-role-marker="assistant"')
    expect(html).toContain('text-[11px] font-normal text-muted-foreground/65')
  })

  test('连接线使用 SVG 路径精确衔接圆点，当前分支轨道用主题色高亮', () => {
    const html = renderView()
    expect(html).toContain('<svg')
    expect(html).toContain('<path')
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('data-active-rail="true"')
    expect(html).toContain('stroke-primary/35')
    expect(html).toContain('stroke-border/50')
    // 跨层级的分叉边使用二次贝塞尔圆角肘部
    expect(html).toMatch(/Q \d+ \d+ \d+ \d+/)
  })

  test('切换仅用户后隐藏 assistant，同时保留过滤控件', () => {
    const html = renderView('user')
    expect(filterSessionTreeNodes(tree.nodes, 'user').map((node) => node.id)).toEqual(['u1', 'u2', 'u3'])
    expect(html).toContain('data-session-tree-filter="user"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>仅用户/)
    expect(html).toMatch(/aria-pressed="false"[^>]*>全部/)
    expect(html).not.toContain('data-session-tree-node-role="assistant"')
  })

  test('分支时间交错时按 DFS 重排，每条分支的节点保持连续', () => {
    const interleaved: SessionTreeResult = {
      activeLeafId: 'a2',
      branchCount: 2,
      nodes: [
        { id: 'u1', parentId: null, role: 'user', summary: '根', timestamp: '2026-08-03T10:00:00+08:00', toolCount: 0, branchMessageIndex: 0, isOnActiveBranch: true },
        { id: 'a1', parentId: 'u1', role: 'assistant', summary: '根回答', timestamp: '2026-08-03T10:01:00+08:00', toolCount: 0, branchMessageIndex: 1, isOnActiveBranch: true },
        { id: 'u2', parentId: 'a1', role: 'user', summary: '分支A提问', timestamp: '2026-08-03T10:02:00+08:00', toolCount: 0, branchMessageIndex: 2, isOnActiveBranch: true },
        { id: 'u3', parentId: 'a1', role: 'user', summary: '分支B提问', timestamp: '2026-08-03T10:03:00+08:00', toolCount: 0, branchMessageIndex: 2, isOnActiveBranch: false },
        { id: 'a3', parentId: 'u3', role: 'assistant', summary: '分支B回答', timestamp: '2026-08-03T10:04:00+08:00', toolCount: 0, branchMessageIndex: 3, isOnActiveBranch: false },
        { id: 'a2', parentId: 'u2', role: 'assistant', summary: '分支A回答', timestamp: '2026-08-03T10:05:00+08:00', toolCount: 0, branchMessageIndex: 3, isOnActiveBranch: true },
      ],
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTreePanelView
          tree={interleaved}
          loading={false}
          filter="all"
          busyEntryId={null}
          onFilterChange={() => {}}
          onClose={() => {}}
          onScroll={() => {}}
          onNavigate={() => {}}
        />
      </TooltipProvider>,
    )
    // 时间顺序下「分支A回答」排在「分支B提问」之后；DFS 重排后分支A连续，A 回答在 B 提问之前
    expect(html.indexOf('分支A提问')).toBeLessThan(html.indexOf('分支A回答'))
    expect(html.indexOf('分支A回答')).toBeLessThan(html.indexOf('分支B提问'))
    expect(html.indexOf('分支B提问')).toBeLessThan(html.indexOf('分支B回答'))
  })

  test('旧 transcript 历史节点可定位但不显示分支操作', () => {
    const historyTree: SessionTreeResult = {
      activeLeafId: 'history-u',
      branchCount: 1,
      nodes: [{
        id: 'history-u',
        parentId: null,
        role: 'user',
        summary: '较早问题',
        toolCount: 0,
        branchMessageIndex: 0,
        isOnActiveBranch: true,
        canNavigate: false,
      }],
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTreePanelView
          tree={historyTree}
          loading={false}
          filter="all"
          busyEntryId={null}
          onFilterChange={() => {}}
          onClose={() => {}}
          onScroll={() => {}}
          onNavigate={() => {}}
        />
      </TooltipProvider>,
    )
    expect(html).toContain('较早问题（早期历史，仅可定位）')
    expect(html).not.toContain('data-session-tree-actions')
  })

  test('操作区保持 hover/focus 浮现，默认全部视图直接标识真实 assistant 活跃叶', () => {
    const html = renderView()
    expect(html).toContain('data-session-tree-actions="user"')
    expect(html).toContain('data-session-tree-actions="assistant"')
    expect(html).toContain('opacity-0 pointer-events-none')
    expect(html).toContain('group-hover:opacity-100')
    expect(html).toContain('aria-label="从此继续"')
    expect(html).toContain('aria-label="编辑重发"')
    expect(html).toContain('data-session-tree-node-role="assistant" data-active-leaf="true"')
    expect(html).toContain('当前')
  })
})
