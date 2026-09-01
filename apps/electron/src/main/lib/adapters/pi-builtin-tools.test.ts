import { describe, expect, test } from 'bun:test'
import { PI_APPLY_WORKTREE_CONFLICT_GUIDANCE } from './pi-apply-worktree-guidance.ts'
import { PI_FINISH_WORKTREE_GUIDANCE } from './pi-finish-worktree-guidance.ts'
import { buildPiBuiltinToolAnnotations } from './pi-builtin-tool-annotations.ts'
import { buildPiGitPushSessionTrustTools, shouldExposeGitPushSessionTrust } from './pi-git-push-session-trust-tool.ts'
import { shouldExposeTerminalTools } from './pi-terminal-tools-policy.ts'

describe('Pi builtin tool capability metadata', () => {
  test('visible terminal tools are limited to direct interactive user sessions', () => {
    expect(shouldExposeTerminalTools({ triggeredBy: 'user' })).toBe(true)
    expect(shouldExposeTerminalTools({ triggeredBy: 'automation' })).toBe(false)
    expect(shouldExposeTerminalTools({ triggeredBy: 'delegation' })).toBe(false)
    expect(shouldExposeTerminalTools({ triggeredBy: 'user', sourceAutomationId: 'automation-1' })).toBe(false)
    expect(shouldExposeTerminalTools({ triggeredBy: 'user', sourceDelegationId: 'delegation-1' })).toBe(false)
  })

  test('ApplyWorktree 冲突指令要求重新生成 ReadyForReview 卡，而不是重试 Apply 或直接提交', () => {
    const guidance = PI_APPLY_WORKTREE_CONFLICT_GUIDANCE
    for (const text of [guidance.description, guidance.promptSnippet, guidance.resultMessage]) {
      expect(text).toContain('ReadyForReview')
      expect(text).toContain('ApplyWorktree')
      expect(text).toContain('FinishWorktree')
    }
    expect(guidance.description).toContain('effective review baseline')
    expect(guidance.description).toContain('only the remaining delivery delta')
    expect(guidance.promptSnippet).toContain('do not retry ApplyWorktree')
    expect(guidance.resultMessage).toContain('有效验收基线')
    expect(guidance.resultMessage).toContain('净增量')
    expect(guidance.resultMessage).toContain('不要再次调用 ApplyWorktree')
  })

  test('Given direct Finish after major checkpoints and a final micro-adjustment When metadata is built Then it requires one cumulative main-feature-led Commit Message', () => {
    for (const text of [PI_FINISH_WORKTREE_GUIDANCE.description, PI_FINISH_WORKTREE_GUIDANCE.promptSnippet]) {
      expect(text).toContain('effective review baseline')
      expect(text).toContain('final Worktree snapshot')
      expect(text).toContain('integrated Local review base')
      expect(text).toContain('already present in that')
      expect(text).toContain('unpublished checkpoints')
      expect(text).toContain('committed, staged, unstaged, and untracked')
      expect(text).toContain('main feature')
      expect(text).toContain('micro-adjustment')
      expect(text).toContain('Never concatenate')
      expect(text).toContain('latest user message')
      expect(text).toContain('duplicate bullets')
    }
    expect(PI_FINISH_WORKTREE_GUIDANCE.description).toContain('one final cumulative commit message')
  })

  test('Given product query and mutation tools When metadata is built Then only proven reads receive readOnlyHint', () => {
    expect(buildPiBuiltinToolAnnotations([
      'WebFetch',
      'BrowserSnapshot',
      'BrowserExtract',
      'BrowserClick',
      'BrowserType',
      'VisionRelay',
      'mcp__gpt_image__imagegen',
      'mcp__nano_banana__generate_image',
      'PlanFocusedValidation',
      'RequestNextWorktreeIteration',
      'RequestWorktreePreviewRevision',
      'ReadyForReview',
      'FinishWorktree',
      'ApplyWorktree',
      'RequestGitPushSessionTrust',
      'GitPushWithSessionTrust',
      'mcp__automation__get_automation',
      'mcp__automation__update_automation',
      'mcp__planning__list_todos',
      'mcp__planning__delete_todo',
      'mcp__collaboration__get_delegation_results',
      'mcp__collaboration__stop_delegation',
      'TaskCreate',
      'TaskUpdate',
    ])).toEqual({
      WebFetch: { readOnlyHint: true },
      BrowserSnapshot: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      BrowserExtract: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      BrowserClick: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      BrowserType: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      VisionRelay: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      mcp__gpt_image__imagegen: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      mcp__nano_banana__generate_image: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      PlanFocusedValidation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      RequestNextWorktreeIteration: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      RequestWorktreePreviewRevision: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      ReadyForReview: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      FinishWorktree: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      ApplyWorktree: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      RequestGitPushSessionTrust: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      GitPushWithSessionTrust: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      mcp__automation__get_automation: { readOnlyHint: true },
      mcp__planning__list_todos: { readOnlyHint: true },
      mcp__collaboration__get_delegation_results: { readOnlyHint: true },
      TaskCreate: { readOnlyHint: true },
      TaskUpdate: { readOnlyHint: true },
    })
  })

  test('does not expose legacy push grant tools after Full Access adopts direct trust semantics', () => {
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tools = buildPiGitPushSessionTrustTools(sdk, {
      sessionId: 'session-1',
      sessionTarget: { kind: 'isolated', ownership: 'owner' },
      triggeredBy: 'user',
    })

    expect(tools).toEqual([])
  })

  test('never exposes legacy push trust for any session provenance', () => {
    expect(shouldExposeGitPushSessionTrust({
      sessionTarget: { kind: 'isolated', ownership: 'owner' },
      triggeredBy: 'user',
    })).toBe(false)
    expect(shouldExposeGitPushSessionTrust({
      sessionTarget: { kind: 'isolated', ownership: 'inherited' },
      triggeredBy: 'user',
    })).toBe(false)
    expect(shouldExposeGitPushSessionTrust({
      sessionTarget: { kind: 'isolated', ownership: 'owner', followupOnly: true },
      triggeredBy: 'user',
    })).toBe(false)
    expect(shouldExposeGitPushSessionTrust({
      sessionTarget: { kind: 'isolated', ownership: 'owner' },
      triggeredBy: 'automation',
    })).toBe(false)
    expect(shouldExposeGitPushSessionTrust({
      sessionTarget: { kind: 'local', ownership: 'owner' },
      triggeredBy: 'user',
    })).toBe(false)
  })
})
