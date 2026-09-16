/**
 * 会话悬浮元信息模型
 *
 * 侧栏悬浮面板在标题下方用两行回答"这个会话在哪跑、跑到哪一步"：
 * 第一行是目标与交付状态，第二行是项目与 Git 位置。
 * 这里只做纯投影：会话持久化元数据（零 Git 开销）优先，
 * 分支与状态来自悬浮时静默 inspect 得到的 Session Target 快照。
 */

import type { SessionTargetView } from '@domi/shared'
import { buildSessionTargetViewModel } from '@/lib/session-target-view-model'

export type SessionHoverTargetKind = 'unselected' | 'local' | 'isolated'

/** 与 Session Target 状态视图共用一套语义色，面板与输入区观感一致。 */
export type SessionHoverTone = 'neutral' | 'progress' | 'ready' | 'warning' | 'muted'

export interface SessionHoverMetaInput {
  /** 会话持久化的目标意图；历史会话缺失时按 Local 兼容。 */
  sessionTargetKind?: SessionHoverTargetKind
  /** 已缓存的 Session Target 快照；未 inspect 或 inspect 失败时为 null。 */
  snapshot: SessionTargetView | null
  /** 会话更新时间戳；缺失时省略更新时间。 */
  updatedAt?: number
}

export interface SessionHoverMeta {
  targetLabel: string
  targetTone: SessionHoverTone
  /** 与目标标签重复的状态会被省略（如 Local 会话的 "Local" 状态）。 */
  statusLabel: string | null
  statusTone: SessionHoverTone
  /** 分支名；detached HEAD 退化为 "Detached <短 oid>"。 */
  gitLabel: string | null
  updatedLabel: string | null
}

const TARGET_LABEL: Record<SessionHoverTargetKind, string> = {
  unselected: '未选择位置',
  local: 'Local',
  isolated: 'Worktree',
}

const TARGET_TONE: Record<SessionHoverTargetKind, SessionHoverTone> = {
  unselected: 'warning',
  local: 'neutral',
  isolated: 'progress',
}

/** 同年只保留月日，跨年补年份，避免面板里出现整行 ISO 时间。 */
export function formatHoverUpdatedAt(updatedAt: number, now: number): string {
  const updated = new Date(updatedAt)
  const clock = `${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}`
  const date = `${updated.getMonth() + 1}月${updated.getDate()}日`
  return updated.getFullYear() === new Date(now).getFullYear()
    ? `${date} ${clock}`
    : `${updated.getFullYear()}年${date} ${clock}`
}

function resolveTargetKind(
  sessionTargetKind: SessionHoverTargetKind | undefined,
  snapshot: SessionTargetView | null,
): SessionHoverTargetKind {
  if (snapshot) return snapshot.checkout.kind === 'isolated' ? 'isolated' : 'local'
  return sessionTargetKind ?? 'local'
}

function resolveGitLabel(snapshot: SessionTargetView): string | null {
  const { identity } = buildSessionTargetViewModel(snapshot)
  if (!identity.branchLabel) return null
  // detached 时 branchLabel 已是 "Detached"，补短 oid 才有辨识度。
  return identity.branchLabel === 'Detached' && identity.headLabel
    ? `${identity.branchLabel} ${identity.headLabel}`
    : identity.branchLabel
}

export function buildSessionHoverMeta(input: SessionHoverMetaInput, now = Date.now()): SessionHoverMeta {
  const kind = resolveTargetKind(input.sessionTargetKind, input.snapshot)
  const targetLabel = TARGET_LABEL[kind]
  const updatedLabel = input.updatedAt ? formatHoverUpdatedAt(input.updatedAt, now) : null

  if (!input.snapshot) {
    return {
      targetLabel,
      targetTone: TARGET_TONE[kind],
      statusLabel: null,
      statusTone: 'neutral',
      gitLabel: null,
      updatedLabel,
    }
  }

  const { status } = buildSessionTargetViewModel(input.snapshot)
  return {
    targetLabel,
    targetTone: TARGET_TONE[kind],
    statusLabel: status.label === targetLabel ? null : status.label,
    statusTone: status.tone,
    gitLabel: resolveGitLabel(input.snapshot),
    updatedLabel,
  }
}
