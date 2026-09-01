export type CheckpointFactCategory =
  | 'goal'
  | 'constraint'
  | 'progress_done'
  | 'progress_in_progress'
  | 'progress_blocked'
  | 'identifier'
  | 'validation'
  | 'failed_attempt'
  | 'next_step'

export type CheckpointQualityScenario =
  | 'multi_turn_coding'
  | 'test_failure_then_fix'
  | 'user_correction'
  | 'worktree_handoff'
  | 'large_tool_output'
  | 'single_huge_turn'
  | 'multi_compaction'

export type CheckpointEvalMessageRole = 'user' | 'assistant' | 'tool' | 'checkpoint' | 'context'

export interface CheckpointEvalMessage {
  id: string
  role: CheckpointEvalMessageRole
  text: string
}

export interface CheckpointFact {
  id: string
  category: CheckpointFactCategory
  requiredTerms: string[]
  forbiddenClaims?: string[]
  resumeCritical?: boolean
}

export interface CheckpointPinnedFact {
  factId: string
  sourceMessageIds: string[]
  text: string
}

export interface CheckpointQualityFixture {
  id: string
  title: string
  coverage?: CheckpointQualityScenario[]
  compactedMessages: CheckpointEvalMessage[]
  retainedSuffix: CheckpointEvalMessage[]
  facts: CheckpointFact[]
  pinnedFacts?: CheckpointPinnedFact[]
  referenceArtifacts?: {
    baselineCheckpoint: string
    candidateCheckpoint: string
    baselineSummaryInputTokens?: number
    candidateSummaryInputTokens?: number
  }
}

export type CheckpointEvalStrategyId =
  | 'pi-baseline'
  | 'pi-recent-user'
  | 'pi-recent-user-pinned'
  | 'codex-style-recent-user'

export interface CheckpointReplacementOptions {
  strategy: CheckpointEvalStrategyId
  recentUserTokenBudget?: number
  retainedSuffixToolTextBudgetChars?: number
}

export interface CheckpointProviderUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface CheckpointArtifact {
  strategy: CheckpointEvalStrategyId
  checkpoint: string
  replacementHistory: CheckpointEvalMessage[]
  summaryInputTokens?: number
  summaryOutputTokens?: number
  summaryLatencyMs?: number
  providerUsage?: CheckpointProviderUsage
}

export interface CheckpointFactScore {
  id: string
  category: CheckpointFactCategory
  recalled: boolean
  falseCompletionClaims: string[]
  resumeCritical: boolean
}

export interface CheckpointQualityScore {
  fixtureId: string
  strategy: CheckpointEvalStrategyId
  factRecall: number
  recalledFacts: number
  totalFacts: number
  categoryRecall: Partial<Record<CheckpointFactCategory, number>>
  falseCompletionCount: number
  resumeSuccess: boolean
  facts: CheckpointFactScore[]
  summaryInputTokens?: number
  summaryOutputTokens: number
  summaryLatencyMs?: number
  replacementHistoryTokens: number
  providerUsage?: CheckpointProviderUsage
}

export interface CheckpointStrategyComparison {
  fixtureId: string
  baseline: CheckpointQualityScore
  candidate: CheckpointQualityScore
  delta: {
    factRecall: number
    falseCompletionCount: number
    resumeSuccess: number
    summaryInputTokens?: number
    summaryOutputTokens: number
    summaryLatencyMs?: number
    replacementHistoryTokens: number
  }
}

export interface CheckpointEvalStrategy {
  id: CheckpointEvalStrategyId
  label: string
  prompt: string
  buildReplacementHistory: (
    fixture: CheckpointQualityFixture,
    checkpoint: string,
  ) => CheckpointEvalMessage[]
}

export interface CheckpointSummaryGeneratorInput {
  fixtureId: string
  strategy: CheckpointEvalStrategyId
  prompt: string
  messages: CheckpointEvalMessage[]
}

export interface CheckpointSummaryGeneratorResult {
  checkpoint: string
  usage?: CheckpointProviderUsage
}

export interface CheckpointSummaryGenerator {
  generate: (
    input: CheckpointSummaryGeneratorInput,
  ) => Promise<CheckpointSummaryGeneratorResult>
}

/** Provider-facing input intentionally omits strategy labels to keep replay generation blinded. */
export type BlindedCheckpointGeneratorInput = Omit<CheckpointSummaryGeneratorInput, 'strategy'>

export interface BlindedCheckpointSummaryGenerator {
  generate: (
    input: BlindedCheckpointGeneratorInput,
  ) => Promise<CheckpointSummaryGeneratorResult>
}

export interface RunCheckpointStrategyOptions {
  now?: () => number
  summaryToolTextBudgetChars?: number
}

export interface CheckpointSuiteAggregate {
  factRecall: number
  categoryRecall: Partial<Record<CheckpointFactCategory, number>>
  falseCompletionCount: number
  resumeSuccessRate: number
  summaryInputTokens?: number
  summaryOutputTokens: number
  replacementHistoryTokens: number
  observedLatencySamples: number
  averageSummaryLatencyMs?: number
  p95SummaryLatencyMs?: number
}

export type CheckpointEvidenceKind = 'deterministic_reference' | 'model_backed_blinded'

export interface EvaluateCheckpointComparisonsOptions {
  evidence: CheckpointEvidenceKind
  samplesPerFixture?: number
}

export interface CheckpointEvalDecision {
  outcome: 'go' | 'no_go'
  reasons: string[]
}

export interface CheckpointSuiteResult {
  fixtureCount: number
  sampleCount: number
  coverage: CheckpointQualityScenario[]
  baseline: CheckpointSuiteAggregate
  candidate: CheckpointSuiteAggregate
  delta: {
    factRecall: number
    falseCompletionCount: number
    resumeSuccessRate: number
    summaryInputTokens?: number
    summaryOutputTokens: number
    replacementHistoryTokens: number
    averageSummaryLatencyMs?: number
    p95SummaryLatencyMs?: number
  }
  productionDecision: CheckpointEvalDecision
  nextExperimentDecision: CheckpointEvalDecision
  comparisons: CheckpointStrategyComparison[]
}

export interface RunBlindedCheckpointReplayOptions extends RunCheckpointStrategyOptions {
  repetitions: number
  seed: string
  onRequestStart?: (progress: { ordinal: number; total: number }) => void
  onRequestComplete?: (progress: { ordinal: number; total: number }) => void
}

export type CheckpointPromptFamilyId = 'pi-structured' | 'codex-style'

export interface BlindedCheckpointReplaySample {
  sampleId: string
  providerRequestId: string
  promptFamily: CheckpointPromptFamilyId
  fixtureId: string
  repetition: number
  strategy: CheckpointEvalStrategyId
  summaryInputTokens?: number
  summaryOutputTokens?: number
  summaryLatencyMs?: number
  factRecall: number
  falseCompletionCount: number
  resumeSuccess: boolean
  providerUsage?: CheckpointProviderUsage
}

export interface BlindedCheckpointReplayResult {
  fixtureCount: number
  repetitions: number
  requestCount: number
  seed: string
  samples: BlindedCheckpointReplaySample[]
  suite: CheckpointSuiteResult
}

export interface CheckpointAblationArmResult {
  strategy: Exclude<CheckpointEvalStrategyId, 'pi-baseline'>
  label: string
  suite: CheckpointSuiteResult
}

export interface CheckpointAblationResult {
  fixtureCount: number
  repetitions: number
  requestCount: number
  seed: string
  baseline: CheckpointSuiteAggregate
  arms: CheckpointAblationArmResult[]
  samples: BlindedCheckpointReplaySample[]
  recommendedStrategy?: Exclude<CheckpointEvalStrategyId, 'pi-baseline'>
}

export interface RenderCheckpointAblationReportOptions {
  provider?: string
  model?: string
  reasoning?: string
}

export const PI_BASELINE_CHECKPOINT_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const CODEX_STYLE_CHECKPOINT_PROMPT = `Perform a CONTEXT CHECKPOINT COMPACTION for the next LLM that will resume this task.

Create a concise, structured handoff containing current progress, important decisions, constraints and user preferences, remaining actions, and critical references. Distinguish completed, in-progress, blocked, and merely planned work. Include user corrections. Do not mark work completed without evidence. Preserve exact paths, functions, identifiers, validation results, and failed attempts needed to avoid repeating work.`

const DEFAULT_RECENT_USER_TOKEN_BUDGET = 20_000
const DEFAULT_RETAINED_SUFFIX_TOOL_TEXT_BUDGET_CHARS = 16_000
const APPROXIMATE_CHARS_PER_TOKEN = 4

function normalizeForMatch(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll('\\', '/')
    .replace(/\s+/g, ' ')
    .trim()
}

export function estimateCheckpointTokens(text: string): number {
  return Math.ceil(text.length / APPROXIMATE_CHARS_PER_TOKEN)
}

function checkpointMessage(fixtureId: string, checkpoint: string): CheckpointEvalMessage {
  return {
    id: `${fixtureId}:checkpoint`,
    role: 'checkpoint',
    text: checkpoint,
  }
}

function projectTextHeadAndTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let marker = ''
  let omittedChars = text.length - maxChars
  for (let index = 0; index < 2; index += 1) {
    marker = `\n\n[... ${omittedChars} characters omitted from checkpoint provider context. Original message: ${text.length} characters ...]\n\n`
    omittedChars = Math.max(0, text.length - Math.max(0, maxChars - marker.length))
  }
  if (marker.length >= maxChars) {
    const headChars = Math.ceil(maxChars / 2)
    const tailChars = Math.max(0, maxChars - headChars)
    return text.slice(0, headChars) + (tailChars > 0 ? text.slice(-tailChars) : '')
  }
  const contentBudget = maxChars - marker.length
  const headChars = Math.ceil(contentBudget / 2)
  const tailChars = Math.max(0, contentBudget - headChars)
  return text.slice(0, headChars) + marker + (tailChars > 0 ? text.slice(-tailChars) : '')
}

function projectRetainedSuffix(
  messages: readonly CheckpointEvalMessage[],
  maxTotalToolTextChars: number,
): CheckpointEvalMessage[] {
  const toolMessages = messages.filter(message => message.role === 'tool')
  const totalToolTextChars = toolMessages.reduce((total, message) => total + message.text.length, 0)
  if (totalToolTextChars <= maxTotalToolTextChars) return [...messages]

  let remainingBudget = Math.max(0, maxTotalToolTextChars)
  let remainingTools = toolMessages.length
  return messages.map((message) => {
    if (message.role !== 'tool') return message
    const allocation = remainingTools <= 0
      ? 0
      : Math.min(message.text.length, Math.floor(remainingBudget / remainingTools))
    remainingBudget -= allocation
    remainingTools -= 1
    if (message.text.length <= allocation) return message
    return {
      ...message,
      id: `${message.id}:projected`,
      text: projectTextHeadAndTail(message.text, allocation),
    }
  })
}

function selectRecentUserMessages(
  messages: readonly CheckpointEvalMessage[],
  tokenBudget: number,
): CheckpointEvalMessage[] {
  if (tokenBudget <= 0) return []

  let remainingChars = tokenBudget * APPROXIMATE_CHARS_PER_TOKEN
  const selected: CheckpointEvalMessage[] = []
  for (let index = messages.length - 1; index >= 0 && remainingChars > 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (message.text.length <= remainingChars) {
      selected.push(message)
      remainingChars -= message.text.length
      continue
    }
    selected.push({
      ...message,
      id: `${message.id}:truncated`,
      text: projectTextHeadAndTail(message.text, remainingChars),
    })
    remainingChars = 0
  }
  selected.reverse()
  return selected
}

/**
 * Build provider-only replacement history for deterministic compaction quality evaluation.
 * It never mutates or rewrites fixture messages, transcripts, SessionManager entries, or runtime state.
 */
export function validateCheckpointPinnedFacts(fixture: CheckpointQualityFixture): string[] {
  const messages = [...fixture.compactedMessages, ...fixture.retainedSuffix]
  const messagesById = new Map(messages.map(message => [message.id, message]))
  const factsById = new Map(fixture.facts.map(fact => [fact.id, fact]))
  const errors: string[] = []
  for (const pinned of fixture.pinnedFacts ?? []) {
    const fact = factsById.get(pinned.factId)
    if (!fact) {
      errors.push(`Pinned fact ${pinned.factId} has no matching scored fact.`)
      continue
    }
    if (pinned.sourceMessageIds.length === 0) {
      errors.push(`Pinned fact ${pinned.factId} has no evidence messages.`)
      continue
    }
    const sourceMessages = pinned.sourceMessageIds.map((id) => {
      const message = messagesById.get(id)
      if (!message) errors.push(`Pinned fact ${pinned.factId} references missing evidence ${id}.`)
      return message
    }).filter((message): message is CheckpointEvalMessage => message !== undefined)
    const sourceText = normalizeForMatch(sourceMessages.map(message => message.text).join('\n'))
    const pinnedText = normalizeForMatch(pinned.text)
    for (const term of fact.requiredTerms) {
      const normalizedTerm = normalizeForMatch(term)
      if (!sourceText.includes(normalizedTerm)) {
        errors.push(`Pinned fact ${pinned.factId} required term ${term} is absent from its evidence.`)
      }
      if (!pinnedText.includes(normalizedTerm)) {
        errors.push(`Pinned fact ${pinned.factId} required term ${term} is absent from pinned text.`)
      }
    }
    for (const claim of fact.forbiddenClaims ?? []) {
      const normalizedClaim = normalizeForMatch(claim)
      if (sourceText.includes(normalizedClaim)) {
        errors.push(`Pinned fact ${pinned.factId} evidence contains forbidden claim ${claim}.`)
      }
      if (pinnedText.includes(normalizedClaim)) {
        errors.push(`Pinned fact ${pinned.factId} contains forbidden claim ${claim}.`)
      }
    }
  }
  return errors
}

function buildPinnedFactsMessage(fixture: CheckpointQualityFixture): CheckpointEvalMessage | undefined {
  if (!fixture.pinnedFacts?.length) return undefined
  const errors = validateCheckpointPinnedFacts(fixture)
  if (errors.length > 0) throw new Error(`Pinned fact evidence validation failed: ${errors.join(' ')}`)
  const factsById = new Map(fixture.facts.map(fact => [fact.id, fact]))
  return {
    id: `${fixture.id}:pinned-facts`,
    role: 'context',
    text: [
      '# Domi Host-Pinned Facts',
      'These facts are derived from host-observed state and evidence. Preserve their exact status.',
      ...fixture.pinnedFacts.map((pinned) => {
        const fact = factsById.get(pinned.factId)!
        return `- [${fact.category}] ${pinned.text}`
      }),
    ].join('\n'),
  }
}

export function buildCheckpointReplacementHistory(
  fixture: CheckpointQualityFixture,
  checkpoint: string,
  options: CheckpointReplacementOptions,
): CheckpointEvalMessage[] {
  const summary = checkpointMessage(fixture.id, checkpoint)
  const retainedSuffix = projectRetainedSuffix(
    fixture.retainedSuffix,
    options.retainedSuffixToolTextBudgetChars ?? DEFAULT_RETAINED_SUFFIX_TOOL_TEXT_BUDGET_CHARS,
  )
  if (options.strategy === 'pi-baseline') {
    return [summary, ...retainedSuffix]
  }

  const retainedUsers = selectRecentUserMessages(
    fixture.compactedMessages,
    options.recentUserTokenBudget ?? DEFAULT_RECENT_USER_TOKEN_BUDGET,
  )
  if (options.strategy === 'pi-recent-user-pinned') {
    const pinned = buildPinnedFactsMessage(fixture)
    return [...retainedUsers, ...(pinned ? [pinned] : []), summary, ...retainedSuffix]
  }
  return [...retainedUsers, summary, ...retainedSuffix]
}

export const PI_BASELINE_CHECKPOINT_STRATEGY = {
  id: 'pi-baseline',
  label: 'Current Pi structured checkpoint',
  prompt: PI_BASELINE_CHECKPOINT_PROMPT,
  buildReplacementHistory: (fixture, checkpoint) => buildCheckpointReplacementHistory(
    fixture,
    checkpoint,
    { strategy: 'pi-baseline' },
  ),
} satisfies CheckpointEvalStrategy

export const PI_RECENT_USER_CHECKPOINT_STRATEGY = {
  id: 'pi-recent-user',
  label: 'Current Pi prompt with recent user retention',
  prompt: PI_BASELINE_CHECKPOINT_PROMPT,
  buildReplacementHistory: (fixture, checkpoint) => buildCheckpointReplacementHistory(
    fixture,
    checkpoint,
    { strategy: 'pi-recent-user' },
  ),
} satisfies CheckpointEvalStrategy

export const PI_RECENT_USER_PINNED_CHECKPOINT_STRATEGY = {
  id: 'pi-recent-user-pinned',
  label: 'Current Pi prompt with recent user retention and host-pinned facts',
  prompt: PI_BASELINE_CHECKPOINT_PROMPT,
  buildReplacementHistory: (fixture, checkpoint) => buildCheckpointReplacementHistory(
    fixture,
    checkpoint,
    { strategy: 'pi-recent-user-pinned' },
  ),
} satisfies CheckpointEvalStrategy

export const CODEX_STYLE_CHECKPOINT_STRATEGY = {
  id: 'codex-style-recent-user',
  label: 'Evaluation-only Codex-style checkpoint with recent user retention',
  prompt: CODEX_STYLE_CHECKPOINT_PROMPT,
  buildReplacementHistory: (fixture, checkpoint) => buildCheckpointReplacementHistory(
    fixture,
    checkpoint,
    { strategy: 'codex-style-recent-user' },
  ),
} satisfies CheckpointEvalStrategy

export async function runCheckpointStrategy(
  fixture: CheckpointQualityFixture,
  strategy: CheckpointEvalStrategy,
  generator: CheckpointSummaryGenerator,
  options: RunCheckpointStrategyOptions = {},
): Promise<CheckpointArtifact> {
  const now = options.now ?? (() => performance.now())
  const summaryMessages = projectRetainedSuffix(
    fixture.compactedMessages,
    options.summaryToolTextBudgetChars ?? DEFAULT_RETAINED_SUFFIX_TOOL_TEXT_BUDGET_CHARS,
  ).map(message => ({ ...message }))
  const startedAt = now()
  const generated = await generator.generate({
    fixtureId: fixture.id,
    strategy: strategy.id,
    prompt: strategy.prompt,
    messages: summaryMessages,
  })
  const completedAt = now()
  return {
    strategy: strategy.id,
    checkpoint: generated.checkpoint,
    replacementHistory: strategy.buildReplacementHistory(fixture, generated.checkpoint),
    summaryInputTokens: generated.usage?.inputTokens
      ?? summaryMessages.reduce((total, message) => total + estimateCheckpointTokens(message.text), 0),
    summaryOutputTokens: generated.usage?.outputTokens
      ?? estimateCheckpointTokens(generated.checkpoint),
    summaryLatencyMs: Math.max(0, completedAt - startedAt),
    providerUsage: generated.usage ? { ...generated.usage } : undefined,
  }
}

export function evaluateCheckpointArtifact(
  fixture: CheckpointQualityFixture,
  artifact: CheckpointArtifact,
): CheckpointQualityScore {
  const providerText = normalizeForMatch(
    artifact.replacementHistory.map(message => message.text).join('\n\n'),
  )
  const checkpointText = normalizeForMatch(artifact.checkpoint)
  const facts = fixture.facts.map<CheckpointFactScore>((fact) => {
    const recalled = fact.requiredTerms.every(term => (
      providerText.includes(normalizeForMatch(term))
    ))
    const falseCompletionClaims = (fact.forbiddenClaims ?? []).filter(claim => (
      checkpointText.includes(normalizeForMatch(claim))
    ))
    return {
      id: fact.id,
      category: fact.category,
      recalled,
      falseCompletionClaims,
      resumeCritical: fact.resumeCritical === true,
    }
  })
  const recalledFacts = facts.filter(fact => fact.recalled).length
  const categoryRecall: Partial<Record<CheckpointFactCategory, number>> = {}
  const categories = new Set(facts.map(fact => fact.category))
  for (const category of categories) {
    const categoryFacts = facts.filter(fact => fact.category === category)
    categoryRecall[category] = categoryFacts.filter(fact => fact.recalled).length / categoryFacts.length
  }
  const falseCompletionCount = facts.reduce(
    (total, fact) => total + fact.falseCompletionClaims.length,
    0,
  )
  const criticalFacts = facts.filter(fact => fact.resumeCritical)
  const resumeSuccess = falseCompletionCount === 0
    && criticalFacts.every(fact => fact.recalled)

  return {
    fixtureId: fixture.id,
    strategy: artifact.strategy,
    factRecall: fixture.facts.length === 0 ? 1 : recalledFacts / fixture.facts.length,
    recalledFacts,
    totalFacts: fixture.facts.length,
    categoryRecall,
    falseCompletionCount,
    resumeSuccess,
    facts,
    summaryInputTokens: artifact.summaryInputTokens,
    summaryOutputTokens: artifact.summaryOutputTokens ?? estimateCheckpointTokens(artifact.checkpoint),
    summaryLatencyMs: artifact.summaryLatencyMs,
    replacementHistoryTokens: artifact.replacementHistory.reduce(
      (total, message) => total + estimateCheckpointTokens(message.text),
      0,
    ),
    providerUsage: artifact.providerUsage ? { ...artifact.providerUsage } : undefined,
  }
}

function optionalDelta(candidate: number | undefined, baseline: number | undefined): number | undefined {
  if (candidate === undefined || baseline === undefined) return undefined
  return candidate - baseline
}

export function compareCheckpointCandidate(
  fixture: CheckpointQualityFixture,
  baselineArtifact: CheckpointArtifact,
  candidateArtifact: CheckpointArtifact,
): CheckpointStrategyComparison {
  if (baselineArtifact.strategy !== 'pi-baseline') {
    throw new Error('Checkpoint candidate comparison requires a pi-baseline artifact.')
  }
  const baseline = evaluateCheckpointArtifact(fixture, baselineArtifact)
  const candidate = evaluateCheckpointArtifact(fixture, candidateArtifact)
  return {
    fixtureId: fixture.id,
    baseline,
    candidate,
    delta: {
      factRecall: candidate.factRecall - baseline.factRecall,
      falseCompletionCount: candidate.falseCompletionCount - baseline.falseCompletionCount,
      resumeSuccess: Number(candidate.resumeSuccess) - Number(baseline.resumeSuccess),
      summaryInputTokens: optionalDelta(candidate.summaryInputTokens, baseline.summaryInputTokens),
      summaryOutputTokens: candidate.summaryOutputTokens - baseline.summaryOutputTokens,
      summaryLatencyMs: optionalDelta(candidate.summaryLatencyMs, baseline.summaryLatencyMs),
      replacementHistoryTokens: candidate.replacementHistoryTokens - baseline.replacementHistoryTokens,
    },
  }
}

export function compareCheckpointStrategies(
  fixture: CheckpointQualityFixture,
  artifacts: readonly [CheckpointArtifact, CheckpointArtifact],
): CheckpointStrategyComparison {
  const baselineArtifact = artifacts.find(artifact => artifact.strategy === 'pi-baseline')
  const candidateArtifact = artifacts.find(artifact => artifact.strategy === 'codex-style-recent-user')
  if (!baselineArtifact || !candidateArtifact) {
    throw new Error('Checkpoint comparison requires one pi-baseline and one codex-style-recent-user artifact.')
  }
  return compareCheckpointCandidate(fixture, baselineArtifact, candidateArtifact)
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((total, value) => total + value, 0) / values.length
}

function percentile95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[index]
}

function aggregateScores(scores: readonly CheckpointQualityScore[]): CheckpointSuiteAggregate {
  const totalFacts = scores.reduce((total, score) => total + score.totalFacts, 0)
  const recalledFacts = scores.reduce((total, score) => total + score.recalledFacts, 0)
  const categoryTotals: Partial<Record<CheckpointFactCategory, { recalled: number; total: number }>> = {}
  for (const score of scores) {
    for (const fact of score.facts) {
      const current = categoryTotals[fact.category] ?? { recalled: 0, total: 0 }
      current.total += 1
      if (fact.recalled) current.recalled += 1
      categoryTotals[fact.category] = current
    }
  }
  const categoryRecall: Partial<Record<CheckpointFactCategory, number>> = {}
  for (const [category, values] of Object.entries(categoryTotals)) {
    categoryRecall[category as CheckpointFactCategory] = values.recalled / values.total
  }
  const observedLatencies = scores
    .map(score => score.summaryLatencyMs)
    .filter((value): value is number => value !== undefined)
  const inputTokenSamples = scores
    .map(score => score.summaryInputTokens)
    .filter((value): value is number => value !== undefined)

  return {
    factRecall: totalFacts === 0 ? 1 : recalledFacts / totalFacts,
    categoryRecall,
    falseCompletionCount: scores.reduce((total, score) => total + score.falseCompletionCount, 0),
    resumeSuccessRate: scores.length === 0
      ? 1
      : scores.filter(score => score.resumeSuccess).length / scores.length,
    summaryInputTokens: average(inputTokenSamples),
    summaryOutputTokens: average(scores.map(score => score.summaryOutputTokens)) ?? 0,
    replacementHistoryTokens: average(scores.map(score => score.replacementHistoryTokens)) ?? 0,
    observedLatencySamples: observedLatencies.length,
    averageSummaryLatencyMs: average(observedLatencies),
    p95SummaryLatencyMs: percentile95(observedLatencies),
  }
}

export function evaluateCheckpointComparisons(
  fixtures: readonly CheckpointQualityFixture[],
  comparisons: readonly CheckpointStrategyComparison[],
  options: EvaluateCheckpointComparisonsOptions,
): CheckpointSuiteResult {
  const samplesPerFixture = options.samplesPerFixture ?? 1
  if (!Number.isInteger(samplesPerFixture) || samplesPerFixture < 1) {
    throw new Error('Checkpoint samples per fixture must be a positive integer.')
  }
  if (comparisons.length !== fixtures.length * samplesPerFixture) {
    throw new Error('Checkpoint comparison count must match fixture count multiplied by samples per fixture.')
  }
  for (const fixture of fixtures) {
    const sampleCount = comparisons.filter(comparison => comparison.fixtureId === fixture.id).length
    if (sampleCount !== samplesPerFixture) {
      throw new Error(`Checkpoint fixture ${fixture.id} must have exactly ${samplesPerFixture} comparison samples.`)
    }
  }
  const baseline = aggregateScores(comparisons.map(comparison => comparison.baseline))
  const candidate = aggregateScores(comparisons.map(comparison => comparison.candidate))
  const coverage = [...new Set(fixtures.flatMap(fixture => fixture.coverage ?? []))].sort()
  const recallGain = candidate.factRecall - baseline.factRecall
  const resumeGain = candidate.resumeSuccessRate - baseline.resumeSuccessRate
  const hasObservedLatency = candidate.observedLatencySamples === comparisons.length
    && baseline.observedLatencySamples === comparisons.length
  const latencyRatio = candidate.p95SummaryLatencyMs !== undefined
    && baseline.p95SummaryLatencyMs !== undefined
    && baseline.p95SummaryLatencyMs > 0
    ? candidate.p95SummaryLatencyMs / baseline.p95SummaryLatencyMs
    : undefined
  const productionReasons: string[] = []
  if (recallGain < 0.15) productionReasons.push('fact recall gain is below the 15% production gate')
  if (candidate.falseCompletionCount > baseline.falseCompletionCount) {
    productionReasons.push('false completion count regressed')
  }
  if (resumeGain < 0.1) productionReasons.push('resume success gain is below the 10% production gate')
  if (!hasObservedLatency) productionReasons.push('observed model-backed latency is missing')
  if (options.evidence === 'model_backed_blinded' && comparisons.length < 30) {
    productionReasons.push('at least 30 model-backed latency samples are required for the production P95 gate')
  }
  if (latencyRatio !== undefined && latencyRatio > 1.1) {
    productionReasons.push('candidate P95 summary latency regressed by more than 10%')
  }
  if (options.evidence !== 'model_backed_blinded') {
    productionReasons.push('reference checkpoints are deterministic fixtures rather than blinded provider outputs')
  }

  const evidenceLabel = options.evidence === 'model_backed_blinded' ? 'model-backed' : 'deterministic'
  const experimentReasons = [
    recallGain > 0
      ? `${evidenceLabel} replacement-history recall improved by ${(recallGain * 100).toFixed(1)} percentage points`
      : `${evidenceLabel} replacement-history recall did not improve`,
    candidate.falseCompletionCount <= baseline.falseCompletionCount
      ? 'false completion did not regress'
      : 'false completion regressed',
    'model-backed replay and deterministic pinned facts remain necessary before production replacement',
  ]

  return {
    fixtureCount: fixtures.length,
    sampleCount: comparisons.length,
    coverage,
    baseline,
    candidate,
    delta: {
      factRecall: recallGain,
      falseCompletionCount: candidate.falseCompletionCount - baseline.falseCompletionCount,
      resumeSuccessRate: resumeGain,
      summaryInputTokens: optionalDelta(candidate.summaryInputTokens, baseline.summaryInputTokens),
      summaryOutputTokens: candidate.summaryOutputTokens - baseline.summaryOutputTokens,
      replacementHistoryTokens: candidate.replacementHistoryTokens - baseline.replacementHistoryTokens,
      averageSummaryLatencyMs: optionalDelta(
        candidate.averageSummaryLatencyMs,
        baseline.averageSummaryLatencyMs,
      ),
      p95SummaryLatencyMs: optionalDelta(
        candidate.p95SummaryLatencyMs,
        baseline.p95SummaryLatencyMs,
      ),
    },
    productionDecision: {
      outcome: productionReasons.length === 0 ? 'go' : 'no_go',
      reasons: productionReasons,
    },
    nextExperimentDecision: {
      outcome: recallGain > 0 && candidate.falseCompletionCount <= baseline.falseCompletionCount
        ? 'go'
        : 'no_go',
      reasons: experimentReasons,
    },
    comparisons: [...comparisons],
  }
}

function seededRandom(seed: string): () => number {
  let state = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(values: readonly T[], seed: string): T[] {
  const result = [...values]
  const random = seededRandom(seed)
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    const current = result[index]!
    result[index] = result[target]!
    result[target] = current
  }
  return result
}

/**
 * Run repeated, randomized model-backed replay while keeping strategy IDs out of provider inputs.
 * Strategy labels are restored only after generation for deterministic scoring and reporting.
 */
export const CHECKPOINT_ABLATION_STRATEGIES = [
  PI_BASELINE_CHECKPOINT_STRATEGY,
  PI_RECENT_USER_CHECKPOINT_STRATEGY,
  PI_RECENT_USER_PINNED_CHECKPOINT_STRATEGY,
  CODEX_STYLE_CHECKPOINT_STRATEGY,
] as const

export async function runCheckpointAblationReplay(
  fixtures: readonly CheckpointQualityFixture[],
  generator: BlindedCheckpointSummaryGenerator,
  options: RunBlindedCheckpointReplayOptions,
): Promise<CheckpointAblationResult> {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error('Checkpoint replay repetitions must be a positive integer.')
  }
  for (const fixture of fixtures) {
    const errors = validateCheckpointPinnedFacts(fixture)
    if (errors.length > 0) throw new Error(`Pinned fact evidence validation failed: ${errors.join(' ')}`)
  }
  const providerRequestStrategies = [
    PI_BASELINE_CHECKPOINT_STRATEGY,
    CODEX_STYLE_CHECKPOINT_STRATEGY,
  ] as const
  const sharedPiStrategies = [
    PI_BASELINE_CHECKPOINT_STRATEGY,
    PI_RECENT_USER_CHECKPOINT_STRATEGY,
    PI_RECENT_USER_PINNED_CHECKPOINT_STRATEGY,
  ] as const
  const jobs = shuffled(
    fixtures.flatMap(fixture => Array.from({ length: options.repetitions }, (_, repetition) => (
      providerRequestStrategies.map(strategy => ({ fixture, repetition, strategy }))
    )).flat()),
    options.seed,
  )
  const artifacts = new Map<string, CheckpointArtifact>()
  for (const [jobIndex, job] of jobs.entries()) {
    const progress = { ordinal: jobIndex + 1, total: jobs.length }
    options.onRequestStart?.(progress)
    const artifact = await runCheckpointStrategy(
      job.fixture,
      job.strategy,
      {
        generate: ({ fixtureId, prompt, messages }) => generator.generate({ fixtureId, prompt, messages }),
      },
      options,
    )
    if (job.strategy.id === 'pi-baseline') {
      for (const strategy of sharedPiStrategies) {
        artifacts.set(`${job.fixture.id}:${job.repetition}:${strategy.id}`, {
          ...artifact,
          strategy: strategy.id,
          replacementHistory: strategy.buildReplacementHistory(job.fixture, artifact.checkpoint),
          providerUsage: artifact.providerUsage ? { ...artifact.providerUsage } : undefined,
        })
      }
    }
    else {
      artifacts.set(`${job.fixture.id}:${job.repetition}:${job.strategy.id}`, artifact)
    }
    options.onRequestComplete?.(progress)
  }

  const candidateStrategies = CHECKPOINT_ABLATION_STRATEGIES.filter(
    (strategy): strategy is Exclude<typeof strategy, typeof PI_BASELINE_CHECKPOINT_STRATEGY> => (
      strategy.id !== 'pi-baseline'
    ),
  )
  const arms = candidateStrategies.map<CheckpointAblationArmResult>((strategy) => {
    const comparisons = fixtures.flatMap(fixture => Array.from(
      { length: options.repetitions },
      (_, repetition) => {
        const baseline = artifacts.get(`${fixture.id}:${repetition}:pi-baseline`)
        const candidate = artifacts.get(`${fixture.id}:${repetition}:${strategy.id}`)
        if (!baseline || !candidate) throw new Error(`Checkpoint ablation sample is incomplete for ${fixture.id}.`)
        return compareCheckpointCandidate(fixture, baseline, candidate)
      },
    ))
    return {
      strategy: strategy.id,
      label: strategy.label,
      suite: evaluateCheckpointComparisons(fixtures, comparisons, {
        evidence: 'model_backed_blinded',
        samplesPerFixture: options.repetitions,
      }),
    }
  })
  const baseline = arms[0]?.suite.baseline ?? aggregateScores([])
  const samples = fixtures.flatMap(fixture => Array.from(
    { length: options.repetitions },
    (_, repetition) => CHECKPOINT_ABLATION_STRATEGIES.map((strategy) => {
      const artifact = artifacts.get(`${fixture.id}:${repetition}:${strategy.id}`)
      if (!artifact) throw new Error(`Checkpoint ablation artifact is missing for ${fixture.id}.`)
      const score = evaluateCheckpointArtifact(fixture, artifact)
      return {
        sampleId: `${fixture.id}:${repetition + 1}:${strategy.id}`,
        providerRequestId: `${fixture.id}:${repetition + 1}:${strategy.id === 'codex-style-recent-user' ? 'codex-style' : 'pi-structured'}`,
        promptFamily: (strategy.id === 'codex-style-recent-user' ? 'codex-style' : 'pi-structured') as CheckpointPromptFamilyId,
        fixtureId: fixture.id,
        repetition: repetition + 1,
        strategy: strategy.id,
        summaryInputTokens: score.summaryInputTokens,
        summaryOutputTokens: score.summaryOutputTokens,
        summaryLatencyMs: score.summaryLatencyMs,
        factRecall: score.factRecall,
        falseCompletionCount: score.falseCompletionCount,
        resumeSuccess: score.resumeSuccess,
        providerUsage: score.providerUsage ? { ...score.providerUsage } : undefined,
      }
    }),
  )).flat()
  const qualifying = arms
    .filter(arm => arm.suite.productionDecision.outcome === 'go')
    .sort((left, right) => (
      right.suite.candidate.factRecall - left.suite.candidate.factRecall
      || right.suite.candidate.resumeSuccessRate - left.suite.candidate.resumeSuccessRate
      || (left.suite.candidate.p95SummaryLatencyMs ?? Infinity) - (right.suite.candidate.p95SummaryLatencyMs ?? Infinity)
    ))

  return {
    fixtureCount: fixtures.length,
    repetitions: options.repetitions,
    requestCount: jobs.length,
    seed: options.seed,
    baseline,
    arms,
    samples,
    ...(qualifying[0] ? { recommendedStrategy: qualifying[0].strategy } : {}),
  }
}

function ablationLabel(strategy: CheckpointEvalStrategyId): string {
  switch (strategy) {
    case 'pi-baseline': return 'Pi prompt + current replacement'
    case 'pi-recent-user': return 'Pi prompt + recent user'
    case 'pi-recent-user-pinned': return 'Pi prompt + recent user + pinned facts'
    case 'codex-style-recent-user': return 'Codex-style prompt + recent user'
  }
}

export function renderCheckpointAblationReport(
  result: CheckpointAblationResult,
  options: RenderCheckpointAblationReportOptions = {},
): string {
  const rows = [
    {
      strategy: 'pi-baseline' as const,
      aggregate: result.baseline,
      deltaRecall: 0,
      deltaResume: 0,
      latencyRatio: 1,
      gate: 'baseline',
    },
    ...result.arms.map(arm => ({
      strategy: arm.strategy,
      aggregate: arm.suite.candidate,
      deltaRecall: arm.suite.delta.factRecall,
      deltaResume: arm.suite.delta.resumeSuccessRate,
      latencyRatio: arm.suite.candidate.p95SummaryLatencyMs !== undefined
        && result.baseline.p95SummaryLatencyMs !== undefined
        && result.baseline.p95SummaryLatencyMs > 0
        ? arm.suite.candidate.p95SummaryLatencyMs / result.baseline.p95SummaryLatencyMs
        : undefined,
      gate: arm.suite.productionDecision.outcome,
    })),
  ]
  const usageKeys: Array<{ key: keyof CheckpointProviderUsage; label: string }> = [
    { key: 'inputTokens', label: 'Input tokens' },
    { key: 'outputTokens', label: 'Output tokens' },
    { key: 'reasoningTokens', label: 'Reasoning tokens' },
    { key: 'cacheReadTokens', label: 'Cache read tokens' },
    { key: 'cacheWriteTokens', label: 'Cache write tokens' },
    { key: 'totalTokens', label: 'Total tokens' },
  ]
  const physicalRequests = [...new Map(
    result.samples.map(sample => [sample.providerRequestId, sample]),
  ).values()]
  const totalPhysicalProviderUsage = (
    promptFamily: CheckpointPromptFamilyId,
    key: keyof CheckpointProviderUsage,
  ): number => physicalRequests
    .filter(sample => sample.promptFamily === promptFamily)
    .reduce((total, sample) => total + (sample.providerUsage?.[key] ?? 0), 0)
  const categories = [...new Set(rows.flatMap(row => Object.keys(row.aggregate.categoryRecall)))]
    .sort() as CheckpointFactCategory[]

  return [
    '# Checkpoint Quality Ablation — Iteration 8 Corrected Replay',
    '',
    `> ${result.fixtureCount} fixtures × 2 prompt families × ${result.repetitions} repetitions，共 ${result.requestCount} 次真实摘要请求和 ${result.samples.length} 个策略评分样本；三个 Pi replacement arms 共享同一 checkpoint、usage 与 latency，策略标签未进入 provider input。`,
    '',
    '## Runtime',
    '',
    `- Provider: ${options.provider ?? '未记录'}`,
    `- Model: ${options.model ?? '未记录'}`,
    `- Reasoning: ${options.reasoning ?? '未记录'}`,
    `- Seed: ${result.seed}`,
    `- Repetitions per fixture: ${result.repetitions}`,
    '',
    '## Aggregate Quality and Latency',
    '',
    '| Strategy | Fact recall | Resume success | False completion | Avg input | Avg output | Avg replacement | Avg latency | P95 latency | Recall delta | Resume delta | P95 ratio | Production gate |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(row => `| ${ablationLabel(row.strategy)} | ${percentage(row.aggregate.factRecall)} | ${percentage(row.aggregate.resumeSuccessRate)} | ${row.aggregate.falseCompletionCount} | ${optionalMetric(row.aggregate.summaryInputTokens)} | ${row.aggregate.summaryOutputTokens.toFixed(1)} | ${row.aggregate.replacementHistoryTokens.toFixed(1)} | ${optionalMetric(row.aggregate.averageSummaryLatencyMs, ' ms')} | ${optionalMetric(row.aggregate.p95SummaryLatencyMs, ' ms')} | ${percentagePointDelta(row.deltaRecall)} | ${percentagePointDelta(row.deltaResume)} | ${row.latencyRatio === undefined ? '未采集' : percentage(row.latencyRatio)} | ${row.gate} |`),
    '',
    '## Physical Provider Usage Totals',
    '',
    '> Pi baseline、Pi + recent user 与 Pi + pinned facts 复用同一批 Pi structured 请求，以下只统计实际发出的 provider requests，不重复计算派生评分样本。',
    '',
    '| Usage | Pi structured requests | Codex-style requests |',
    '|---|---:|---:|',
    ...usageKeys.map(({ key, label }) => `| ${label} | ${totalPhysicalProviderUsage('pi-structured', key)} | ${totalPhysicalProviderUsage('codex-style', key)} |`),
    '',
    '## Category Recall',
    '',
    `| Category | ${rows.map(row => ablationLabel(row.strategy)).join(' | ')} |`,
    `|---|${rows.map(() => '---:').join('|')}|`,
    ...categories.map(category => `| ${category} | ${rows.map(row => percentage(row.aggregate.categoryRecall[category] ?? 0)).join(' | ')} |`),
    '',
    '## Per-Arm Decisions',
    '',
    ...result.arms.flatMap(arm => [
      `### ${ablationLabel(arm.strategy)}`,
      '',
      `- Production gate: **${arm.suite.productionDecision.outcome.toUpperCase()}**`,
      ...arm.suite.productionDecision.reasons.map(reason => `  - ${reason}`),
      '',
    ]),
    '## Recommendation',
    '',
    result.recommendedStrategy
      ? `- 推荐进入生产 seam 的候选：**${ablationLabel(result.recommendedStrategy)}**。`
      : '- 当前没有策略通过全部生产门槛。',
    '- 该结论仍限于离线 fixture replay；接入生产前必须保持完整 transcript、fail-closed 和回退开关。',
    '',
  ].join('\n')
}

export async function runBlindedCheckpointReplay(
  fixtures: readonly CheckpointQualityFixture[],
  generator: BlindedCheckpointSummaryGenerator,
  options: RunBlindedCheckpointReplayOptions,
): Promise<BlindedCheckpointReplayResult> {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error('Checkpoint replay repetitions must be a positive integer.')
  }
  const strategies = [PI_BASELINE_CHECKPOINT_STRATEGY, CODEX_STYLE_CHECKPOINT_STRATEGY] as const
  const jobs = shuffled(
    fixtures.flatMap(fixture => Array.from({ length: options.repetitions }, (_, repetition) => (
      strategies.map(strategy => ({ fixture, repetition, strategy }))
    )).flat()),
    options.seed,
  )
  const artifacts = new Map<string, CheckpointArtifact>()
  for (const [jobIndex, job] of jobs.entries()) {
    const progress = { ordinal: jobIndex + 1, total: jobs.length }
    options.onRequestStart?.(progress)
    const artifact = await runCheckpointStrategy(
      job.fixture,
      job.strategy,
      {
        generate: ({ fixtureId, prompt, messages }) => generator.generate({
          fixtureId,
          prompt,
          messages,
        }),
      },
      options,
    )
    artifacts.set(`${job.fixture.id}:${job.repetition}:${job.strategy.id}`, artifact)
    options.onRequestComplete?.(progress)
  }

  const comparisons = fixtures.flatMap(fixture => Array.from(
    { length: options.repetitions },
    (_, repetition) => {
      const baseline = artifacts.get(`${fixture.id}:${repetition}:pi-baseline`)
      const candidate = artifacts.get(`${fixture.id}:${repetition}:codex-style-recent-user`)
      if (!baseline || !candidate) throw new Error(`Checkpoint replay sample is incomplete for ${fixture.id}.`)
      return compareCheckpointStrategies(fixture, [baseline, candidate])
    },
  ))
  const suite = evaluateCheckpointComparisons(fixtures, comparisons, {
    evidence: 'model_backed_blinded',
    samplesPerFixture: options.repetitions,
  })
  const samples = comparisons.flatMap((comparison, comparisonIndex) => {
    const repetition = comparisonIndex % options.repetitions
    return ([comparison.baseline, comparison.candidate] as const).map(score => ({
      sampleId: `${comparison.fixtureId}:${repetition + 1}:${score.strategy}`,
      providerRequestId: `${comparison.fixtureId}:${repetition + 1}:${score.strategy === 'pi-baseline' ? 'pi-structured' : 'codex-style'}`,
      promptFamily: (score.strategy === 'pi-baseline' ? 'pi-structured' : 'codex-style') as CheckpointPromptFamilyId,
      fixtureId: comparison.fixtureId,
      repetition: repetition + 1,
      strategy: score.strategy,
      summaryInputTokens: score.summaryInputTokens,
      summaryOutputTokens: score.summaryOutputTokens,
      summaryLatencyMs: score.summaryLatencyMs,
      factRecall: score.factRecall,
      falseCompletionCount: score.falseCompletionCount,
      resumeSuccess: score.resumeSuccess,
      providerUsage: score.providerUsage ? { ...score.providerUsage } : undefined,
    }))
  })

  return {
    fixtureCount: fixtures.length,
    repetitions: options.repetitions,
    requestCount: jobs.length,
    seed: options.seed,
    samples,
    suite,
  }
}

export function evaluateCheckpointSuite(
  fixtures: readonly CheckpointQualityFixture[],
): CheckpointSuiteResult {
  const comparisons = fixtures.map((fixture) => {
    if (!fixture.referenceArtifacts) {
      throw new Error(`Checkpoint fixture ${fixture.id} is missing reference artifacts.`)
    }
    const baselineCheckpoint = fixture.referenceArtifacts.baselineCheckpoint
    const candidateCheckpoint = fixture.referenceArtifacts.candidateCheckpoint
    return compareCheckpointStrategies(fixture, [
      {
        strategy: 'pi-baseline',
        checkpoint: baselineCheckpoint,
        replacementHistory: PI_BASELINE_CHECKPOINT_STRATEGY.buildReplacementHistory(
          fixture,
          baselineCheckpoint,
        ),
        summaryInputTokens: fixture.referenceArtifacts.baselineSummaryInputTokens,
      },
      {
        strategy: 'codex-style-recent-user',
        checkpoint: candidateCheckpoint,
        replacementHistory: CODEX_STYLE_CHECKPOINT_STRATEGY.buildReplacementHistory(
          fixture,
          candidateCheckpoint,
        ),
        summaryInputTokens: fixture.referenceArtifacts.candidateSummaryInputTokens,
      },
    ])
  })
  return evaluateCheckpointComparisons(fixtures, comparisons, {
    evidence: 'deterministic_reference',
  })
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function percentagePointDelta(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(1)} pp`
}

function optionalMetric(value: number | undefined, suffix = ''): string {
  return value === undefined ? '未采集' : `${value.toFixed(1)}${suffix}`
}

export interface RenderCheckpointSuiteReportOptions {
  title?: string
  evidence?: CheckpointEvidenceKind
  repetitions?: number
  provider?: string
  model?: string
  reasoning?: string
  seed?: string
}

/** Render a stable Markdown artifact for review without changing production compaction. */
export function renderCheckpointSuiteReport(
  result: CheckpointSuiteResult,
  options: RenderCheckpointSuiteReportOptions = {},
): string {
  const rows = result.comparisons.map(comparison => [
    comparison.fixtureId,
    percentage(comparison.baseline.factRecall),
    percentage(comparison.candidate.factRecall),
    comparison.baseline.falseCompletionCount.toString(),
    comparison.candidate.falseCompletionCount.toString(),
    comparison.baseline.resumeSuccess ? 'yes' : 'no',
    comparison.candidate.resumeSuccess ? 'yes' : 'no',
  ])
  const baselineLatency = result.baseline.observedLatencySamples === 0
    ? '未采集真实 provider latency'
    : optionalMetric(result.baseline.p95SummaryLatencyMs, ' ms P95')
  const candidateLatency = result.candidate.observedLatencySamples === 0
    ? '未采集真实 provider latency'
    : optionalMetric(result.candidate.p95SummaryLatencyMs, ' ms P95')
  const categories = [...new Set([
    ...Object.keys(result.baseline.categoryRecall),
    ...Object.keys(result.candidate.categoryRecall),
  ])].sort() as CheckpointFactCategory[]

  const modelBacked = options.evidence === 'model_backed_blinded'
  const baselineScores = result.comparisons.map(comparison => comparison.baseline)
  const candidateScores = result.comparisons.map(comparison => comparison.candidate)
  const totalProviderUsage = (
    scores: readonly CheckpointQualityScore[],
    key: keyof CheckpointProviderUsage,
  ): number => scores.reduce((total, score) => total + (score.providerUsage?.[key] ?? 0), 0)
  const p95LatencyRatio = result.baseline.p95SummaryLatencyMs
    && result.candidate.p95SummaryLatencyMs !== undefined
    ? result.candidate.p95SummaryLatencyMs / result.baseline.p95SummaryLatencyMs
    : undefined
  const evidenceDescription = modelBacked
    ? `这是 blinded model-backed replay；${result.fixtureCount} 个 fixtures × ${options.repetitions ?? 1} 次重复 × 2 个策略，共 ${result.sampleCount * 2} 次真实摘要请求。生产默认仍为 Pi checkpoint。`
    : '这是确定性 fixture 与 replacement-history 评测，不是 blinded model benchmark；生产默认仍为 Pi checkpoint。'
  const runtimeMetadata = modelBacked
    ? [
        '## Replay Runtime',
        '',
        `- Provider: ${options.provider ?? '未记录'}`,
        `- Model: ${options.model ?? '未记录'}`,
        `- Reasoning: ${options.reasoning ?? '未记录'}`,
        `- Seed: ${options.seed ?? '未记录'}`,
        `- Repetitions per fixture: ${options.repetitions ?? 1}`,
        `- Comparison samples: ${result.sampleCount}`,
        '',
        '### Provider Usage Totals',
        '',
        '| Usage | Pi baseline | Codex-style candidate |',
        '|---|---:|---:|',
        `| Input tokens | ${totalProviderUsage(baselineScores, 'inputTokens')} | ${totalProviderUsage(candidateScores, 'inputTokens')} |`,
        `| Output tokens | ${totalProviderUsage(baselineScores, 'outputTokens')} | ${totalProviderUsage(candidateScores, 'outputTokens')} |`,
        `| Reasoning tokens | ${totalProviderUsage(baselineScores, 'reasoningTokens')} | ${totalProviderUsage(candidateScores, 'reasoningTokens')} |`,
        `| Cache read tokens | ${totalProviderUsage(baselineScores, 'cacheReadTokens')} | ${totalProviderUsage(candidateScores, 'cacheReadTokens')} |`,
        `| Cache write tokens | ${totalProviderUsage(baselineScores, 'cacheWriteTokens')} | ${totalProviderUsage(candidateScores, 'cacheWriteTokens')} |`,
        '',
      ]
    : []

  return [
    options.title ?? '# Checkpoint Quality Evaluation — Iteration 6',
    '',
    `> ${evidenceDescription}`,
    '',
    ...runtimeMetadata,
    '## Coverage',
    '',
    ...result.coverage.map(item => `- ${item}`),
    '',
    '## Aggregate',
    '',
    '| Metric | Pi baseline | Codex-style candidate | Delta |',
    '|---|---:|---:|---:|',
    `| Fact recall | ${percentage(result.baseline.factRecall)} | ${percentage(result.candidate.factRecall)} | ${percentagePointDelta(result.delta.factRecall)} |`,
    `| Resume success | ${percentage(result.baseline.resumeSuccessRate)} | ${percentage(result.candidate.resumeSuccessRate)} | ${percentagePointDelta(result.delta.resumeSuccessRate)} |`,
    `| False completion | ${result.baseline.falseCompletionCount} | ${result.candidate.falseCompletionCount} | ${result.delta.falseCompletionCount} |`,
    `| Avg summary input tokens | ${optionalMetric(result.baseline.summaryInputTokens)} | ${optionalMetric(result.candidate.summaryInputTokens)} | ${optionalMetric(result.delta.summaryInputTokens)} |`,
    `| ${modelBacked ? 'Avg provider summary output tokens' : 'Approx avg summary output tokens'} | ${result.baseline.summaryOutputTokens.toFixed(1)} | ${result.candidate.summaryOutputTokens.toFixed(1)} | ${result.delta.summaryOutputTokens.toFixed(1)} |`,
    `| Approx avg replacement-history tokens | ${result.baseline.replacementHistoryTokens.toFixed(1)} | ${result.candidate.replacementHistoryTokens.toFixed(1)} | ${result.delta.replacementHistoryTokens.toFixed(1)} |`,
    `| Summary latency | ${baselineLatency} | ${candidateLatency} | ${optionalMetric(result.delta.p95SummaryLatencyMs, ' ms P95')} |`,
    ...(modelBacked ? [`| Candidate / baseline P95 | 100.0% | ${p95LatencyRatio === undefined ? '未采集' : percentage(p95LatencyRatio)} | ${p95LatencyRatio === undefined ? '未采集' : percentagePointDelta(p95LatencyRatio - 1)} |`] : []),
    '',
    '## Category Recall',
    '',
    '| Category | Pi baseline | Codex-style candidate |',
    '|---|---:|---:|',
    ...categories.map(category => `| ${category} | ${percentage(result.baseline.categoryRecall[category] ?? 0)} | ${percentage(result.candidate.categoryRecall[category] ?? 0)} |`),
    '',
    '## Fixture Results',
    '',
    '| Fixture | Pi recall | Candidate recall | Pi false completion | Candidate false completion | Pi resume | Candidate resume |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(row => `| ${row.join(' | ')} |`),
    '',
    '## Decision',
    '',
    `- **${result.productionDecision.outcome === 'go' ? 'GO' : 'NO-GO'}：替换生产 Pi compactor**`,
    ...result.productionDecision.reasons.map(reason => `  - ${reason}`),
    `- **${result.nextExperimentDecision.outcome === 'go' ? 'GO' : 'NO-GO'}：继续 pinned facts / model-backed replay 实验**`,
    ...result.nextExperimentDecision.reasons.map(reason => `  - ${reason}`),
    '',
    '## Interpretation',
    '',
    '- 大型工具输出继续使用 provider-only head/tail projection；fixture 原始消息保持不变。',
    ...(modelBacked
      ? [
          '- 本报告来自同一 provider/model 的随机顺序盲测；策略标签未进入 provider input。',
          '- 下一阶段应加入确定性 pinned facts 并重复盲测，确认精确状态收益和延迟门槛。',
          '- 只有重复盲测仍达到门槛时，才引入 Domi-owned ContextCompactor seam。',
        ]
      : [
          '- 当前增益主要来自保留近期真实用户纠正，而不是证明 Codex 提示词本身优于 Pi。',
          '- 下一阶段必须使用同一模型对 blinded fixtures 实际生成摘要，采集 provider usage、latency、事实召回和 false completion。',
          '- 若 model-backed replay 仍支持该方向，再引入 Domi-owned ContextCompactor seam 与确定性 pinned facts。',
        ]),
    '',
  ].join('\n')
}
