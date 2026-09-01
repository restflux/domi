import { describe, expect, test } from 'bun:test'
import { measureThinkingCollapse } from './thinking-collapse'

describe('thinking collapse measurement', () => {
  test('streaming and smooth-drain frames do not read layout; final content is measured once', () => {
    let layoutReads = 0
    const element = {
      get scrollHeight() {
        layoutReads += 1
        return 120
      },
    }

    for (let frame = 0; frame < 20; frame += 1) {
      expect(measureThinkingCollapse({
        element,
        isStreaming: true,
        displayedContent: `思考 ${frame}`,
        finalContent: '完整思考',
        lastMeasuredContent: null,
        lineHeight: 22,
      })).toBeUndefined()
    }
    expect(measureThinkingCollapse({
      element,
      isStreaming: false,
      displayedContent: '完整思',
      finalContent: '完整思考',
      lastMeasuredContent: null,
      lineHeight: 22,
    })).toBeUndefined()

    const measured = measureThinkingCollapse({
      element,
      isStreaming: false,
      displayedContent: '完整思考',
      finalContent: '完整思考',
      lastMeasuredContent: null,
      lineHeight: 22,
    })
    expect(measured).toEqual({ measuredContent: '完整思考', shouldCollapse: true })
    expect(measureThinkingCollapse({
      element,
      isStreaming: false,
      displayedContent: '完整思考',
      finalContent: '完整思考',
      lastMeasuredContent: measured?.measuredContent ?? null,
      lineHeight: 22,
    })).toBeUndefined()
    expect(layoutReads).toBe(1)
  })
})
