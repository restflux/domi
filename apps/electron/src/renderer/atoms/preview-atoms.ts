/**
 * Preview Atoms — 内联预览/Diff 面板状态管理
 *
 * 每个 Agent 会话拥有独立的预览面板状态（选中文件、开关）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { currentAgentSessionIdAtom } from './agent-atoms'
import type { BrowserSelectedElementReference, FileAccessOptions, GitWorkspaceChangeLayer } from '@domi/shared'

// ===== 类型定义 =====

/** 当前预览的文件信息 */
export interface PreviewFile {
  filePath: string
  dirPath?: string
  gitRoot?: string
  /** Active Pi 预览使用 Session Target 相对路径能力。 */
  sessionTarget?: boolean
  /** 轻量 Git 面板的仓库与层次身份；用于 staged/unstaged 分层 Diff。 */
  gitWorkspace?: { repositoryId: string; layer: GitWorkspaceChangeLayer }
  /** 轻量 Git 面板的单提交 Diff（历史下钻）。 */
  gitCommit?: { repositoryId: string; oid: string; relativePath: string }
  /** 非 Session Target 预览所属的显式绝对路径空间。 */
  pathSpace?: FileAccessOptions['pathSpace']
  /** true = 纯文件预览（不显示 diff 控件），false/undefined = diff 模式 */
  previewOnly?: boolean
  /** true = 预览只读，不允许从预览面板写回临时/源文件 */
  readOnly?: boolean
  /** 候选基础目录（用于相对路径解析） */
  basePaths?: string[]
  /** 调用方提供的权威只读文本快照，例如待审批计划正文。 */
  snapshotContent?: string
  /** 文件是否落在当前会话的 diff scope 内（与 getUnstagedChanges 的 candidates 对齐） */
  inDiffScope?: boolean
  /** 基准 ref（如 "origin/main"），用于 worktree vs main 模式的 diff 对比 */
  baseRef?: string
}

// ===== Atoms =====

/** 每会话当前预览的文件（null 时显示 DiffChangesList） */
export const previewFileMapAtom = atom<Map<string, PreviewFile | null>>(new Map())

/** MainArea 旧辅助分栏比例（Browser / Scratch），持久化以兼容现有用户偏好。 */
export const previewSplitRatioAtom = atomWithStorage<number>('domi-preview-split-ratio', 0.5, undefined, { getOnInit: true })

/** 代码预览换行偏好（默认不换行，保持现有横向滚动行为） */
export const previewCodeWrapAtom = atomWithStorage<boolean>(
  'domi-preview-code-wrap',
  false,
  undefined,
  { getOnInit: true },
)

// ===== 引用选中文本（Quoted Selection）=====

/** 选中文本引用的来源 */
export type QuotedSelectionSourceType = 'file' | 'agent-history' | 'scratch-pad' | 'browser-element'

/** 从预览面板或 Agent 历史中选中的文本引用 */
export interface QuotedSelection {
  /** 选中的文本内容 */
  text: string
  /** 来源文件路径；历史引用时作为兼容展示字段 */
  filePath: string
  /** 引用来源类型 */
  sourceType?: QuotedSelectionSourceType
  /** 面向用户展示的来源名称 */
  sourceLabel?: string
  /** Agent 历史消息 ID */
  messageId?: string
  /** Agent 历史消息角色 */
  messageRole?: 'user' | 'assistant' | 'system'
  /** Main 校验后的网页元素引用；只包含有界语义信息，不包含 selector 或表单值。 */
  browserElement?: BrowserSelectedElementReference
  /** 起始行号（1-based，代码文件可计算，markdown 等无法计算时为 undefined） */
  startLine?: number
  /** 结束行号（1-based） */
  endLine?: number
  /** 捕获时间戳 */
  capturedAt: number
}

/** 每会话的引用选中文本 Map（每次新选中覆盖旧值） */
export const quotedSelectionMapAtom = atom<Map<string, QuotedSelection>>(new Map())

/** 当前会话的引用选中文本（派生） */
export const currentQuotedSelectionAtom = atom<QuotedSelection | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return null
  return get(quotedSelectionMapAtom).get(sessionId) ?? null
})
