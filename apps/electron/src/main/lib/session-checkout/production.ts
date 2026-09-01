import { join } from 'node:path'
import { getConfigDir } from '../config-paths.ts'
import { AuditWriter } from '../audit/audit-writer.ts'
import { getAgentSessionMeta, updateAgentSessionMeta } from '../agent-session-manager.ts'
import { isRegisteredAgentActive } from '../agent-headless-runner-registry.ts'
import { getAgentWorkspace, getProjectFilesPath } from '../agent-workspace-manager.ts'
import type { SessionCheckoutModule } from './index.ts'
import { createNodeSessionCheckoutDependencies } from './production-adapters.ts'
import { createSessionCheckoutModule } from './session-checkout-module.ts'
import { resolveUnboundSessionTargetPolicy } from './unbound-session-target-policy.ts'

/** 生产 Session Checkout factory。 */
export function createProductionSessionCheckoutModule(): SessionCheckoutModule {
  const configDir = getConfigDir()
  const timingWriter = new AuditWriter({ auditDir: join(configDir, 'audit') })
  const dependencies = createNodeSessionCheckoutDependencies({
    configDir,
    onTimingEvent: async (event) => {
      await timingWriter.record({
        category: 'session_checkout_timing',
        action: event.phase,
        timestamp: event.timestamp,
        data: { ...event },
      })
    },
    lookup: {
      getSession: (sessionId) => {
        const session = getAgentSessionMeta(sessionId)
        return session
          ? {
              id: session.id,
              projectId: session.workspaceId,
              title: session.title,
              sourceDelegationId: session.sourceDelegationId,
              parentSessionId: session.parentSessionId,
              delegationStatus: session.delegationStatus,
              delegationCheckoutReleasedAt: session.delegationCheckoutReleasedAt,
            }
          : undefined
      },
      getProject: (projectId) => {
        const project = getAgentWorkspace(projectId)
        return project
          ? { id: project.id, name: project.name, root: getProjectFilesPath(project.slug) }
          : undefined
      },
      isSessionActive: isRegisteredAgentActive,
      markDelegationCheckoutReleased: (sessionId, releasedAt) => {
        const session = getAgentSessionMeta(sessionId)
        if (!session) throw new Error(`Agent 会话不存在: ${sessionId}`)
        updateAgentSessionMeta(sessionId, {
          delegationCheckoutReleasedAt: releasedAt,
          archived: session.archived,
        })
      },
      markInheritedCheckoutReleased: (sessionId) => {
        const session = getAgentSessionMeta(sessionId)
        if (!session) throw new Error(`Agent 会话不存在: ${sessionId}`)
        updateAgentSessionMeta(sessionId, {
          sessionTarget: { kind: 'unselected' },
          delegationCheckoutReleasedAt: Date.now(),
          archived: session.archived,
        })
      },
      getUnboundTargetPolicy: (session) => {
        const meta = getAgentSessionMeta(session.id)
        return resolveUnboundSessionTargetPolicy(meta ?? {})
      },
    },
  })
  return createSessionCheckoutModule(dependencies)
}

let processSessionCheckoutModule: SessionCheckoutModule | undefined
let retentionMaintenanceTimer: NodeJS.Timeout | undefined
const RETENTION_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000

/** 进程级 singleton；registry 与绑定锁不得因调用方不同而分裂。 */
export function getSessionCheckoutModule(): SessionCheckoutModule {
  processSessionCheckoutModule ??= createProductionSessionCheckoutModule()
  return processSessionCheckoutModule
}

/** 启动时仅识别并保留需要人工处理的 checkout，不执行全局 prune。 */
export async function reconcileProductionSessionCheckouts(): Promise<void> {
  const module = getSessionCheckoutModule()
  const summary = await module.reconcile()
  if (summary.recoveryRequiredCheckoutIds.length > 0) {
    console.warn(
      `[session-checkout] ${summary.recoveryRequiredCheckoutIds.length} 个 checkout 需要恢复确认`,
    )
  }
  if (summary.orphanedCheckoutIds.length > 0) {
    console.warn(
      `[session-checkout] 识别到 ${summary.orphanedCheckoutIds.length} 个 orphan checkout，`
      + `其中 ${summary.dirtyOrphanedCheckoutIds.length} 个为 dirty；已全部保留`,
    )
  }
  if (!retentionMaintenanceTimer) {
    retentionMaintenanceTimer = setInterval(() => {
      void module.cleanupExpiredRetained().catch((error) => {
        console.warn('[session-checkout] retained Worktree 到期维护失败:', error)
      })
    }, RETENTION_MAINTENANCE_INTERVAL_MS)
    retentionMaintenanceTimer.unref?.()
  }
}

/** 仅供测试替换生产 singleton。 */
export function setSessionCheckoutModuleForTesting(module: SessionCheckoutModule): void {
  processSessionCheckoutModule = module
}

/** 仅供测试清理替换实例。 */
export function resetSessionCheckoutModuleForTesting(): void {
  processSessionCheckoutModule = undefined
  if (retentionMaintenanceTimer) clearInterval(retentionMaintenanceTimer)
  retentionMaintenanceTimer = undefined
}
