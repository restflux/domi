import { describe, expect, test } from 'bun:test'
import {
  assertMigrationExportRequest,
  assertMigrationManifest,
  assertPiOnlyAgentSessionIndex,
  mergePiOnlyAgentSessionIndex,
} from './migration-boundary.ts'

describe('Domi 迁移 IPC 边界', () => {
  test('Given renderer 传入非法导出模式 When 校验请求 Then 在导出副作用前拒绝', () => {
    expect(() => assertMigrationExportRequest({ mode: 'invalid', outputPath: 'x' })).toThrow('无效的迁移模式')
    expect(() => assertMigrationExportRequest(null)).toThrow('无效的迁移模式')
    expect(() => assertMigrationExportRequest({ mode: 'share', outputPath: 'x' })).not.toThrow()
  })

  test('Given 迁移归档伪造 manifest.mode When 解析或确认导入 Then 拒绝该归档', () => {
    expect(() => assertMigrationManifest({ mode: 'unsafe', version: '2.0' })).toThrow('无效的迁移模式')
    expect(() => assertMigrationManifest({ mode: 'personal', version: '2.0' })).not.toThrow()
  })
})

describe('Pi-only Agent 会话导入边界', () => {
  test('Given 旧 schema 明确记录 Pi runtime When 导入前校验 Then 允许迁移', () => {
    expect(() => assertPiOnlyAgentSessionIndex({
      version: 1,
      sessions: [{ id: 'pi-explicit', agentRuntime: 'pi' }],
    })).not.toThrow()
  })

  test('Given 旧 schema 缺少 runtime When 导入前校验 Then 按旧版默认 Claude 语义拒绝', () => {
    expect(() => assertPiOnlyAgentSessionIndex({
      version: 1,
      sessions: [{ id: 'legacy-missing-runtime' }],
    })).toThrow('缺失（旧版默认 Claude）')
  })

  test('Given 任意 schema 明确记录 Claude runtime When 导入前校验 Then 在写入前拒绝', () => {
    expect(() => assertPiOnlyAgentSessionIndex({
      version: 2,
      sessions: [{ id: 'legacy-claude', agentRuntime: 'claude' }],
    })).toThrow('不受支持的 Agent runtime: claude')
  })

  test('Given Pi-only schema 已删除 runtime 字段 When 导入前校验 Then 保持兼容', () => {
    expect(() => assertPiOnlyAgentSessionIndex({
      version: 2,
      sessions: [{ id: 'pi-only-session' }],
    })).not.toThrow()
  })

  test('Given 空目标索引导入 v2 会话 When 合并 Then 输出仍为 v2 且可由 Pi-only reader 接受', () => {
    const merged = mergePiOnlyAgentSessionIndex(null, {
      version: 2,
      sessions: [{ id: 'imported-v2', workspaceId: 'workspace-a' }],
    })

    expect(merged.version).toBe(2)
    expect(merged.sessions).toHaveLength(1)
    expect(() => assertPiOnlyAgentSessionIndex(merged)).not.toThrow()
  })

  test('Given 当前旧索引缺少 runtime When 尝试合并 Then 在输出或写盘前拒绝', () => {
    expect(() => mergePiOnlyAgentSessionIndex({
      version: 1,
      sessions: [{ id: 'legacy-current' }],
    }, {
      version: 2,
      sessions: [{ id: 'imported-v2' }],
    })).toThrow('缺失（旧版默认 Claude）')
  })
})
