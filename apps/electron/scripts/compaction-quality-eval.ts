import type { ProviderType } from '@domi/shared'
import type { ThinkingLevel } from '@earendil-works/pi-ai/compat'
import {
  evaluateCheckpointSuite,
  renderCheckpointAblationReport,
  renderCheckpointSuiteReport,
  runBlindedCheckpointReplay,
  runCheckpointAblationReplay,
} from '../src/main/lib/adapters/pi-compaction-quality-eval'
import { CHECKPOINT_QUALITY_FIXTURES } from '../src/main/lib/adapters/pi-compaction-quality-fixtures'
import {
  createConfiguredPiCheckpointCompletionRuntime,
  createPiCheckpointSummaryGenerator,
} from '../src/main/lib/adapters/pi-compaction-quality-model-runner'

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`
  const inline = process.argv.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = readOption(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer.`)
  return value
}

const format = process.argv.includes('--json') ? 'json' : 'markdown'
const modelBacked = process.argv.includes('--model-backed')
const ablation = process.argv.includes('--ablation')

if (!modelBacked) {
  const result = evaluateCheckpointSuite(CHECKPOINT_QUALITY_FIXTURES)
  console.log(format === 'json'
    ? JSON.stringify(result, null, 2)
    : renderCheckpointSuiteReport(result))
  process.exit(0)
}

const provider = (readOption('provider') ?? 'openai-responses') as ProviderType
const baseUrl = readOption('base-url') ?? 'https://wisdomrouter.relayflare.com/v1'
const modelId = readOption('model') ?? 'gpt-5.6-sol'
const apiKeyEnvironment = readOption('api-key-env') ?? 'WISDOMROUTER_API_KEY'
const apiKey = process.env[apiKeyEnvironment]?.trim()
if (!apiKey) throw new Error(`Missing provider credential in environment variable ${apiKeyEnvironment}.`)

const repetitions = readPositiveInteger('repetitions', ablation ? 10 : 3)
const seed = readOption('seed') ?? (ablation ? 'iteration-8' : 'iteration-7')
const reasoningOption = readOption('reasoning') ?? 'high'
const thinkingLevels: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
if (!thinkingLevels.includes(reasoningOption as ThinkingLevel)) {
  throw new Error('--reasoning must be one of minimal, low, medium, high, xhigh, or max.')
}
const reasoning = reasoningOption as ThinkingLevel
const maxTokens = readPositiveInteger('max-tokens', 4_000)
const timeoutMs = readPositiveInteger('timeout-ms', 120_000)
const runtime = await createConfiguredPiCheckpointCompletionRuntime({
  provider,
  baseUrl,
  apiKey,
  modelId,
  reasoning,
  maxTokens,
  timeoutMs,
})
const generator = createPiCheckpointSummaryGenerator(runtime)
const progress = {
  repetitions,
  seed,
  onRequestStart: ({ ordinal, total }: { ordinal: number; total: number }) => {
    console.error(`[checkpoint replay] request ${ordinal}/${total}`)
  },
}
const replay = ablation
  ? await runCheckpointAblationReplay(CHECKPOINT_QUALITY_FIXTURES, generator, progress)
  : await runBlindedCheckpointReplay(CHECKPOINT_QUALITY_FIXTURES, generator, progress)

const metadata = {
  evidence: 'model_backed_blinded' as const,
  provider,
  modelId,
  reasoning,
  repetitions,
  seed,
  requestCount: replay.requestCount,
  ablation,
}

if (format === 'json') {
  console.log(JSON.stringify({ ...metadata, replay }, null, 2))
} else if (ablation && 'arms' in replay) {
  console.log(renderCheckpointAblationReport(replay, {
    provider,
    model: modelId,
    reasoning,
  }))
} else if ('suite' in replay) {
  console.log(renderCheckpointSuiteReport(replay.suite, {
    title: '# Checkpoint Quality Evaluation — Iteration 7',
    evidence: metadata.evidence,
    provider,
    model: modelId,
    reasoning,
    repetitions,
    seed,
  }))
}
