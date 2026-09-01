/** Plan First 计划文件的宿主持久化。 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeTextFileAtomic } from './safe-file.ts'

export const CURRENT_PLAN_FILE_NAME = 'current-plan.md'

/** 规范化 ExitPlanMode 计划正文；空白计划不应进入审批。 */
export function normalizeSubmittedPlan(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  return normalized || null
}

/**
 * 把最新提交的计划写入固定入口。该文件在审批出现前就存在，
 * 因而用户在等待审批和批准后的开发阶段都能从会话 Files 打开。
 */
export function persistCurrentPlan(planSidecarDir: string, plan: string): string {
  mkdirSync(planSidecarDir, { recursive: true })
  const filePath = join(planSidecarDir, CURRENT_PLAN_FILE_NAME)
  writeTextFileAtomic(filePath, `${plan}\n`)
  return filePath
}

/** 保存每次获批计划的不可变快照，避免后续计划静默覆盖审批历史。 */
export function persistApprovedPlanSnapshot(
  planSidecarDir: string,
  plan: string,
  approvedAt: Date,
  requestId: string,
): string {
  const approvedDir = join(planSidecarDir, 'approved')
  mkdirSync(approvedDir, { recursive: true })
  const timestamp = approvedAt.toISOString().replace(/[:.]/g, '-')
  const filePath = join(approvedDir, `${timestamp}-${requestId}.md`)
  writeTextFileAtomic(filePath, `${plan}\n`)
  return filePath
}
