import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { convertToLlm, type SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_PI_CONTEXT_COMPACTOR_SETTINGS,
  buildPiContextCompactorPinnedFacts,
  preflightPiContextCompaction,
  projectPiContextCompactorMessages,
  type PiContextCompactorHostSnapshot,
} from './pi-context-compactor'

function userEntry(id: string, text: string, parentId: string | null): SessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0)).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1_700_000_000_000,
    },
  }
}

function assistantEntry(id: string, text: string, parentId: string | null): SessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0)).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-responses',
      provider: 'openai-responses',
      model: 'gpt-test',
      stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: 1_700_000_000_000,
    },
  }
}

function compactionEntry(
  id: string,
  parentId: string,
  firstKeptEntryId: string,
  summary = '## Goal\nContinue the task.',
): SessionEntry {
  return {
    type: 'compaction',
    id,
    parentId,
    timestamp: new Date(1_700_000_100_000).toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore: 80_000,
  }
}

const enabledSettings = { ...DEFAULT_PI_CONTEXT_COMPACTOR_SETTINGS, enabled: true }

const hostSnapshot: PiContextCompactorHostSnapshot = {
  sessionTarget: {
    kind: 'isolated',
    ownership: 'owner',
    checkoutId: 'checkout-46571103',
    revision: 8,
    checkpointCount: 2,
  },
  delivery: {
    state: 'ready_for_review',
    review: {
      reviewId: 'review-771c4385',
      validationStatus: 'partial',
      tests: [
        { command: 'bun test target.test.ts', status: 'passed' },
        { command: 'bun run typecheck', status: 'not_run' },
      ],
    },
  },
  tasks: [
    { id: '1', subject: '实现 ContextCompactor', status: 'in_progress', activeForm: '正在实现' },
    { id: '2', subject: '旧任务', status: 'completed' },
  ],
}

describe('Pi ContextCompactor', () => {
  test('projects bounded recent user corrections and appends current host facts after the stale compaction summary without mutating runtime messages', () => {
    const branch: SessionEntry[] = [
      userEntry('u1', 'Keep the original goal.', null),
      assistantEntry('a1', 'Working.', 'u1'),
      userEntry('u2', 'FINAL CONSTRAINT: never edit secrets.env', 'a1'),
      assistantEntry('a2', 'Acknowledged.', 'u2'),
      userEntry('u3', 'Retained suffix user message.', 'a2'),
      compactionEntry('c1', 'u3', 'u3'),
    ]
    const runtimeMessages: AgentMessage[] = [
      { role: 'compactionSummary', summary: '## Goal\nContinue the task.', tokensBefore: 80_000, timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: 'Retained suffix user message.' }], timestamp: 2 },
    ]
    const source = structuredClone(runtimeMessages)

    const projected = projectPiContextCompactorMessages({
      messages: runtimeMessages,
      branchEntries: branch,
      hostSnapshot,
      settings: enabledSettings,
    })

    expect(projected.metadata.enhanced).toBe(true)
    expect(projected.messages).not.toBe(runtimeMessages)
    expect(runtimeMessages).toEqual(source)
    expect(projected.messages[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(projected.messages[0])).toContain('Keep the original goal.')
    expect(JSON.stringify(projected.messages[1])).toContain('FINAL CONSTRAINT: never edit secrets.env')
    expect(projected.messages[2]).toMatchObject({ role: 'compactionSummary' })
    expect(projected.messages[3]).toMatchObject({
      role: 'custom',
      customType: 'domi_context_compactor_pinned_facts',
      display: false,
    })
    expect(JSON.stringify(projected.messages[3])).toContain('checkout-46571103')
    expect(JSON.stringify(projected.messages[3])).toContain('review-771c4385')
    expect(JSON.stringify(projected.messages[3])).toContain('bun run typecheck')
    expect(JSON.stringify(projected.messages[3])).toContain('实现 ContextCompactor')
    expect(JSON.stringify(projected.messages)).not.toContain('旧任务')
    const providerMessages = convertToLlm(projected.messages)
    expect(providerMessages[2]?.role).toBe('user')
    expect(JSON.stringify(providerMessages[2])).toContain('Continue the task.')
    expect(providerMessages[3]?.role).toBe('user')
    expect(JSON.stringify(providerMessages[3])).toContain('checkout-46571103')
  })

  test('excludes internal continuation prompts and strips Domi-injected context from recovered user evidence', () => {
    const branch: SessionEntry[] = [
      userEntry('u1', '<conversation_history>stale host history</conversation_history>\nREAL USER CORRECTION', null),
      userEntry('u2', '<domi_compaction_continuation>\n继续原任务\n</domi_compaction_continuation>', 'u1'),
      userEntry('u3', 'retained', 'u2'),
      compactionEntry('c1', 'u3', 'u3'),
    ]
    const runtimeMessages: AgentMessage[] = [
      { role: 'compactionSummary', summary: 'Continue.', tokensBefore: 80_000, timestamp: 1 },
    ]

    const projected = projectPiContextCompactorMessages({
      messages: runtimeMessages,
      branchEntries: branch,
      hostSnapshot: {},
      settings: enabledSettings,
    })
    const serialized = JSON.stringify(projected.messages)

    expect(serialized).toContain('REAL USER CORRECTION')
    expect(serialized).not.toContain('stale host history')
    expect(serialized).not.toContain('domi_compaction_continuation')
    expect(projected.metadata.recentUserCount).toBe(1)
  })

  test('uses one total recent-user budget and preserves the head and tail of the newest oversized correction', () => {
    const newest = `USER HEAD\n${'middle '.repeat(4_000)}\nFINAL CONSTRAINT: never edit secrets.env`
    const branch: SessionEntry[] = [
      userEntry('u1', 'older correction that should lose the shared budget', null),
      assistantEntry('a1', 'Working.', 'u1'),
      userEntry('u2', newest, 'a1'),
      assistantEntry('a2', 'Acknowledged.', 'u2'),
      userEntry('u3', 'retained', 'a2'),
      compactionEntry('c1', 'u3', 'u3'),
    ]
    const projected = projectPiContextCompactorMessages({
      messages: [{ role: 'compactionSummary', summary: 'checkpoint', tokensBefore: 80_000, timestamp: 1 }],
      branchEntries: branch,
      hostSnapshot: {},
      settings: {
        ...DEFAULT_PI_CONTEXT_COMPACTOR_SETTINGS,
        enabled: true,
        recentUserTokenBudget: 100,
        pinnedFactsTokenBudget: 0,
        maxEnhancementTokens: 100,
      },
    })
    const text = JSON.stringify(projected.messages)

    expect(text).not.toContain('older correction that should lose the shared budget')
    expect(text).toContain('USER HEAD')
    expect(text).toContain('characters omitted from provider-only recent user context')
    expect(text).toContain('FINAL CONSTRAINT: never edit secrets.env')
    expect(projected.metadata.recentUserTokens).toBeLessThanOrEqual(100)
  })

  test('reconstructs newest original user corrections across multiple persisted Pi compactions', () => {
    const branch: SessionEntry[] = [
      userEntry('u1', 'original goal', null),
      userEntry('u2', 'CORRECTION FROM FIRST CHECKPOINT', 'u1'),
      userEntry('u3', 'first retained suffix', 'u2'),
      compactionEntry('c1', 'u3', 'u3', 'first checkpoint'),
      userEntry('u4', 'CORRECTION FROM SECOND CHECKPOINT', 'c1'),
      userEntry('u5', 'latest retained suffix', 'u4'),
      compactionEntry('c2', 'u5', 'u5', 'second checkpoint'),
    ]

    const projected = projectPiContextCompactorMessages({
      messages: [{ role: 'compactionSummary', summary: 'second checkpoint', tokensBefore: 90_000, timestamp: 5 }],
      branchEntries: branch,
      hostSnapshot: {},
      settings: enabledSettings,
    })
    const text = JSON.stringify(projected.messages)

    expect(text).toContain('CORRECTION FROM FIRST CHECKPOINT')
    expect(text).toContain('CORRECTION FROM SECOND CHECKPOINT')
    expect(text).not.toContain('latest retained suffix')
  })

  test('keeps feature-off provider context byte-equivalent and avoids rebuilding host facts', () => {
    const messages: AgentMessage[] = [{ role: 'compactionSummary', summary: 'checkpoint', tokensBefore: 10, timestamp: 1 }]
    const projected = projectPiContextCompactorMessages({
      messages,
      branchEntries: [],
      hostSnapshot,
      settings: DEFAULT_PI_CONTEXT_COMPACTOR_SETTINGS,
    })

    expect(projected.messages).toEqual(messages)
    expect(JSON.stringify(projected.messages)).toBe(JSON.stringify(messages))
    expect(projected.metadata.enhanced).toBe(false)
  })

  test('accepts working delivery evidence and ignores historical, quoted, or negated review wording', () => {
    const workingSnapshot: PiContextCompactorHostSnapshot = {
      delivery: { state: 'working' },
    }
    expect(buildPiContextCompactorPinnedFacts(workingSnapshot)).toEqual([
      expect.objectContaining({
        factId: 'delivery-working',
        text: 'Worktree delivery state is `working`; no review has been prepared yet.',
      }),
    ])

    const branch: SessionEntry[] = [
      userEntry('u1', 'Continue implementation.', null),
      userEntry('u2', 'retained', 'u1'),
      compactionEntry('c1', 'u2', 'u2'),
    ]
    const summaries = [
      'Historical note: an earlier checkpoint said review has been prepared.',
      'Quoted old output: "review has been prepared".',
      'Current state: no review has been prepared yet.',
      '旧摘要曾提到 review has been prepared，但这不是当前状态。',
    ]

    for (const summary of summaries) {
      const projected = projectPiContextCompactorMessages({
        messages: [{ role: 'compactionSummary', summary, tokensBefore: 80_000, timestamp: 1 }],
        branchEntries: branch,
        hostSnapshot: workingSnapshot,
        settings: enabledSettings,
      })
      expect(projected.metadata.enhanced).toBe(true)
      expect(JSON.stringify(projected.messages)).toContain('no review has been prepared yet')
    }
  })

  test('pins cumulative delivery context after a major review is withdrawn for a micro-adjustment', () => {
    const facts = buildPiContextCompactorPinnedFacts({
      sessionTarget: {
        kind: 'isolated',
        ownership: 'owner',
        checkoutId: 'checkout-cumulative',
        revision: 8,
        deliveryBaseOid: 'a'.repeat(40),
        previousReview: {
          reviewId: 'review-major',
          iteration: 2,
          summary: '完成完整工作动态侧栏',
          suggestedCommitMessage: 'feat(electron): 添加完整工作动态侧栏\n\n- 新增任务概览\n- 支持悬浮预览',
          changedFiles: ['WorkActivityView.tsx', 'WorkActivitySidebarOverview.tsx'],
        },
      },
      delivery: { state: 'working' },
    })

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factId: 'cumulative-delivery-review',
        text: expect.stringContaining('cumulative diff'),
      }),
      expect.objectContaining({
        factId: 'cumulative-delivery-review',
        text: expect.stringContaining('完成完整工作动态侧栏'),
      }),
      expect.objectContaining({
        factId: 'delivery-working',
      }),
    ]))
    const cumulative = facts.find(fact => fact.factId === 'cumulative-delivery-review')
    expect(cumulative?.text).toContain('main feature must lead the subject')
    expect(cumulative?.text).toContain('latest micro-adjustment is secondary')
    expect(cumulative?.text).toContain('Do not stack historical commit messages')
    expect(cumulative?.text).toContain('WorkActivitySidebarOverview.tsx')
  })

  test('lets current host facts supersede a stale structured checkpoint after delivery state changes', () => {
    const branch: SessionEntry[] = [
      userEntry('u1', 'Run typecheck before delivery.', null),
      userEntry('u2', 'retained', 'u1'),
      compactionEntry('c1', 'u2', 'u2'),
    ]
    const staleSummary = '## Current State\nWorktree delivery state is `ready_for_review`; review has been prepared.'

    const projected = projectPiContextCompactorMessages({
      messages: [{
        role: 'compactionSummary',
        summary: staleSummary,
        tokensBefore: 80_000,
        timestamp: 1,
      }],
      branchEntries: branch,
      hostSnapshot: { delivery: { state: 'working' } },
      settings: enabledSettings,
    })

    const summaryIndex = projected.messages.findIndex(message => message.role === 'compactionSummary')
    const pinnedIndex = projected.messages.findIndex(message => message.role === 'custom')
    expect(pinnedIndex).toBeGreaterThan(summaryIndex)
    expect(JSON.stringify(projected.messages[pinnedIndex])).toContain('delivery state is `working`')
  })

  test('preflight distinguishes Pi enhancement, immediate baseline fallback, and explicit cancellation', () => {
    const preparation = {
      firstKeptEntryId: 'u3',
      messagesToSummarize: [{ role: 'user', content: [{ type: 'text', text: 'Keep this constraint.' }], timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 80_000,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    } as Parameters<typeof preflightPiContextCompaction>[0]['preparation']

    expect(preflightPiContextCompaction({
      preparation,
      hostSnapshot,
      settings: enabledSettings,
      signal: new AbortController().signal,
    }).kind).toBe('enhance_pi')

    expect(preflightPiContextCompaction({
      preparation: { ...preparation, messagesToSummarize: [], turnPrefixMessages: [] },
      hostSnapshot: {},
      settings: enabledSettings,
      signal: new AbortController().signal,
    }).kind).toBe('fallback_pi')

    expect(preflightPiContextCompaction({
      preparation,
      hostSnapshot: { ...hostSnapshot, terminatingToolName: 'ReadyForReview' },
      settings: enabledSettings,
      signal: new AbortController().signal,
    })).toMatchObject({ kind: 'cancel', reason: 'session_terminating' })

    expect(preflightPiContextCompaction({
      preparation,
      hostSnapshot: {
        delivery: {
          state: 'ready_for_review',
          review: {
            reviewId: 'review-invalid',
            validationStatus: 'passed',
            tests: [{ command: 'bun test', status: 'failed' }],
          },
        },
      },
      settings: { ...enabledSettings, failurePolicy: 'strict_cancel' },
      signal: new AbortController().signal,
    })).toMatchObject({ kind: 'fallback_pi', reason: 'evidence_validation_failed' })

    const aborted = new AbortController()
    aborted.abort()
    expect(preflightPiContextCompaction({
      preparation,
      hostSnapshot,
      settings: enabledSettings,
      signal: aborted.signal,
    })).toMatchObject({ kind: 'cancel', reason: 'aborted' })
  })

  test('applies failure policy consistently to unexpected preflight candidate errors', () => {
    const malformedSnapshot = {
      tasks: [{ id: 'bad-task', subject: null, status: 'in_progress' }],
    } as unknown as PiContextCompactorHostSnapshot
    const preparation = {
      firstKeptEntryId: 'u2',
      messagesToSummarize: [{ role: 'user', content: [{ type: 'text', text: 'Keep this constraint.' }], timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 80_000,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    } as Parameters<typeof preflightPiContextCompaction>[0]['preparation']

    expect(preflightPiContextCompaction({
      preparation,
      hostSnapshot: malformedSnapshot,
      settings: enabledSettings,
      signal: new AbortController().signal,
    })).toMatchObject({ kind: 'fallback_pi', reason: 'candidate_unavailable' })

    expect(preflightPiContextCompaction({
      preparation,
      hostSnapshot: malformedSnapshot,
      settings: { ...enabledSettings, failurePolicy: 'strict_cancel' },
      signal: new AbortController().signal,
    })).toMatchObject({ kind: 'cancel', reason: 'candidate_unavailable' })
  })

  test('keeps a large ready-for-review snapshot within the pinned-facts budget', () => {
    const changedFiles = Array.from({ length: 333 }, (_, index) => `service/src/feature-${index.toString().padStart(3, '0')}.ts`)
    const facts = buildPiContextCompactorPinnedFacts({
      sessionTarget: hostSnapshot.sessionTarget,
      delivery: {
        state: 'ready_for_review',
        review: {
          reviewId: 'review-large-333',
          validationStatus: 'passed',
          validationSummary: '全部验证通过',
          summary: '完成大型 SET 结构化绑定修复',
          changedFiles,
          suggestedCommitMessage: 'fix(set): 修复大型 SET 结构化绑定',
          tests: [
            { command: 'pnpm -C service test -- --runInBand set.spec.ts', status: 'passed' },
            { command: 'git diff --check', status: 'passed' },
          ],
        },
      },
    })

    const reviewFact = facts.find(fact => fact.factId === 'delivery-review')
    expect(reviewFact?.text).toContain('333 changed files')
    expect(reviewFact?.text).toContain('feature-000.ts')
    expect(reviewFact?.text).toContain('feature-332.ts')
    expect(reviewFact?.text).toContain('313 paths omitted')
    expect(Math.ceil((reviewFact?.text.length ?? 0) / 4)).toBeLessThanOrEqual(enabledSettings.pinnedFactsTokenBudget)
  })

  test('rejects internally inconsistent host validation evidence', () => {
    expect(() => buildPiContextCompactorPinnedFacts({
      delivery: {
        state: 'ready_for_review',
        review: {
          reviewId: 'review-conflict',
          validationStatus: 'passed',
          tests: [{ command: 'bun test', status: 'failed' }],
        },
      },
    })).toThrow('Pinned fact evidence validation failed')
  })
})
