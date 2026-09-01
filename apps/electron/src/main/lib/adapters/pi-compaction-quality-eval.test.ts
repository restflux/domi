import { describe, expect, test } from 'bun:test'
import {
  buildCheckpointReplacementHistory,
  compareCheckpointStrategies,
  evaluateCheckpointArtifact,
  evaluateCheckpointComparisons,
  evaluateCheckpointSuite,
  renderCheckpointAblationReport,
  renderCheckpointSuiteReport,
  runBlindedCheckpointReplay,
  runCheckpointAblationReplay,
  validateCheckpointPinnedFacts,
  runCheckpointStrategy,
  PI_BASELINE_CHECKPOINT_STRATEGY,
  PI_RECENT_USER_CHECKPOINT_STRATEGY,
  PI_RECENT_USER_PINNED_CHECKPOINT_STRATEGY,
  CODEX_STYLE_CHECKPOINT_STRATEGY,
  type CheckpointQualityFixture,
} from './pi-compaction-quality-eval'
import { CHECKPOINT_QUALITY_FIXTURES } from './pi-compaction-quality-fixtures'

const fixture: CheckpointQualityFixture = {
  id: 'user-correction-before-large-tool-turn',
  title: '保留压缩前的用户纠正和精确约束',
  compactedMessages: [
    {
      id: 'u1',
      role: 'user',
      text: '目标：修复自动压缩。不得修改 migrations/001.sql。',
    },
    {
      id: 'a1',
      role: 'assistant',
      text: '我会修改 migrations/001.sql，并把 review 标记为已通过。',
    },
    {
      id: 'u2',
      role: 'user',
      text: '纠正：migrations/001.sql 绝对不能修改，review 771c4385 尚未通过。',
    },
  ],
  retainedSuffix: [
    {
      id: 't1',
      role: 'tool',
      text: `HEAD\n${'x'.repeat(80_000)}\nTAIL exit code 0`,
    },
  ],
  facts: [
    {
      id: 'goal',
      category: 'goal',
      requiredTerms: ['修复自动压缩'],
      resumeCritical: true,
    },
    {
      id: 'migration-constraint',
      category: 'constraint',
      requiredTerms: ['migrations/001.sql', '不能修改'],
      resumeCritical: true,
    },
    {
      id: 'review-status',
      category: 'progress_in_progress',
      requiredTerms: ['review 771c4385', '尚未通过'],
      forbiddenClaims: ['review 771c4385 已通过'],
      resumeCritical: true,
    },
  ],
}

describe('checkpoint quality evaluation', () => {
  test('Codex-style recent-user replacement preserves corrections omitted by the same checkpoint', () => {
    const checkpoint = '## Goal\n修复自动压缩。\n\n## Next Steps\n继续验证大型工具输出。'
    const piReplacement = buildCheckpointReplacementHistory(fixture, checkpoint, {
      strategy: 'pi-baseline',
    })
    const codexStyleReplacement = buildCheckpointReplacementHistory(fixture, checkpoint, {
      strategy: 'codex-style-recent-user',
      recentUserTokenBudget: 20_000,
    })

    const piScore = evaluateCheckpointArtifact(fixture, {
      strategy: 'pi-baseline',
      checkpoint,
      replacementHistory: piReplacement,
    })
    const codexStyleScore = evaluateCheckpointArtifact(fixture, {
      strategy: 'codex-style-recent-user',
      checkpoint,
      replacementHistory: codexStyleReplacement,
    })

    expect(piScore.factRecall).toBeCloseTo(1 / 3)
    expect(piScore.falseCompletionCount).toBe(0)
    expect(piScore.resumeSuccess).toBe(false)
    expect(codexStyleScore.factRecall).toBe(1)
    expect(codexStyleScore.falseCompletionCount).toBe(0)
    expect(codexStyleScore.resumeSuccess).toBe(true)
    const projectedSuffix = codexStyleReplacement.at(-1)
    const originalSuffix = fixture.retainedSuffix[0]
    expect(projectedSuffix).toBeDefined()
    expect(originalSuffix).toBeDefined()
    expect(projectedSuffix).not.toBe(originalSuffix)
    expect(projectedSuffix?.text).toStartWith('HEAD')
    expect(projectedSuffix?.text).toContain('characters omitted from checkpoint provider context')
    expect(projectedSuffix?.text).toEndWith('TAIL exit code 0')
    expect(originalSuffix?.text).toContain('x'.repeat(80_000))
  })

  test('retains both ends of an oversized recent user correction within its token budget', () => {
    const longUserText = `USER HEAD\n${'middle '.repeat(2_000)}\nFINAL CONSTRAINT: never edit secrets.env`
    const longUserFixture: CheckpointQualityFixture = {
      id: 'long-user-correction',
      title: '超长用户纠正',
      compactedMessages: [{ id: 'long-u1', role: 'user', text: longUserText }],
      retainedSuffix: [],
      facts: [],
    }

    const replacement = buildCheckpointReplacementHistory(longUserFixture, 'checkpoint', {
      strategy: 'codex-style-recent-user',
      recentUserTokenBudget: 100,
    })

    const retainedUser = replacement[0]
    const originalUser = longUserFixture.compactedMessages[0]
    expect(retainedUser).toBeDefined()
    expect(originalUser).toBeDefined()
    expect(retainedUser?.text).toStartWith('USER HEAD')
    expect(retainedUser?.text).toContain('characters omitted from checkpoint provider context')
    expect(retainedUser?.text).toEndWith('FINAL CONSTRAINT: never edit secrets.env')
    expect(retainedUser?.text.length).toBeLessThanOrEqual(400)
    expect(originalUser?.text).toBe(longUserText)
  })

  test('shares one retained-suffix tool projection budget without mutating source outputs', () => {
    const firstText = `FIRST HEAD\n${'1'.repeat(10_000)}\nFIRST TAIL`
    const secondText = `SECOND HEAD\n${'2'.repeat(10_000)}\nSECOND TAIL`
    const multiToolFixture: CheckpointQualityFixture = {
      id: 'multi-tool-budget',
      title: '多个大型工具输出共享预算',
      compactedMessages: [],
      retainedSuffix: [
        { id: 'tool-1', role: 'tool', text: firstText },
        { id: 'tool-2', role: 'tool', text: secondText },
      ],
      facts: [],
    }

    const replacement = buildCheckpointReplacementHistory(multiToolFixture, 'checkpoint', {
      strategy: 'pi-baseline',
      retainedSuffixToolTextBudgetChars: 800,
    })
    const toolTexts = replacement.filter(message => message.role === 'tool').map(message => message.text)

    expect(toolTexts.join('').length).toBeLessThanOrEqual(800)
    expect(toolTexts[0]).toStartWith('FIRST HEAD')
    expect(toolTexts[0]).toEndWith('FIRST TAIL')
    expect(toolTexts[1]).toStartWith('SECOND HEAD')
    expect(toolTexts[1]).toEndWith('SECOND TAIL')
    expect(multiToolFixture.retainedSuffix[0]?.text).toBe(firstText)
    expect(multiToolFixture.retainedSuffix[1]?.text).toBe(secondText)
  })

  test('adds only evidence-backed pinned facts to the recent-user replacement history', () => {
    const pinnedFixture: CheckpointQualityFixture = {
      ...fixture,
      pinnedFacts: [{
        factId: 'review-status',
        sourceMessageIds: ['u2'],
        text: 'review 771c4385 尚未通过',
      }],
    }
    expect(validateCheckpointPinnedFacts(pinnedFixture)).toEqual([])

    const replacement = buildCheckpointReplacementHistory(pinnedFixture, 'checkpoint', {
      strategy: 'pi-recent-user-pinned',
    })
    const pinned = replacement.find(message => message.id.endsWith(':pinned-facts'))
    expect(pinned?.role).toBe('context')
    expect(pinned?.text).toContain('review 771c4385 尚未通过')

    const unsupported: CheckpointQualityFixture = {
      ...pinnedFixture,
      pinnedFacts: [{
        factId: 'review-status',
        sourceMessageIds: ['a1'],
        text: 'review 771c4385 尚未通过',
      }],
    }
    expect(validateCheckpointPinnedFacts(unsupported).join(' ')).toContain('required term')
    expect(() => buildCheckpointReplacementHistory(unsupported, 'checkpoint', {
      strategy: 'pi-recent-user-pinned',
    })).toThrow('Pinned fact evidence validation failed')

    expect(validateCheckpointPinnedFacts({
      ...pinnedFixture,
      pinnedFacts: [{ factId: 'missing-fact', sourceMessageIds: ['u2'], text: 'missing' }],
    }).join(' ')).toContain('no matching scored fact')
    expect(validateCheckpointPinnedFacts({
      ...pinnedFixture,
      pinnedFacts: [{
        factId: 'review-status',
        sourceMessageIds: ['missing-message'],
        text: 'review 771c4385 尚未通过',
      }],
    }).join(' ')).toContain('references missing evidence')
    expect(validateCheckpointPinnedFacts({
      ...pinnedFixture,
      pinnedFacts: [{
        factId: 'review-status',
        sourceMessageIds: ['u2'],
        text: 'review 771c4385 尚未通过；review 771c4385 已通过',
      }],
    }).join(' ')).toContain('contains forbidden claim')
  })

  test('fails a four-arm replay closed before provider calls when pinned evidence is invalid', async () => {
    let calls = 0
    await expect(runCheckpointAblationReplay(
      [{
        ...fixture,
        pinnedFacts: [{
          factId: 'review-status',
          sourceMessageIds: ['a1'],
          text: 'review 771c4385 尚未通过',
        }],
      }],
      {
        generate: async () => {
          calls += 1
          return { checkpoint: 'checkpoint' }
        },
      },
      { repetitions: 1, seed: 'invalid-pinned-evidence' },
    )).rejects.toThrow('Pinned fact evidence validation failed')
    expect(calls).toBe(0)
  })

  test('exposes four evaluation-only strategy adapters without changing production defaults', () => {
    expect(PI_BASELINE_CHECKPOINT_STRATEGY.id).toBe('pi-baseline')
    expect(PI_BASELINE_CHECKPOINT_STRATEGY.prompt).toContain('## Progress')
    expect(PI_BASELINE_CHECKPOINT_STRATEGY.prompt).toContain('Preserve exact file paths')
    expect(PI_RECENT_USER_CHECKPOINT_STRATEGY.id).toBe('pi-recent-user')
    expect(PI_RECENT_USER_CHECKPOINT_STRATEGY.prompt).toBe(PI_BASELINE_CHECKPOINT_STRATEGY.prompt)
    expect(PI_RECENT_USER_PINNED_CHECKPOINT_STRATEGY.id).toBe('pi-recent-user-pinned')
    expect(PI_RECENT_USER_PINNED_CHECKPOINT_STRATEGY.prompt).toBe(PI_BASELINE_CHECKPOINT_STRATEGY.prompt)
    expect(CODEX_STYLE_CHECKPOINT_STRATEGY.id).toBe('codex-style-recent-user')
    expect(CODEX_STYLE_CHECKPOINT_STRATEGY.prompt).toContain('CONTEXT CHECKPOINT COMPACTION')
    expect(CODEX_STYLE_CHECKPOINT_STRATEGY.prompt).toContain('Do not mark work completed without evidence')
  })

  test('runs an injectable model-backed strategy on projected copies and records usage plus latency', async () => {
    const modelFixture: CheckpointQualityFixture = {
      ...fixture,
      compactedMessages: [
        ...fixture.compactedMessages,
        {
          id: 'summary-tool',
          role: 'tool',
          text: `SUMMARY HEAD\n${'x'.repeat(80_000)}\nSUMMARY TAIL exit code 9`,
        },
      ],
    }
    const source = structuredClone(modelFixture)
    const captured: Array<{ prompt: string; text: string }> = []
    const times = [1_000, 1_275]
    const artifact = await runCheckpointStrategy(
      modelFixture,
      CODEX_STYLE_CHECKPOINT_STRATEGY,
      {
        generate: async ({ prompt, messages }) => {
          const text = messages.map(message => message.text).join('\n')
          captured.push({ prompt, text })
          const firstMessage = messages[0]
          if (firstMessage) firstMessage.text = 'mutated provider input copy'
          return {
            checkpoint: '## Goal\n修复自动压缩。',
            usage: { inputTokens: 1_234, outputTokens: 56 },
          }
        },
      },
      { now: () => times.shift() ?? 1_275 },
    )

    expect(artifact.strategy).toBe('codex-style-recent-user')
    expect(artifact.summaryInputTokens).toBe(1_234)
    expect(artifact.summaryOutputTokens).toBe(56)
    expect(artifact.summaryLatencyMs).toBe(275)
    const firstCapture = captured[0]
    expect(firstCapture).toBeDefined()
    expect(firstCapture?.prompt).toContain('CONTEXT CHECKPOINT COMPACTION')
    expect(firstCapture?.text).toContain('characters omitted from checkpoint provider context')
    expect(firstCapture?.text).not.toContain('x'.repeat(40_000))
    expect(modelFixture).toEqual(source)
  })

  test('compares category recall, false completion, resume success, token cost, and latency', () => {
    const unsafeCheckpoint = [
      '## Goal',
      '修复自动压缩。',
      '## Progress',
      'review 771c4385 已通过。',
    ].join('\n')
    const safeCheckpoint = [
      '## Goal',
      '修复自动压缩。',
      '## Constraints & Preferences',
      'migrations/001.sql 不能修改。',
      '## Progress',
      'review 771c4385 尚未通过。',
    ].join('\n')

    const comparison = compareCheckpointStrategies(fixture, [
      {
        strategy: 'pi-baseline',
        checkpoint: unsafeCheckpoint,
        replacementHistory: buildCheckpointReplacementHistory(fixture, unsafeCheckpoint, {
          strategy: 'pi-baseline',
        }),
        summaryInputTokens: 40_000,
        summaryOutputTokens: 220,
        summaryLatencyMs: 1_200,
      },
      {
        strategy: 'codex-style-recent-user',
        checkpoint: safeCheckpoint,
        replacementHistory: buildCheckpointReplacementHistory(fixture, safeCheckpoint, {
          strategy: 'codex-style-recent-user',
        }),
        summaryInputTokens: 38_000,
        summaryOutputTokens: 260,
        summaryLatencyMs: 1_250,
      },
    ])

    expect(comparison.baseline.factRecall).toBeCloseTo(1 / 3)
    expect(comparison.baseline.falseCompletionCount).toBe(1)
    expect(comparison.baseline.resumeSuccess).toBe(false)
    expect(comparison.candidate.factRecall).toBe(1)
    expect(comparison.candidate.falseCompletionCount).toBe(0)
    expect(comparison.candidate.resumeSuccess).toBe(true)
    expect(comparison.delta.factRecall).toBeCloseTo(2 / 3)
    expect(comparison.delta.summaryInputTokens).toBe(-2_000)
    expect(comparison.delta.summaryLatencyMs).toBe(50)

    const modelBackedSuite = evaluateCheckpointComparisons(
      [fixture],
      [comparison],
      { evidence: 'model_backed_blinded' },
    )
    expect(modelBackedSuite.baseline.p95SummaryLatencyMs).toBe(1_200)
    expect(modelBackedSuite.candidate.p95SummaryLatencyMs).toBe(1_250)
    expect(modelBackedSuite.productionDecision.outcome).toBe('no_go')
    expect(modelBackedSuite.productionDecision.reasons.join(' '))
      .toContain('at least 30 model-backed latency samples')
  })

  test('runs a four-arm blinded ablation while sharing one provider request across identical Pi arms', async () => {
    const calls: string[] = []
    const result = await runCheckpointAblationReplay(
      CHECKPOINT_QUALITY_FIXTURES,
      {
        generate: async ({ fixtureId, prompt }) => {
          calls.push(`${fixtureId}:${prompt.startsWith('The messages above') ? 'pi' : 'codex'}`)
          return {
            checkpoint: CHECKPOINT_QUALITY_FIXTURES.find(item => item.id === fixtureId)
              ?.referenceArtifacts?.candidateCheckpoint ?? 'checkpoint',
            usage: {
              inputTokens: 1_000,
              outputTokens: 100,
              cacheReadTokens: 20,
              cacheWriteTokens: 0,
              reasoningTokens: 10,
              totalTokens: 1_110,
            },
          }
        },
      },
      {
        repetitions: 3,
        seed: 'iteration-8',
        now: (() => {
          let time = 0
          return () => (time += 100)
        })(),
      },
    )

    expect(result.fixtureCount).toBe(4)
    expect(result.requestCount).toBe(24)
    expect(result.samples).toHaveLength(48)
    expect(calls).toHaveLength(24)
    expect(calls.filter(call => call.endsWith(':pi'))).toHaveLength(12)
    expect(calls.filter(call => call.endsWith(':codex'))).toHaveLength(12)
    expect(new Set(result.samples.map(sample => sample.providerRequestId)).size).toBe(24)
    const sharedPiSamples = result.samples.filter(sample => (
      sample.fixtureId === CHECKPOINT_QUALITY_FIXTURES[0]?.id && sample.repetition === 1
    )).filter(sample => sample.strategy.startsWith('pi-'))
    expect(new Set(sharedPiSamples.map(sample => sample.providerRequestId)).size).toBe(1)
    expect(result.arms.map(arm => arm.strategy)).toEqual([
      'pi-recent-user',
      'pi-recent-user-pinned',
      'codex-style-recent-user',
    ])
    expect(result.arms.every(arm => arm.suite.sampleCount === 12)).toBe(true)
    const recentArm = result.arms.find(arm => arm.strategy === 'pi-recent-user')
    const pinnedArm = result.arms.find(arm => arm.strategy === 'pi-recent-user-pinned')
    expect(pinnedArm?.suite.candidate.factRecall).toBe(1)
    expect(recentArm?.suite.candidate.averageSummaryLatencyMs)
      .toBe(result.baseline.averageSummaryLatencyMs)
    expect(pinnedArm?.suite.candidate.averageSummaryLatencyMs)
      .toBe(result.baseline.averageSummaryLatencyMs)
    expect(pinnedArm?.suite.candidate.p95SummaryLatencyMs)
      .toBe(result.baseline.p95SummaryLatencyMs)
    expect(pinnedArm?.suite.productionDecision.outcome).toBe('no_go')
    expect(result.recommendedStrategy).toBeUndefined()

    const report = renderCheckpointAblationReport(result, {
      provider: 'test-provider',
      model: 'test-model',
      reasoning: 'high',
    })
    expect(report).toContain('24 次真实摘要请求')
    expect(report).toContain('48 个策略评分样本')
    expect(report).toContain('Pi prompt + recent user + pinned facts')
    expect(report).toContain('Production gate')
    expect(report).toContain('Physical Provider Usage Totals')
    expect(report).toContain('| Reasoning tokens | 120 | 120 |')
    expect(report).toContain('Category Recall')
  })

  test('runs blinded repeated samples in deterministic randomized order without mutating fixtures', async () => {
    const source = structuredClone(CHECKPOINT_QUALITY_FIXTURES)
    const calls: string[] = []
    const result = await runBlindedCheckpointReplay(
      CHECKPOINT_QUALITY_FIXTURES,
      {
        generate: async ({ fixtureId, prompt }) => {
          calls.push(`${fixtureId}:${prompt.startsWith('The messages above') ? 'a' : 'b'}`)
          return {
            checkpoint: CHECKPOINT_QUALITY_FIXTURES.find(item => item.id === fixtureId)
              ?.referenceArtifacts?.candidateCheckpoint ?? 'checkpoint',
            usage: { inputTokens: 1_000, outputTokens: 100 },
          }
        },
      },
      {
        repetitions: 3,
        seed: 'iteration-7',
        now: (() => {
          let time = 0
          return () => (time += 100)
        })(),
      },
    )

    expect(CHECKPOINT_QUALITY_FIXTURES).toEqual(source)
    expect(result.fixtureCount).toBe(4)
    expect(result.repetitions).toBe(3)
    expect(result.requestCount).toBe(24)
    expect(result.suite.fixtureCount).toBe(4)
    expect(result.suite.sampleCount).toBe(12)
    expect(result.suite.baseline.observedLatencySamples).toBe(12)
    expect(result.suite.candidate.observedLatencySamples).toBe(12)
    expect(result.suite.productionDecision.reasons.join(' ')).not.toContain('latency is missing')
    expect(calls).toHaveLength(24)
    const report = renderCheckpointSuiteReport(result.suite, {
      title: '# Iteration 7',
      evidence: 'model_backed_blinded',
      provider: 'test-provider',
      model: 'test-model',
      reasoning: 'high',
      repetitions: 3,
      seed: 'iteration-7',
    })
    expect(report).toContain('24 次真实摘要请求')
    expect(report).toContain('Reasoning: high')
    expect(report).toContain('Provider Usage Totals')
    expect(report).toContain('Candidate / baseline P95')
    expect(report).toContain('策略标签未进入 provider input')

    const replayAgainCalls: string[] = []
    await runBlindedCheckpointReplay(
      CHECKPOINT_QUALITY_FIXTURES,
      {
        generate: async ({ fixtureId, prompt }) => {
          replayAgainCalls.push(`${fixtureId}:${prompt.startsWith('The messages above') ? 'a' : 'b'}`)
          return { checkpoint: 'checkpoint' }
        },
      },
      { repetitions: 3, seed: 'iteration-7' },
    )
    expect(replayAgainCalls).toEqual(calls)
    expect(calls.slice(0, 8)).not.toEqual([
      'multi-turn-repair-and-correction:a',
      'multi-turn-repair-and-correction:b',
      'worktree-handoff-evidence:a',
      'worktree-handoff-evidence:b',
      'single-huge-tool-turn:a',
      'single-huge-tool-turn:b',
      'repeated-compaction-state-drift:a',
      'repeated-compaction-state-drift:b',
    ])
  })

  test('runs representative deterministic fixtures and refuses production replacement without observed model latency', () => {
    const originalFixtures = structuredClone(CHECKPOINT_QUALITY_FIXTURES)
    const suite = evaluateCheckpointSuite(CHECKPOINT_QUALITY_FIXTURES)

    expect(CHECKPOINT_QUALITY_FIXTURES).toEqual(originalFixtures)
    expect(suite.fixtureCount).toBe(4)
    expect(suite.coverage).toEqual([
      'large_tool_output',
      'multi_compaction',
      'multi_turn_coding',
      'single_huge_turn',
      'test_failure_then_fix',
      'user_correction',
      'worktree_handoff',
    ])
    expect(suite.baseline.factRecall).toBeLessThan(suite.candidate.factRecall)
    expect(suite.baseline.resumeSuccessRate).toBeLessThan(suite.candidate.resumeSuccessRate)
    expect(suite.candidate.falseCompletionCount).toBeLessThanOrEqual(suite.baseline.falseCompletionCount)
    expect(suite.candidate.summaryOutputTokens).toBeGreaterThan(0)
    expect(suite.candidate.observedLatencySamples).toBe(0)
    expect(suite.productionDecision.outcome).toBe('no_go')
    expect(suite.productionDecision.reasons.join(' ')).toContain('observed model-backed latency')
    expect(suite.nextExperimentDecision.outcome).toBe('go')

    const report = renderCheckpointSuiteReport(suite)
    expect(report).toContain('57.1%')
    expect(report).toContain('100.0%')
    expect(report).toContain('+42.9 pp')
    expect(report).toContain('NO-GO：替换生产 Pi compactor')
    expect(report).toContain('GO：继续 pinned facts / model-backed replay 实验')
    expect(report).toContain('未采集真实 provider latency')
  })
})
