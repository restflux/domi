import * as React from 'react'
import { ArrowRight, Loader2, Pencil, Share2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { SessionTreeNode, SessionTreeResult } from '@domi/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  SESSION_TREE_NAVIGATED_EVENT,
  SESSION_TREE_SCROLL_EVENT,
  type SessionTreeNavigatedEventDetail,
  type SessionTreeScrollEventDetail,
} from './session-tree-events'

interface SessionTreePanelProps {
  sessionId: string
  onClose: () => void
}

interface SessionTreeDialogProps {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export type SessionTreeFilter = 'user' | 'all'
export const DEFAULT_SESSION_TREE_FILTER: SessionTreeFilter = 'all'

interface SessionTreePanelViewProps {
  tree: SessionTreeResult
  loading: boolean
  filter: SessionTreeFilter
  busyEntryId: string | null
  onFilterChange: (filter: SessionTreeFilter) => void
  onClose: () => void
  onScroll: (node: SessionTreeNode) => void
  onNavigate: (node: SessionTreeNode, edit: boolean) => void
}

interface VisibleTreeNode {
  node: SessionTreeNode
  parentId: string | null
  depth: number
  isForkChild: boolean
  isLastForkChild: boolean
}

const EMPTY_TREE: SessionTreeResult = { nodes: [], activeLeafId: null, branchCount: 0 }

export const SESSION_TREE_DIALOG_MODAL = false
export const SESSION_TREE_DIALOG_POSITION_CLASS = 'left-[50%] top-[18%] w-[min(460px,calc(100vw-32px))] max-w-none translate-x-[-50%] translate-y-0'

export function filterSessionTreeNodes(
  nodes: SessionTreeNode[],
  filter: SessionTreeFilter,
): SessionTreeNode[] {
  return filter === 'user' ? nodes.filter((node) => node.role === 'user') : nodes
}

function buildVisibleTreeLayout(tree: SessionTreeResult, filter: SessionTreeFilter): VisibleTreeNode[] {
  const nodes = filterSessionTreeNodes(tree.nodes, filter)
  const allById = new Map(tree.nodes.map((node) => [node.id, node]))
  const visibleIds = new Set(nodes.map((node) => node.id))
  const visibleParentById = new Map<string, string | null>()

  for (const node of nodes) {
    let parentId = node.parentId
    const visited = new Set<string>()
    while (parentId && !visibleIds.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId)
      parentId = allById.get(parentId)?.parentId ?? null
    }
    visibleParentById.set(node.id, parentId)
  }

  const childrenByParent = new Map<string | null, string[]>()
  for (const node of nodes) {
    const parentId = visibleParentById.get(node.id) ?? null
    const children = childrenByParent.get(parentId) ?? []
    children.push(node.id)
    childrenByParent.set(parentId, children)
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  // DFS 前序遍历：让每条分支的节点连续排列，避免按时间交错时连接线横跨其他分支的行。
  // 同一父节点的子分支保持原有（时间）顺序。
  const ordered: VisibleTreeNode[] = []
  const visit = (nodeId: string, depth: number, parentId: string | null): void => {
    const node = nodeById.get(nodeId)
    if (!node) return
    const siblings = parentId ? (childrenByParent.get(parentId) ?? []) : []
    const isForkChild = siblings.length > 1
    ordered.push({
      node,
      parentId,
      depth,
      isForkChild,
      isLastForkChild: isForkChild && siblings.at(-1) === nodeId,
    })
    const children = childrenByParent.get(nodeId) ?? []
    const childDepth = children.length > 1 ? depth + 1 : depth
    for (const childId of children) {
      visit(childId, childDepth, nodeId)
    }
  }
  for (const rootId of childrenByParent.get(null) ?? []) {
    visit(rootId, 0, null)
  }

  return ordered
}

interface TreeEdge {
  childId: string
  d: string
  isOnActiveBranch: boolean
}

const TREE_ROW_HEIGHT = 32
const TREE_DEPTH_STEP = 14
const TREE_LINE_X_BASE = 6
const TREE_ELBOW_RADIUS = 7

function lineXOf(depth: number): number {
  return TREE_LINE_X_BASE + depth * TREE_DEPTH_STEP
}

/** 圆点外圈半径（含描边），连接线端点收缩到圆点边缘，避免线段穿过空心圆点。 */
function markerRadiusOf(role: SessionTreeNode['role']): number {
  return role === 'user' ? 6 : 4
}

/** 计算父节点圆点到子节点圆点的连接路径：同轴走直线，跨层级用圆角肘部平滑衔接。 */
function buildTreeEdges(visibleNodes: VisibleTreeNode[]): TreeEdge[] {
  const indexById = new Map(visibleNodes.map((item, index) => [item.node.id, index]))
  const edges: TreeEdge[] = []

  for (const item of visibleNodes) {
    if (!item.parentId) continue
    const parentIndex = indexById.get(item.parentId)
    if (parentIndex === undefined) continue
    const parent = visibleNodes[parentIndex]!
    const childIndex = indexById.get(item.node.id)!

    const parentRadius = markerRadiusOf(parent.node.role)
    const childRadius = markerRadiusOf(item.node.role)
    const px = lineXOf(parent.depth)
    const py = parentIndex * TREE_ROW_HEIGHT + TREE_ROW_HEIGHT / 2 + parentRadius
    const cx = lineXOf(item.depth)
    const cyCenter = childIndex * TREE_ROW_HEIGHT + TREE_ROW_HEIGHT / 2

    let d: string
    if (px === cx || cyCenter <= py) {
      d = `M ${px} ${py} L ${cx} ${cyCenter - childRadius}`
    } else {
      const r = Math.min(TREE_ELBOW_RADIUS, (cx - px) / 2, (cyCenter - py) / 2)
      d = `M ${px} ${py} L ${px} ${cyCenter - r} Q ${px} ${cyCenter} ${px + r} ${cyCenter} L ${cx - childRadius} ${cyCenter}`
    }
    edges.push({ childId: item.node.id, d, isOnActiveBranch: item.node.isOnActiveBranch })
  }

  return edges
}

function visibleActiveNodeId(tree: SessionTreeResult, filter: SessionTreeFilter): string | null {
  const visibleNodes = filterSessionTreeNodes(tree.nodes, filter)
  if (visibleNodes.some((node) => node.id === tree.activeLeafId)) return tree.activeLeafId
  return [...visibleNodes].reverse().find((node) => node.isOnActiveBranch)?.id ?? null
}

function formatTime(timestamp: string | undefined): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/** 悬浮提示使用本地时区的可读完整时间，而不是带时区偏移的原始 ISO 串。 */
function formatFullTime(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function SessionTreeIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation()
            onClick()
          }}
          className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-40"
          aria-label={label}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top"><p>{label}</p></TooltipContent>
    </Tooltip>
  )
}

export function SessionTreePanelView({
  tree,
  loading,
  filter,
  busyEntryId,
  onFilterChange,
  onClose,
  onScroll,
  onNavigate,
}: SessionTreePanelViewProps): React.ReactElement {
  const visibleNodes = React.useMemo(() => buildVisibleTreeLayout(tree, filter), [filter, tree])
  const activeNodeId = React.useMemo(() => visibleActiveNodeId(tree, filter), [filter, tree])
  const edges = React.useMemo(() => buildTreeEdges(visibleNodes), [visibleNodes])
  const hasFork = visibleNodes.some((item) => item.isForkChild)
  // 「从此继续 / 编辑重发」会切换活跃分支并可能中止运行中的 Agent，先经确认弹窗再执行
  const [confirmAction, setConfirmAction] = React.useState<{ node: SessionTreeNode; edit: boolean } | null>(null)

  return (
    <div data-session-tree-panel="open" data-state="open" className="flex min-h-[220px] max-h-[70vh] flex-col overflow-hidden bg-content-area titlebar-no-drag">
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border/30 px-3">
        <span className="text-xs font-medium text-foreground/90">会话树</span>
        {tree.branchCount > 1 && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {tree.branchCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center rounded-md bg-muted/45 p-0.5" aria-label="会话树过滤">
            {(['all', 'user'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onFilterChange(value)}
                aria-pressed={filter === value}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] leading-4 transition-colors',
                  filter === value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {value === 'all' ? '全部' : '仅用户'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            aria-label="关闭会话树"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && tree.nodes.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">正在读取会话树…</div>
        ) : tree.nodes.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-1 px-6 text-center text-xs text-muted-foreground">
            <span className="mb-1.5 flex size-8 items-center justify-center rounded-full bg-muted/60">
              <Share2 className="size-3.5 opacity-50" />
            </span>
            <span>发送第一条消息后即可使用分支</span>
            <span className="text-[11px] text-muted-foreground/65">之后可从用户消息编辑重发，创建新的会话路径。</span>
          </div>
        ) : (
          <div className="relative" data-session-tree-filter={filter}>
            {/* SVG 连接线层：坐标精确对齐圆点中心，分叉处使用圆角肘部路径 */}
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0"
              width="100%"
              height={visibleNodes.length * TREE_ROW_HEIGHT}
            >
              {edges.map((edge) => (
                <path
                  key={edge.childId}
                  d={edge.d}
                  fill="none"
                  strokeWidth={2}
                  strokeLinecap="round"
                  data-active-rail={edge.isOnActiveBranch ? 'true' : undefined}
                  className={edge.isOnActiveBranch ? 'stroke-primary/35' : 'stroke-border/50'}
                />
              ))}
            </svg>
            {visibleNodes.map((item) => {
              const { node, depth, isForkChild, isLastForkChild } = item
              const isActive = node.id === activeNodeId
              const busy = busyEntryId === node.id
              const lineX = lineXOf(depth)
              const time = formatTime(node.timestamp)
              return (
                <div
                  key={node.id}
                  data-session-tree-node-role={node.role}
                  data-active-leaf={isActive ? 'true' : undefined}
                  data-branch-kind={!hasFork ? 'single' : isForkChild ? (isLastForkChild ? 'fork-last' : 'fork-middle') : 'branch'}
                  className={cn(
                    'group relative flex h-8 items-center rounded-md pr-1 transition-colors',
                    isActive ? 'bg-primary/[0.07]' : 'hover:bg-muted/35',
                    node.role === 'assistant' && 'text-[11px] text-muted-foreground/70',
                  )}
                  style={{ paddingLeft: lineX + 10 }}
                >
                  <span
                    aria-hidden="true"
                    data-session-tree-role-marker={node.role}
                    className={cn(
                      'pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-all',
                      node.role === 'user' ? 'size-3' : 'size-2',
                      isActive
                        ? 'border-primary bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.16)]'
                        : node.isOnActiveBranch
                          ? node.role === 'user'
                            ? 'border-primary/60 bg-primary/25'
                            : 'border-transparent bg-primary/40'
                          : node.role === 'user'
                            ? 'border-muted-foreground/35 bg-transparent'
                            : 'border-transparent bg-muted-foreground/30',
                    )}
                    style={{ left: lineX }}
                  />

                  <button
                    type="button"
                    onClick={() => onScroll(node)}
                    className={cn(
                      'min-w-0 flex-1 truncate text-left leading-5',
                      node.role === 'user'
                        ? 'text-[12px] font-medium text-foreground/90'
                        : 'text-[11px] font-normal text-muted-foreground/65',
                    )}
                    aria-label={`定位消息：${node.summary}`}
                    title={node.canNavigate === false ? `${node.summary}（早期历史，仅可定位）` : node.summary}
                  >
                    {node.summary}
                  </button>

                  {isActive && (
                    <span className="ml-1.5 shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
                      当前
                    </span>
                  )}
                  {time && (
                    <time
                      className="ml-1.5 w-[34px] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/45"
                      dateTime={node.timestamp}
                      title={formatFullTime(node.timestamp)}
                    >
                      {time}
                    </time>
                  )}

                  {/* 旧 runtime 的线性历史仅用于补齐数量和定位；当前 Pi artifact 节点才可切换分支。 */}
                  {node.canNavigate !== false && (
                    <div
                      data-session-tree-actions={node.role}
                      className={cn(
                        'flex w-0 shrink-0 items-center justify-end gap-0.5 overflow-hidden opacity-0 pointer-events-none transition-all',
                        'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
                        node.role === 'user'
                          ? 'group-hover:w-[52px] group-focus-within:w-[52px]'
                          : 'group-hover:w-6 group-focus-within:w-6',
                      )}
                    >
                      <SessionTreeIconButton
                        label="从此继续"
                        disabled={!!busyEntryId}
                        onClick={() => setConfirmAction({ node, edit: false })}
                      >
                        {busy ? <Loader2 className="size-3 animate-spin" /> : <ArrowRight className="size-3" />}
                      </SessionTreeIconButton>
                      {node.role === 'user' && (
                        <SessionTreeIconButton
                          label="编辑重发"
                          disabled={!!busyEntryId}
                          onClick={() => setConfirmAction({ node, edit: true })}
                        >
                          <Pencil className="size-3" />
                        </SessionTreeIconButton>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 分支切换确认：当前分支此后的消息会被隐藏（不删除），运行中的 Agent 会被中止 */}
      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.edit ? '编辑重发这条消息？' : '从此处继续？'}</AlertDialogTitle>
            <AlertDialogDescription>
              将切换到「{confirmAction?.node.summary}」所在的分支。当前分支此后的消息会被隐藏（不会删除，可随时通过会话树切回）；若 Agent 正在运行，会先被中止。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = confirmAction
                setConfirmAction(null)
                if (action) onNavigate(action.node, action.edit)
              }}
            >
              {confirmAction?.edit ? '编辑重发' : '从此继续'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function SessionTreePanel({ sessionId, onClose }: SessionTreePanelProps): React.ReactElement {
  const [tree, setTree] = React.useState<SessionTreeResult>(EMPTY_TREE)
  const [loading, setLoading] = React.useState(true)
  const [filter, setFilter] = React.useState<SessionTreeFilter>(DEFAULT_SESSION_TREE_FILTER)
  const [busyEntryId, setBusyEntryId] = React.useState<string | null>(null)

  const loadTree = React.useCallback(async () => {
    setLoading(true)
    try {
      setTree(await window.electronAPI.getSessionTree(sessionId))
    } catch (error) {
      console.error('[SessionTreePanel] 读取会话树失败:', error)
      toast.error('读取会话树失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  React.useEffect(() => { void loadTree() }, [loadTree])

  const scrollToNode = React.useCallback((node: SessionTreeNode) => {
    window.dispatchEvent(new CustomEvent<SessionTreeScrollEventDetail>(SESSION_TREE_SCROLL_EVENT, {
      detail: { sessionId, node },
    }))
  }, [sessionId])

  const navigate = React.useCallback(async (node: SessionTreeNode, edit: boolean) => {
    if (busyEntryId) return
    setBusyEntryId(node.id)
    try {
      const result = await window.electronAPI.navigateSessionTree({ sessionId, entryId: node.id })
      window.dispatchEvent(new CustomEvent<SessionTreeNavigatedEventDetail>(SESSION_TREE_NAVIGATED_EVENT, {
        detail: {
          sessionId,
          node,
          ...(edit && result.editorText !== undefined ? { editorText: result.editorText } : {}),
          abortedRun: result.abortedRun,
        },
      }))
      await loadTree()
      toast.success(edit ? '消息已回填，可修改后重发' : '已切换到所选分支', {
        description: result.abortedRun ? '已先中止正在运行的 Agent。' : undefined,
      })
    } catch (error) {
      console.error('[SessionTreePanel] 导航失败:', error)
      toast.error('切换分支失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyEntryId(null)
    }
  }, [busyEntryId, loadTree, sessionId])

  return (
    <SessionTreePanelView
      tree={tree}
      loading={loading}
      filter={filter}
      busyEntryId={busyEntryId}
      onFilterChange={setFilter}
      onClose={onClose}
      onScroll={scrollToNode}
      onNavigate={navigate}
    />
  )
}

/**
 * 非模态 Dialog：无背景遮罩、不锁定页面交互，消息流保持可见且可被树节点滚动定位。
 * Radix Dialog 负责 portal、定位层级、Escape 与外部点击语义；不额外自研拖拽。
 */
export function SessionTreeDialog({
  sessionId,
  open,
  onOpenChange,
}: SessionTreeDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={SESSION_TREE_DIALOG_MODAL}>
      <DialogContent
        hideClose
        data-session-tree-floating-dialog="true"
        className={`${SESSION_TREE_DIALOG_POSITION_CLASS} gap-0 overflow-hidden rounded-xl p-0 shadow-2xl`}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">会话树</DialogTitle>
        <SessionTreePanel sessionId={sessionId} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
