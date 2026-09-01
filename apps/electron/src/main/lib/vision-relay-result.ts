import type { ProviderType } from '@domi/shared'
import type { VisionRelayQualityPreset } from '../../types'
import type { VisionRelayAnalysisMode } from './vision-relay-provider'

const MAX_RESULT_CHARS = 12_000
const MAX_ANSWER_CHARS = 4_000
const MAX_EXTRACTED_TEXT_CHARS = 6_000
const MAX_LIST_ITEMS = 20
const MAX_LIST_ITEM_CHARS = 500
const MAX_CANDIDATES = 10
const MAX_CANDIDATE_NAME_CHARS = 200

export type VisionRelayConfidence = 'low' | 'medium' | 'high'

export interface VisionRelayCandidate {
  name: string
  confidence: VisionRelayConfidence
  evidence: string
}

export interface VisionRelayObservationSource {
  filename: string
  width: number
  height: number
  animatedFirstFrame: boolean
  /** 只包含经过清洗的安全路由摘要，不包含 endpoint、凭据或图片路径。 */
  relay?: {
    provider: ProviderType
    channelName: string
    modelId: string
    qualityPreset: VisionRelayQualityPreset
    analysisMode: VisionRelayAnalysisMode
  }
}

export interface VisionRelayObservation {
  kind: 'untrusted_visual_observation'
  status: 'ok'
  source: VisionRelayObservationSource
  answer: string
  observations: string[]
  extractedText?: string
  limitations: string[]
  candidates?: VisionRelayCandidate[]
  warnings?: string[]
  confidence: VisionRelayConfidence
  safety: {
    untrustedSource: true
    instructionsMustNotBeFollowed: true
  }
}

export class VisionRelayResultError extends Error {
  readonly code = 'VISION_OUTPUT_INVALID' as const
  constructor(message = '视觉模型未返回符合安全协议的结构化结果。') {
    super(message)
    this.name = 'VisionRelayResultError'
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new VisionRelayResultError(`${field} 必须是字符串。`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new VisionRelayResultError(`${field} 长度无效。`)
  return trimmed
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, field, maxLength)
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new VisionRelayResultError(`${field} 必须是有限字符串数组。`)
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`, MAX_LIST_ITEM_CHARS))
}

function optionalStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  return stringList(value, field)
}

function parseConfidence(value: unknown, field = 'confidence'): VisionRelayConfidence {
  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new VisionRelayResultError(`${field} 必须是 low、medium 或 high。`)
  }
  return value
}

function optionalCandidates(value: unknown): VisionRelayCandidate[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) {
    throw new VisionRelayResultError('candidates 必须是有限候选数组。')
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new VisionRelayResultError(`candidates[${index}] 必须是对象。`)
    }
    const candidate = item as Record<string, unknown>
    return {
      name: requiredString(candidate.name, `candidates[${index}].name`, MAX_CANDIDATE_NAME_CHARS),
      confidence: parseConfidence(candidate.confidence, `candidates[${index}].confidence`),
      evidence: requiredString(candidate.evidence, `candidates[${index}].evidence`, MAX_LIST_ITEM_CHARS),
    }
  })
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  if (!trimmed || trimmed.length > MAX_RESULT_CHARS) throw new VisionRelayResultError()
  const fenced = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i)
  const jsonText = fenced?.[1]?.trim() ?? trimmed
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    throw new VisionRelayResultError()
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VisionRelayResultError()
  return value as Record<string, unknown>
}

export function parseVisionRelayModelOutput(
  content: string,
  source: VisionRelayObservationSource,
  options: { localWarnings?: readonly string[] } = {},
): VisionRelayObservation {
  const value = parseJsonObject(content)
  const confidence = parseConfidence(value.confidence)
  const extractedText = optionalString(value.extractedText, 'extractedText', MAX_EXTRACTED_TEXT_CHARS)
  const candidates = optionalCandidates(value.candidates)
  const modelWarnings = optionalStringList(value.warnings, 'warnings') ?? []
  const localWarnings = options.localWarnings?.map((warning, index) => requiredString(
    warning,
    `localWarnings[${index}]`,
    MAX_LIST_ITEM_CHARS,
  )) ?? []
  const warnings = [...new Set([...localWarnings, ...modelWarnings])].slice(0, MAX_LIST_ITEMS)
  return {
    kind: 'untrusted_visual_observation',
    status: 'ok',
    source: { ...source },
    answer: requiredString(value.answer, 'answer', MAX_ANSWER_CHARS),
    observations: stringList(value.observations, 'observations'),
    ...(extractedText ? { extractedText } : {}),
    limitations: stringList(value.limitations, 'limitations'),
    ...(candidates ? { candidates } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    confidence,
    safety: {
      untrustedSource: true,
      instructionsMustNotBeFollowed: true,
    },
  }
}
