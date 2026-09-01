import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, SessionTargetView } from '@domi/shared'
import type { AgentWorktreeHandoffDependencies } from './agent-worktree-handoff'

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => process.cwd() },
  BrowserWindow: class {},
  clipboard: {}, dialog: {}, nativeImage: { createFromPath: () => ({}) }, nativeTheme: {},
  powerMonitor: {}, powerSaveBlocker: {}, screen: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}))

let handoff: typeof import('./agent-worktree-handoff')
beforeAll(async () => { handoff = await import('./agent-worktree-handoff') })

const parent: AgentSessionMeta = {
  id: 'parent', title: 'Parent', workspaceId: 'workspace', channelId: 'channel', modelId: 'model',
  createdAt: 1, updatedAt: 1,
}

const localTarget: SessionTargetView = {
  project: { id: 'project', name: 'Project' },
  checkout: { id: 'local:project', kind: 'local', label: 'Local Checkout', phase: 'ready' },
  source: { ref: 'refs/heads/main', oid: 'abc' }, current: { branch: 'main', oid: 'abc' },
  ownership: 'owner', dirty: false, revision: 1,
}

function dependencies(overrides: Partial<AgentWorktreeHandoffDependencies> = {}): AgentWorktreeHandoffDependencies {
  return {
    getSession: () => parent,
    inspectTarget: async () => localTarget,
    forkSession: async () => ({ ...parent, id: 'child', title: 'Parent (worktree)', sessionTarget: { kind: 'isolated', checkoutId: 'checkout' } }),
    rollbackFork: async () => undefined,
    runChild: async () => undefined,
    ...overrides,
  }
}

const request = {
  parentSessionId: 'parent',
  assistantMessageUuid: 'assistant-uuid',
  toolResultMessageUuid: 'tool-result-uuid',
  piToolResultEntryId: 'tool-result-entry',
  task: '继续实现功能',
  targetRevision: 1,
  targetCurrentOid: 'abc',
  dirtyConfirmed: false,
  channelId: 'channel',
  modelId: 'model',
  workspaceId: 'workspace',
  executionPolicy: 'full-access' as const,
  workflow: 'direct' as const,
  permissionMode: 'bypassPermissions' as const,
}

describe('Agent Worktree handoff', () => {
  test('仅直接交互式顶层 Local run 可获得 handoff 工具', () => {
    expect(handoff.canOfferAgentWorktreeHandoff({ targetKind: 'local', triggeredBy: 'user' })).toBe(true)
    expect(handoff.canOfferAgentWorktreeHandoff({ targetKind: 'local', triggeredBy: 'automation' })).toBe(false)
    expect(handoff.canOfferAgentWorktreeHandoff({ targetKind: 'local', triggeredBy: 'delegation' })).toBe(false)
    expect(handoff.canOfferAgentWorktreeHandoff({ targetKind: 'local', triggeredBy: 'user', sourceDelegationId: 'delegation' })).toBe(false)
    expect(handoff.canOfferAgentWorktreeHandoff({ targetKind: 'isolated', triggeredBy: 'user' })).toBe(false)
  })

  test('Given dirty Local 无宿主确认 When prepare Then fail closed', async () => {
    await expect(handoff.prepareAgentWorktreeHandoff(request, dependencies({
      inspectTarget: async () => ({ ...localTarget, dirty: true }),
    }))).rejects.toThrow('没有可信用户确认')
  })

  test('Given 确认后 target revision 改变 When prepare Then fail closed', async () => {
    await expect(handoff.prepareAgentWorktreeHandoff(request, dependencies({
      inspectTarget: async () => ({ ...localTarget, revision: 2 }),
    }))).rejects.toThrow('确认后已变化')
  })

  test('Given 确认等待期间 Local HEAD 被提交且当前已 clean When prepare Then 刷新安全证明并继续 Fork', async () => {
    const forkInputs: unknown[] = []
    const forkPoints: unknown[] = []
    await handoff.prepareAgentWorktreeHandoff({ ...request, dirtyConfirmed: true }, dependencies({
      inspectTarget: async () => ({
        ...localTarget,
        source: { ...localTarget.source, oid: 'def' },
        current: { ...localTarget.current, oid: 'def' },
        dirty: false,
      }),
      forkSession: async (input, point) => {
        forkInputs.push(input)
        forkPoints.push(point)
        return { ...parent, id: 'child', title: 'Child' }
      },
    }))

    expect(forkInputs).toEqual([{
      sessionId: 'parent',
      upToMessageUuid: 'assistant-uuid',
      modelId: 'model',
      target: { kind: 'isolated', confirmDirty: false },
    }])
    expect(forkPoints).toEqual([{
      piEntryId: 'tool-result-entry',
      uiUpToMessageUuid: 'tool-result-uuid',
      expectedCurrentOid: 'def',
      dirtyConfirmed: false,
    }])
  })

  test('Given 确认后 Local HEAD 与 dirty 状态同时变化 When prepare Then fail closed', async () => {
    await expect(handoff.prepareAgentWorktreeHandoff(
      { ...request, dirtyConfirmed: true },
      dependencies({
        inspectTarget: async () => ({
          ...localTarget,
          current: { ...localTarget.current, oid: 'def' },
          dirty: true,
        }),
      }),
    )).rejects.toThrow('HEAD 在确认后变化且仍有未提交修改')
  })

  test('Given 闭合 tool result fork point When 准备 handoff Then Fork 并可自动续跑或回滚', async () => {
    const forkInputs: unknown[] = []
    const forkPoints: unknown[] = []
    const rolledBack: string[] = []
    const runs: Array<{ input: Record<string, unknown>; source?: string; originSessionId?: string; activationToken?: string }> = []
    const prepared = await handoff.prepareAgentWorktreeHandoff(request, dependencies({
      forkSession: async (input, point) => {
        forkInputs.push(input); forkPoints.push(point)
        return { ...parent, id: 'child', title: 'Child' }
      },
      rollbackFork: async (id) => { rolledBack.push(id) },
      runChild: async (input, callbacks) => {
        runs.push({ input: input as unknown as Record<string, unknown>, source: callbacks.source, originSessionId: callbacks.originSessionId, activationToken: callbacks.activationToken })
      },
    }))

    expect(forkInputs).toEqual([{
      sessionId: 'parent', upToMessageUuid: 'assistant-uuid', modelId: 'model',
      target: { kind: 'isolated', confirmDirty: false },
    }])
    expect(forkPoints).toEqual([{
      piEntryId: 'tool-result-entry',
      uiUpToMessageUuid: 'tool-result-uuid',
      expectedCurrentOid: 'abc',
      dirtyConfirmed: false,
    }])
    expect(runs).toHaveLength(0)
    prepared.launch()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs[0]?.source).toBe('worktree_handoff')
    expect(runs[0]?.originSessionId).toBe('parent')
    expect(runs[0]?.activationToken).toBe(prepared.activationToken)
    expect(runs[0]?.input.sessionId).toBe('child')
    expect(runs[0]?.input.userMessage).toContain('继续实现功能')
    await prepared.rollback()
    expect(rolledBack).toEqual(['child'])
  })

  test('continuation prompt 明确新目标与未复制 Local 修改', () => {
    const prompt = handoff.buildWorktreeHandoffContinuationPrompt('继续任务', 'parent')
    expect(prompt).toContain('新的 managed Worktree')
    expect(prompt).toContain('未提交的修改保持原状，没有复制')
  })
})
