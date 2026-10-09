import { describe, expect, test } from 'bun:test'
import { resolveProtectedTargetAccess } from './session-target-protection.ts'

describe('Preview 项目保护', () => {
  test('Given Preview 中的项目 When 请求写入或重新交付 Then 拒绝但保留只读问答与宿主撤回确认', async () => {
    const call = { cwd: '/project', planSidecarDir: '/workbench/plan', input: {} }
    for (const toolName of ['Write', 'Edit']) {
      expect(await resolveProtectedTargetAccess({ ...call, toolName, toolSource: 'host' })).toMatchObject({ outcome: 'deny' })
    }
    for (const toolName of ['ReadyForReview', 'FinishWorktree', 'ApplyWorktree', 'TerminalRun']) {
      expect(await resolveProtectedTargetAccess({ ...call, toolName, toolSource: 'product' })).toMatchObject({ outcome: 'deny' })
    }
    for (const toolName of ['Read', 'Grep', 'LS']) {
      expect(await resolveProtectedTargetAccess({ ...call, toolName, toolSource: 'host' })).toMatchObject({ outcome: 'allow' })
    }
    expect(await resolveProtectedTargetAccess({ ...call, toolName: 'RequestWorktreePreviewRevision', toolSource: 'product' })).toMatchObject({ outcome: 'allow' })
    expect(await resolveProtectedTargetAccess({ ...call, toolName: 'RequestWorktreePreviewRevision', toolSource: 'mcp' })).toMatchObject({ outcome: 'deny' })
  })
})
