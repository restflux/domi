import { describe, expect, test } from 'bun:test'
import {
  consumeTerminalInputFallbackHandledData,
  createPendingTerminalInputFallback,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
} from './terminalComposedInputFallback.ts'

describe('v2 终端 Windows 输入法回退', () => {
  test('xterm 已接收的候选词不会被 textarea 再写一次', () => {
    const pending = createPendingTerminalInputFallback('中文')
    const candidate = createTerminalInputFallbackKeydownCandidate({ key: 'Enter', eventTimeStamp: 100, now: 100 })
    const handled = recordTerminalInputFallbackHandledData({ candidate, data: '中文\r', history: [], maxAgeMs: 250, now: 120 })
    expect(handled.usedCandidate).toBe(true)
    consumeTerminalInputFallbackHandledData({ history: handled.history, pending, inputEventTimeStamp: 130, maxAgeMs: 250, maxInputDelayMs: 75, now: 130 })
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: '中文' })).toEqual({ shouldWrite: false, shouldClearTextarea: true })
  })

  test('未收到 xterm onData 时仍可补发文本，空 textarea 不补发', () => {
    const pending = createPendingTerminalInputFallback('测试')
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: '测试' })).toEqual({ shouldWrite: true, shouldClearTextarea: true })
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: '' })).toEqual({ shouldWrite: false, shouldClearTextarea: false })
  })

  test('短窗口 onData 与 pending input 去重，但控制序列不得误命中', () => {
    const pending = createPendingTerminalInputFallback('好')
    markTerminalInputFallbackHandled([pending], '\x1b[D')
    expect(pending.handled).toBe(false)
    const history = recordTerminalInputFallbackRecentData({ data: '好', history: [], maxAgeMs: 250, now: 100 })
    consumeTerminalInputFallbackHandledData({ history, pending, inputEventTimeStamp: 110, maxAgeMs: 250, maxInputDelayMs: 75, now: 110 })
    expect(pending.handled).toBe(true)
    const subsequent = createPendingTerminalInputFallback('好')
    consumeTerminalInputFallbackHandledData({ history, pending: subsequent, inputEventTimeStamp: 115, maxAgeMs: 250, maxInputDelayMs: 75, now: 115 })
    expect(subsequent.handled).toBe(false)
  })
})
