import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta } from '@domi/shared'
import type { AgentSessionHandoffDependencies, SessionHandoffSnapshot } from './agent-worktree-recovery-handoff.ts'

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => process.cwd() },
  BrowserWindow: class {},
  clipboard: {}, dialog: {}, nativeImage: { createFromPath: () => ({}) }, nativeTheme: {},
  powerMonitor: {}, powerSaveBlocker: {}, screen: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}))

let handoff: typeof import('./agent-worktree-recovery-handoff.ts')
let PiForkUnavailableError: typeof import('./agent-session-manager.ts').PiForkUnavailableError
beforeAll(async () => {
  handoff = await import('./agent-worktree-recovery-handoff.ts')
  ;({ PiForkUnavailableError } = await import('./agent-session-manager.ts'))
})

const source: AgentSessionMeta = {
  id: 'origin', title: '继续 Agent 任务', workspaceId: 'workspace', channelId: 'channel', modelId: 'model',
  executionPolicy: 'full-access', workflow: 'direct', permissionMode: 'bypassPermissions',
  piEntryBindings: { 'assistant-ready': 'pi-assistant-ready' },
  createdAt: 1, updatedAt: 1,
}

const isolatedSnapshot: SessionHandoffSnapshot = {
  originSessionId: 'origin', originTargetOwnerSessionId: 'owner',
  originTargetKind: 'isolated', originCheckoutId: 'checkout-old', originRevision: 12,
  projectId: 'workspace', projectName: 'Domi', iteration: 1,
  reviewId: 'review-1', previewId: 'preview-1', detachedReason: 'preview_modified',
  attemptedAction: 'finalize_preview', localHeadOid: 'a'.repeat(40), localHeadRef: 'refs/heads/main',
  localDirty: true, configuredBaseOid: 'b'.repeat(40), effectiveBaseOid: 'b'.repeat(40),
  isolatedHeadOid: 'c'.repeat(40), isolatedSnapshotOid: 'd'.repeat(40),
  previewWorkingTreeOid: 'e'.repeat(40), changedFiles: ['src/a.ts', 'src/new.bin'],
  summary: '放宽 Preview 撤回限制', detailsMarkdown: '## 目标\n\n完成撤回和提交恢复。',
  validationStatus: 'partial', validationSummary: '核心测试通过',
  tests: [{ command: 'bun test target.test.ts', status: 'passed', summary: 'passed' }],
}

const localSnapshot: SessionHandoffSnapshot = {
  originSessionId: 'origin', originTargetOwnerSessionId: 'owner',
  originTargetKind: 'local', originCheckoutId: 'local:workspace', originRevision: 4,
  projectId: 'workspace', projectName: 'Domi', localHeadOid: 'f'.repeat(40), localHeadRef: 'refs/heads/main',
  localDirty: false, changedFiles: [], summary: '继续普通 Local 会话', validationStatus: 'not_run', tests: [],
}

function child(kind: 'local' | 'isolated' = 'isolated'): AgentSessionMeta {
  return {
    ...source,
    id: 'child', title: '会话接力', parentSessionId: 'origin',
    sessionTarget: kind === 'isolated' ? { kind: 'isolated', checkoutId: 'checkout-new' } : { kind: 'local' },
  }
}

function dependencies(
  snapshot: SessionHandoffSnapshot,
  overrides: Partial<AgentSessionHandoffDependencies> = {},
): AgentSessionHandoffDependencies {
  return {
    getSession: () => source,
    getExistingHandoffSession: () => undefined,
    isSessionActive: () => false,
    captureSnapshot: async () => snapshot,
    findForkPoint: () => ({ status: 'available', assistantMessageUuid: 'assistant-ready', piEntryId: 'pi-assistant-ready' }),
    exportFallbackContext: () => '## 降级会话上下文\n\n- 用户：继续原任务',
    writeHandoff: async () => ({ sourcePath: 'C:/source/.context/handoff.md', relativePath: '.context/handoff.md' }),
    forkSession: async (input) => child(input.target.kind === 'isolated' ? 'isolated' : 'local'),
    createFallbackSession: () => ({ ...child('local'), id: 'fallback-child', sessionTarget: { kind: 'unselected' } }),
    bindFallbackSession: async (created, targetKind) => ({
      ...created,
      sessionTarget: targetKind === 'isolated' ? { kind: 'isolated', checkoutId: 'checkout-fallback' } : { kind: 'local' },
    }),
    updateSession: (id, updates) => ({ ...child(), id, ...updates }),
    resolveChildHandoffPath: () => 'C:/child/.context/handoff.md',
    rollbackFork: async () => undefined,
    runChild: async () => undefined,
    createActivationToken: () => 'activation-token',
    ...overrides,
  }
}

describe('Durable Agent Session handoff', () => {
  test('Local 会话可交接到新 Local 会话，不创建 Worktree 或复制文件', async () => {
    const forkCalls: unknown[] = []
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      forkSession: async (input, point) => { forkCalls.push({ input, point }); return child('local') },
    }))

    expect(forkCalls).toEqual([{
      input: { sessionId: 'origin', upToMessageUuid: 'assistant-ready', modelId: 'model', target: { kind: 'inherit' } },
      point: undefined,
    }])
    expect(prepared.child.handoffOriginSessionId).toBe('origin')
    expect(prepared.mode).toBe('fork')
  })

  test('没有安全 fork point 时自动降级为全新 Local 会话，并明确标记未继承完整历史', async () => {
    const writes: string[] = []
    const fallbackCalls: unknown[] = []
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      findForkPoint: () => ({ status: 'unavailable', reason: 'safe_fork_point_unavailable' }),
      writeHandoff: async (_session, _id, markdown) => {
        writes.push(markdown)
        return { sourcePath: 'C:/source/.context/handoff.md', relativePath: '.context/handoff.md' }
      },
      createFallbackSession: (input) => {
        fallbackCalls.push(input)
        return { ...child('local'), id: 'fallback-child', sessionTarget: { kind: 'unselected' } }
      },
    }))

    expect(prepared.mode).toBe('degraded')
    expect(prepared.degradedReason).toBe('safe_fork_point_unavailable')
    expect(prepared.child).toMatchObject({
      title: expect.stringContaining('降级接力'), handoffMode: 'degraded',
      handoffDegradedReason: 'safe_fork_point_unavailable', parentSessionId: 'origin',
    })
    expect(fallbackCalls).toHaveLength(1)
    expect(writes.at(-1)).toContain('降级交接：未继承完整 Pi 历史')
    expect(writes.at(-1)).toContain('降级会话上下文')
  })

  test('Local fork 不可用时仍可在 dirty 确认后降级到最新 HEAD 的 fresh Worktree', async () => {
    const dirty = { ...localSnapshot, localDirty: true }
    const fallbackTargets: string[] = []
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'isolated', confirmedIgnoreDirtyLocal: true,
    }, dependencies(dirty, {
      findForkPoint: () => ({ status: 'unavailable', reason: 'session_artifact_missing' }),
      bindFallbackSession: async (created, targetKind, snapshot) => {
        fallbackTargets.push(`${targetKind}:${snapshot.localHeadOid}:${snapshot.localDirty}`)
        return { ...created, sessionTarget: { kind: 'isolated', checkoutId: 'checkout-fallback' } }
      },
    }))

    expect(prepared.mode).toBe('degraded')
    expect(fallbackTargets).toEqual([`isolated:${dirty.localHeadOid}:true`])
  })

  test('Pi fork artifact 故障时回滚正常 fork 半成品并降级到 fresh Worktree', async () => {
    const fallbackTargets: string[] = []
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 12, targetKind: 'isolated', confirmedIgnoreDirtyLocal: true,
    }, dependencies(isolatedSnapshot, {
      forkSession: async () => { throw new PiForkUnavailableError('session_artifact_unreadable', 'broken artifact') },
      bindFallbackSession: async (created, targetKind, snapshot) => {
        fallbackTargets.push(`${targetKind}:${snapshot.localHeadOid}`)
        return { ...created, sessionTarget: { kind: 'isolated', checkoutId: 'checkout-fallback' } }
      },
    }))

    expect(prepared).toMatchObject({ mode: 'degraded', degradedReason: 'session_artifact_unreadable' })
    expect(fallbackTargets).toEqual([`isolated:${isolatedSnapshot.localHeadOid}`])
  })

  test('普通领域或安全错误不能伪装成 fork 故障并自动降级', async () => {
    let fallbackCount = 0
    await expect(handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      forkSession: async () => { throw new Error('permission denied') },
      createFallbackSession: () => { fallbackCount += 1; return child('local') },
    }))).rejects.toThrow('permission denied')
    expect(fallbackCount).toBe(0)
  })

  test('Local 会话可确认 dirty 边界后交接到基于最新 HEAD 的新 Worktree', async () => {
    const dirty = { ...localSnapshot, localDirty: true }
    const forkCalls: unknown[] = []
    await expect(handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'isolated', confirmedIgnoreDirtyLocal: false,
    }, dependencies(dirty))).rejects.toThrow('明确确认')

    await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'isolated', confirmedIgnoreDirtyLocal: true,
    }, dependencies(dirty, {
      forkSession: async (input, point) => { forkCalls.push({ input, point }); return child() },
    }))

    expect(forkCalls).toEqual([{
      input: { sessionId: 'origin', upToMessageUuid: 'assistant-ready', modelId: 'model', target: { kind: 'isolated', confirmDirty: true } },
      point: expect.objectContaining({ expectedCurrentOid: dirty.localHeadOid, dirtyConfirmed: true, expectedEntryRole: 'assistant' }),
    }])
  })

  test('正常或 detached Worktree 均可用 retained snapshot 交接到 fresh Worktree', async () => {
    const markdown = handoff.buildSessionHandoffMarkdown(isolatedSnapshot, 'handoff-1', 'isolated')
    const runs: unknown[] = []
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 12, targetKind: 'isolated', confirmedIgnoreDirtyLocal: true,
    }, dependencies(isolatedSnapshot, { runChild: async (input) => { runs.push(input) } }))

    expect(markdown).toContain(isolatedSnapshot.isolatedSnapshotOid!)
    expect(markdown).toContain('只恢复仍缺失的任务增量')
    expect(markdown).toContain('不要 reset、rebase')
    expect(markdown).toContain('ReadyForReview')
    prepared.launch()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs).toHaveLength(1)
    expect((runs[0] as { userMessage: string }).userMessage).toContain('C:/child/.context/handoff.md')
  })

  test('降级上下文只导出有界 user/assistant 文本，并保留首个用户任务与最近对话', () => {
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: '最初任务' }] } },
      ...Array.from({ length: 40 }, (_, index) => ({
        type: index % 2 === 0 ? 'assistant' : 'user',
        message: { content: [{ type: 'text', text: `${index}:${'x'.repeat(2_000)}` }] },
      })),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'secret' } }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '最近问题 C:\\Users\\A\\private\\secret.txt' }] } },
    ] as never[]

    const exported = handoff.exportBoundedSessionContext(messages)

    expect(exported).toContain('最初任务')
    expect(exported).toContain('最近问题')
    expect(exported).not.toContain('private\\secret.txt')
    expect(exported).toContain('[host-path]')
    expect(exported.length).toBeLessThanOrEqual(36_000)
  })

  test('捕获结果若不属于实际点击会话则 fail closed，不能把其它会话证据绑定到当前 fork', async () => {
    await expect(handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies({ ...localSnapshot, originSessionId: 'other-session' }))).rejects.toMatchObject({ code: 'stale_target' })
  })

  test('Worktree 不允许直接交接到 Local，以免绕过 Preview', async () => {
    await expect(handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 12, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(isolatedSnapshot))).rejects.toThrow('不能直接交接到 Local')
  })

  test('来源 Agent 仍在运行时拒绝交接，避免并行写同一目标', async () => {
    await expect(handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, { isSessionActive: () => true }))).rejects.toThrow('仍在运行')
  })

  test('相同来源快照和目标重复点击时复用同一会话，重启后可续跑未启动 handoff', async () => {
    const id = handoff.buildSessionHandoffId(localSnapshot, 'local', 'pi-assistant-ready')
    const existing = { ...child('local'), handoffId: id, handoffOriginSessionId: 'origin' }
    const runs: unknown[] = []
    let forkCount = 0
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      getExistingHandoffSession: () => existing,
      forkSession: async () => { forkCount += 1; return child('local') },
      runChild: async (input) => { runs.push(input) },
    }))

    expect(prepared.reused).toBe(true)
    expect(forkCount).toBe(0)
    prepared.launch()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs).toHaveLength(1)
  })

  test('降级 handoff 在重复点击和重启后复用原模式与稳定原因', async () => {
    const unavailable = { status: 'unavailable', reason: 'session_artifact_missing' } as const
    const id = handoff.buildSessionHandoffId(
      localSnapshot,
      'local',
      `degraded:${unavailable.reason}:${source.updatedAt}`,
    )
    const existing = {
      ...child('local'), id: 'fallback-existing', handoffId: id, handoffOriginSessionId: 'origin',
      handoffMode: 'degraded' as const, handoffDegradedReason: unavailable.reason,
    }
    let fallbackCreates = 0
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      findForkPoint: () => unavailable,
      getExistingHandoffSession: () => existing,
      createFallbackSession: () => { fallbackCreates += 1; return child('local') },
    }))

    expect(prepared).toMatchObject({ reused: true, mode: 'degraded', degradedReason: 'session_artifact_missing' })
    expect(fallbackCreates).toBe(0)
  })

  test('降级会话 bind 或 metadata persistence 失败会回滚新资源', async () => {
    const rollbacks: string[] = []
    await expect(handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      findForkPoint: () => ({ status: 'unavailable', reason: 'safe_fork_point_unavailable' }),
      bindFallbackSession: async () => { throw new Error('bind failed') },
      rollbackFork: async (id) => { rollbacks.push(id) },
    }))).rejects.toThrow('bind failed')
    expect(rollbacks).toEqual(['fallback-child'])
  })

  test('降级 runner 启动被拒绝时也回滚 fresh 会话和 Target', async () => {
    const rollbacks: string[] = []
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      findForkPoint: () => ({ status: 'unavailable', reason: 'session_artifact_missing' }),
      runChild: async () => { throw new Error('fallback runner unavailable') },
      rollbackFork: async (id) => { rollbacks.push(id) },
    }))
    prepared.launch()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rollbacks).toEqual(['fallback-child'])
  })

  test('Fork 后准备或 runner 启动失败会回滚新资源，来源会话与 checkout 保持不变', async () => {
    const prepareRollbacks: string[] = []
    await expect(handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      updateSession: () => { throw new Error('persist failed') },
      rollbackFork: async (id) => { prepareRollbacks.push(id) },
    }))).rejects.toThrow('persist failed')
    expect(prepareRollbacks).toEqual(['child'])

    const launchRollbacks: string[] = []
    const prepared = await handoff.prepareAgentSessionHandoff({
      originSessionId: 'origin', expectedRevision: 4, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    }, dependencies(localSnapshot, {
      runChild: async () => { throw new Error('runner unavailable') },
      rollbackFork: async (id) => { launchRollbacks.push(id) },
    }))
    prepared.launch()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(launchRollbacks).toEqual(['child'])
  })
})
