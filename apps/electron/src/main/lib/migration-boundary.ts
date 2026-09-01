import { assertMigrationFileMode } from '@domi/shared'
import type { MigrationFileMode } from '@domi/shared'

export interface MigrationModeCarrier {
  mode: MigrationFileMode
}

function readMode(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return (value as { mode?: unknown }).mode
}

/** 校验来自 renderer 的导出请求，避免非法 mode 进入凭据导出分支。 */
export function assertMigrationExportRequest(
  request: unknown,
): asserts request is MigrationModeCarrier & Record<string, unknown> {
  assertMigrationFileMode(readMode(request))
}

/** 校验归档中的 manifest，避免伪造 mode 绕过个人/分享模式边界。 */
export function assertMigrationManifest(
  manifest: unknown,
): asserts manifest is MigrationModeCarrier & Record<string, unknown> {
  assertMigrationFileMode(readMode(manifest))
}

/** Pi-only 会话索引从 v2 起不再持久化 runtime 字段。 */
const PI_ONLY_AGENT_SESSION_INDEX_VERSION = 2

/**
 * Pi-only 版本不能把 Claude SDK 会话元数据静默改写成 Pi。
 * 旧 schema 中缺失 runtime 的既有语义是 Claude，因此只接受显式 `pi`；
 * v2+ 才允许已经完成 clean cut、因而不再包含 runtime 字段的会话。
 */
export function assertPiOnlyAgentSessionIndex(index: unknown): void {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return
  const candidate = index as { version?: unknown; sessions?: unknown }
  if (!Array.isArray(candidate.sessions)) return

  const isPiOnlySchema = Number.isInteger(candidate.version) &&
    Number(candidate.version) >= PI_ONLY_AGENT_SESSION_INDEX_VERSION

  for (const session of candidate.sessions) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) continue
    const runtime = (session as { agentRuntime?: unknown }).agentRuntime
    if (!isPiOnlySchema && runtime !== 'pi') {
      const label = runtime === undefined ? '缺失（旧版默认 Claude）' : String(runtime)
      throw new Error(
        `迁移文件包含不受支持的 Agent runtime: ${label}。请先使用仍支持该 runtime 的旧版 Domi 导出兼容数据。`,
      )
    }
    if (runtime !== undefined && runtime !== 'pi') {
      throw new Error(
        `迁移文件包含不受支持的 Agent runtime: ${String(runtime)}。请先使用仍支持该 runtime 的旧版 Domi 导出兼容数据。`,
      )
    }
  }
}

export interface PiOnlyAgentSessionIndex {
  version: number
  sessions: Array<Record<string, unknown>>
  [key: string]: unknown
}

/**
 * 合并导入会话时始终保留 Pi-only v2 语义；先完整校验两侧索引，再返回可原子写入的新对象。
 */
export function mergePiOnlyAgentSessionIndex(
  current: PiOnlyAgentSessionIndex | null,
  imported: { version?: number; sessions: Array<Record<string, unknown>> },
): PiOnlyAgentSessionIndex {
  const base: PiOnlyAgentSessionIndex = current ?? {
    version: PI_ONLY_AGENT_SESSION_INDEX_VERSION,
    sessions: [],
  }
  assertPiOnlyAgentSessionIndex(base)
  assertPiOnlyAgentSessionIndex(imported)

  const sessions = [...base.sessions]
  const currentIds = new Set(sessions.map(session => session['id']))
  for (const session of imported.sessions) {
    if (currentIds.has(session['id'])) continue
    sessions.push(session)
    currentIds.add(session['id'])
  }

  return {
    ...base,
    version: Math.max(
      base.version,
      imported.version ?? 1,
      PI_ONLY_AGENT_SESSION_INDEX_VERSION,
    ),
    sessions,
  }
}
