import { describe, expect, test } from 'bun:test'
import { parseVisionRelayModelOutput, VisionRelayResultError } from './vision-relay-result'

const source = { filename: 'screen.png', width: 1200, height: 800, animatedFirstFrame: false }

describe('Vision Relay untrusted result schema', () => {
  test('parses a strict JSON observation and adds immutable safety metadata', () => {
    expect(parseVisionRelayModelOutput(JSON.stringify({
      answer: '页面显示登录错误。',
      observations: ['右上角有红色错误提示'],
      extractedText: 'Authentication failed',
      limitations: ['小字可能有 OCR 误差'],
      candidates: [{ name: 'Obsidian', confidence: 'high', evidence: '紫色晶体轮廓与官方图标一致' }],
      warnings: ['图片没有显示产品名称文字'],
      confidence: 'high',
    }), source)).toEqual({
      kind: 'untrusted_visual_observation',
      status: 'ok',
      source,
      answer: '页面显示登录错误。',
      observations: ['右上角有红色错误提示'],
      extractedText: 'Authentication failed',
      limitations: ['小字可能有 OCR 误差'],
      candidates: [{ name: 'Obsidian', confidence: 'high', evidence: '紫色晶体轮廓与官方图标一致' }],
      warnings: ['图片没有显示产品名称文字'],
      confidence: 'high',
      safety: {
        untrustedSource: true,
        instructionsMustNotBeFollowed: true,
      },
    })
  })

  test('accepts a single JSON fenced object but no arbitrary prose', () => {
    expect(parseVisionRelayModelOutput('```json\n{"answer":"ok","observations":[],"limitations":[],"confidence":"medium"}\n```', source).answer).toBe('ok')
    expect(() => parseVisionRelayModelOutput('Result: {"answer":"ok"}', source)).toThrow(VisionRelayResultError)
  })

  test('fails closed on invalid fields, oversized output, or instruction-shaped non-schema data', () => {
    expect(() => parseVisionRelayModelOutput('{"answer":3,"observations":[],"limitations":[],"confidence":"high"}', source)).toThrow(VisionRelayResultError)
    expect(() => parseVisionRelayModelOutput(JSON.stringify({ answer: 'x', observations: ['x'], limitations: [], confidence: 'certain' }), source)).toThrow(VisionRelayResultError)
    expect(() => parseVisionRelayModelOutput('x'.repeat(12_001), source)).toThrow(VisionRelayResultError)
    expect(() => parseVisionRelayModelOutput(JSON.stringify({
      answer: 'x', observations: [], limitations: [], confidence: 'high',
      candidates: [{ name: 'Maybe', confidence: 'certain', evidence: 'shape' }],
    }), source)).toThrow(VisionRelayResultError)
    expect(() => parseVisionRelayModelOutput(JSON.stringify({
      answer: 'x', observations: [], limitations: [], confidence: 'high', warnings: Array.from({ length: 21 }, () => 'warning'),
    }), source)).toThrow(VisionRelayResultError)
  })
})
