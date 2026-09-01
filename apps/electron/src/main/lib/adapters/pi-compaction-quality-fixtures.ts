import type { CheckpointQualityFixture } from './pi-compaction-quality-eval'

function largeToolOutput(head: string, tail: string, fill = 'x', chars = 80_000): string {
  return `${head}\n${fill.repeat(chars)}\n${tail}`
}

export const CHECKPOINT_QUALITY_FIXTURES: readonly CheckpointQualityFixture[] = [
  {
    id: 'multi-turn-repair-and-correction',
    title: '多轮修复、测试失败后成功与用户纠正',
    coverage: ['multi_turn_coding', 'test_failure_then_fix', 'user_correction', 'large_tool_output'],
    compactedMessages: [
      {
        id: 'repair-u1',
        role: 'user',
        text: '目标：修复自动压缩。约束：migrations/001.sql 不能修改。',
      },
      {
        id: 'repair-t1',
        role: 'tool',
        text: 'pi-auto-compaction-turn-stop.test.ts: 1 fail，内部 continuation 在压缩前泄漏。',
      },
      {
        id: 'repair-a1',
        role: 'assistant',
        text: '根因是提前排入 user steering；改为成功 compaction_end 后发送隐藏 custom continuation。',
      },
      {
        id: 'repair-t2',
        role: 'tool',
        text: 'pi-auto-compaction-turn-stop.test.ts: 14 pass / 0 fail。',
      },
      {
        id: 'repair-u2',
        role: 'user',
        text: '再次确认：migrations/001.sql 绝对不能修改，review 771c4385 尚未通过。',
      },
    ],
    retainedSuffix: [
      {
        id: 'repair-a2',
        role: 'assistant',
        text: '下一步检查最终 Git diff，确认只包含压缩生命周期修复。',
      },
      {
        id: 'repair-t3',
        role: 'tool',
        text: largeToolOutput('git diff HEAD', 'exit code 0\nD:/workspace/domi/patches/pi.patch'),
      },
    ],
    facts: [
      { id: 'repair-goal', category: 'goal', requiredTerms: ['修复自动压缩'], resumeCritical: true },
      { id: 'repair-constraint', category: 'constraint', requiredTerms: ['migrations/001.sql', '不能修改'], resumeCritical: true },
      { id: 'repair-review', category: 'progress_in_progress', requiredTerms: ['review 771c4385', '尚未通过'], forbiddenClaims: ['review 771c4385 已通过'], resumeCritical: true },
      { id: 'repair-validation', category: 'validation', requiredTerms: ['14 pass', '0 fail'], resumeCritical: true },
      { id: 'repair-failure', category: 'failed_attempt', requiredTerms: ['continuation', '压缩前泄漏'] },
      { id: 'repair-next', category: 'next_step', requiredTerms: ['检查最终 git diff'], resumeCritical: true },
    ],
    pinnedFacts: [
      { factId: 'repair-review', sourceMessageIds: ['repair-u2'], text: 'review 771c4385 尚未通过' },
      { factId: 'repair-validation', sourceMessageIds: ['repair-t2'], text: 'pi-auto-compaction-turn-stop.test.ts: 14 pass / 0 fail' },
      { factId: 'repair-next', sourceMessageIds: ['repair-a2'], text: '下一步检查最终 Git diff' },
    ],
    referenceArtifacts: {
      baselineCheckpoint: `## Goal\n修复自动压缩。\n\n## Progress\n### Done\n- pi-auto-compaction-turn-stop.test.ts: 14 pass / 0 fail。\n\n## Next Steps\n检查最终 Git diff。`,
      candidateCheckpoint: `## Goal\n修复自动压缩。\n\n## Constraints & Preferences\n- migrations/001.sql 不能修改。\n\n## Progress\n### Done\n- 解决内部 continuation 在压缩前泄漏的问题。\n- pi-auto-compaction-turn-stop.test.ts: 14 pass / 0 fail。\n### In Progress\n- review 771c4385 尚未通过。\n\n## Next Steps\n检查最终 Git diff。`,
      baselineSummaryInputTokens: 42_000,
      candidateSummaryInputTokens: 40_500,
    },
  },
  {
    id: 'worktree-handoff-evidence',
    title: 'Worktree 交付、精确 ID 与 reviewer 证据边界',
    coverage: ['worktree_handoff', 'multi_turn_coding', 'user_correction'],
    compactedMessages: [
      {
        id: 'handoff-u1',
        role: 'user',
        text: '当前 checkout 46571103，review 771c4385，必须通过 ReadyForReview 交付。',
      },
      {
        id: 'handoff-t1',
        role: 'tool',
        text: '相关 Bun 回归：124 pass / 0 fail；build:main 和 typecheck 通过。',
      },
      {
        id: 'handoff-a1',
        role: 'assistant',
        text: '独立 reviewer 达到 600 秒上限，没有返回结论。',
      },
      {
        id: 'handoff-u2',
        role: 'user',
        text: 'reviewer 超时不能计入通过证据；自动化回归可以作为验证证据。',
      },
    ],
    retainedSuffix: [
      {
        id: 'handoff-a2',
        role: 'assistant',
        text: '准备提交 ReadyForReview，当前不执行 Iteration C。',
      },
    ],
    facts: [
      { id: 'handoff-checkout', category: 'identifier', requiredTerms: ['checkout 46571103'], resumeCritical: true },
      { id: 'handoff-review', category: 'identifier', requiredTerms: ['review 771c4385'], resumeCritical: true },
      { id: 'handoff-validation', category: 'validation', requiredTerms: ['124 pass', '0 fail', 'typecheck 通过'], resumeCritical: true },
      { id: 'handoff-reviewer', category: 'constraint', requiredTerms: ['reviewer 超时', '不能计入通过证据'], resumeCritical: true },
      { id: 'handoff-next', category: 'next_step', requiredTerms: ['readyforreview'], resumeCritical: true },
      { id: 'handoff-scope', category: 'progress_blocked', requiredTerms: ['不执行 iteration c'] },
    ],
    pinnedFacts: [
      { factId: 'handoff-checkout', sourceMessageIds: ['handoff-u1'], text: 'checkout 46571103' },
      { factId: 'handoff-review', sourceMessageIds: ['handoff-u1'], text: 'review 771c4385' },
      { factId: 'handoff-validation', sourceMessageIds: ['handoff-t1'], text: '相关 Bun 回归：124 pass / 0 fail；build:main 和 typecheck 通过' },
      { factId: 'handoff-reviewer', sourceMessageIds: ['handoff-u2'], text: 'reviewer 超时不能计入通过证据' },
      { factId: 'handoff-next', sourceMessageIds: ['handoff-a2'], text: '下一步提交 ReadyForReview' },
    ],
    referenceArtifacts: {
      baselineCheckpoint: `## Progress\n### Done\n- 相关 Bun 回归 124 pass / 0 fail；build:main 和 typecheck 通过。\n\n## Next Steps\n提交 ReadyForReview。\n\n## Critical Context\n当前不执行 Iteration C。`,
      candidateCheckpoint: `## Progress\n### Done\n- 相关 Bun 回归 124 pass / 0 fail；build:main 和 typecheck 通过。\n### Blocked\n- reviewer 超时，不能计入通过证据。\n\n## Next Steps\n为 checkout 46571103、review 771c4385 提交 ReadyForReview。\n\n## Critical Context\n当前不执行 Iteration C。`,
      baselineSummaryInputTokens: 36_000,
      candidateSummaryInputTokens: 35_500,
    },
  },
  {
    id: 'single-huge-tool-turn',
    title: '单个超大工具 turn 的 head/tail 诊断保留',
    coverage: ['single_huge_turn', 'large_tool_output'],
    compactedMessages: [
      {
        id: 'huge-u1',
        role: 'user',
        text: '定位大型构建输出中的 TypeError，并保留退出码和文件路径。',
      },
    ],
    retainedSuffix: [
      {
        id: 'huge-t1',
        role: 'tool',
        text: largeToolOutput(
          'TypeError: prepareRequestWithContext is not a function',
          'exit code 17\nD:/workspace/domi/apps/electron/src/main/index.ts',
          'z',
          160_000,
        ),
      },
      {
        id: 'huge-a1',
        role: 'assistant',
        text: '下一步检查 apps/electron/src/main/index.ts 的 prepareRequestWithContext 调用。',
      },
    ],
    facts: [
      { id: 'huge-goal', category: 'goal', requiredTerms: ['定位大型构建输出', 'typeerror'], resumeCritical: true },
      { id: 'huge-error', category: 'failed_attempt', requiredTerms: ['prepareRequestWithContext is not a function'], resumeCritical: true },
      { id: 'huge-exit', category: 'validation', requiredTerms: ['exit code 17'], resumeCritical: true },
      { id: 'huge-path', category: 'identifier', requiredTerms: ['apps/electron/src/main/index.ts'], resumeCritical: true },
      { id: 'huge-next', category: 'next_step', requiredTerms: ['检查 apps/electron/src/main/index.ts'], resumeCritical: true },
    ],
    pinnedFacts: [
      { factId: 'huge-error', sourceMessageIds: ['huge-t1'], text: 'TypeError: prepareRequestWithContext is not a function' },
      { factId: 'huge-exit', sourceMessageIds: ['huge-t1'], text: 'exit code 17' },
      { factId: 'huge-path', sourceMessageIds: ['huge-t1'], text: 'apps/electron/src/main/index.ts' },
    ],
    referenceArtifacts: {
      baselineCheckpoint: `## Goal\n定位大型构建输出中的 TypeError。\n\n## Next Steps\n检查 apps/electron/src/main/index.ts。`,
      candidateCheckpoint: `## Goal\n定位大型构建输出中的 TypeError。\n\n## Next Steps\n检查 apps/electron/src/main/index.ts。`,
      baselineSummaryInputTokens: 18_000,
      candidateSummaryInputTokens: 18_000,
    },
  },
  {
    id: 'repeated-compaction-state-drift',
    title: '多次压缩后的完成状态漂移',
    coverage: ['multi_compaction', 'test_failure_then_fix', 'user_correction'],
    compactedMessages: [
      {
        id: 'repeat-c1',
        role: 'checkpoint',
        text: '上一次摘要：build:main 已通过，typecheck 尚未运行。',
      },
      {
        id: 'repeat-u1',
        role: 'user',
        text: 'build:main 已通过，但 typecheck 仍未运行，不要把它写成已完成。',
      },
      {
        id: 'repeat-a1',
        role: 'assistant',
        text: '收到，我会先运行 typecheck。',
      },
      {
        id: 'repeat-u2',
        role: 'user',
        text: '再次纠正：当前 typecheck 未运行；下一步必须运行 typecheck。',
      },
    ],
    retainedSuffix: [
      {
        id: 'repeat-a2',
        role: 'assistant',
        text: '等待执行 typecheck。',
      },
    ],
    facts: [
      { id: 'repeat-build', category: 'progress_done', requiredTerms: ['build:main', '已通过'], resumeCritical: true },
      { id: 'repeat-typecheck', category: 'progress_in_progress', requiredTerms: ['typecheck', '未运行'], forbiddenClaims: ['typecheck 已通过'], resumeCritical: true },
      { id: 'repeat-constraint', category: 'constraint', requiredTerms: ['不要把它写成已完成'] },
      { id: 'repeat-next', category: 'next_step', requiredTerms: ['下一步必须运行 typecheck'], resumeCritical: true },
    ],
    pinnedFacts: [
      { factId: 'repeat-build', sourceMessageIds: ['repeat-u1'], text: 'build:main 已通过' },
      { factId: 'repeat-typecheck', sourceMessageIds: ['repeat-u2'], text: 'typecheck 未运行' },
      { factId: 'repeat-constraint', sourceMessageIds: ['repeat-u1'], text: '不要把它写成已完成' },
      { factId: 'repeat-next', sourceMessageIds: ['repeat-u2'], text: '下一步必须运行 typecheck' },
    ],
    referenceArtifacts: {
      baselineCheckpoint: `## Progress\n### Done\n- build:main 已通过。\n- typecheck 已通过。\n\n## Next Steps\n准备交付。`,
      candidateCheckpoint: `## Progress\n### Done\n- build:main 已通过。\n### In Progress\n- typecheck 未运行。\n\n## Constraints & Preferences\n- 不要把它写成已完成。\n\n## Next Steps\n下一步必须运行 typecheck。`,
      baselineSummaryInputTokens: 28_000,
      candidateSummaryInputTokens: 28_500,
    },
  },
] as const
