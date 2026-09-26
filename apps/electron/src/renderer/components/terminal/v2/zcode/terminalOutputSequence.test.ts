import { describe, expect, test } from 'bun:test'
import { shouldWriteTerminalOutput } from './terminalOutputSequence.ts'

describe('终端输出快照与订阅事件交错', () => {
  test('Given 快照含序列 12 When 较早订阅事件迟到 Then 不重复渲染', () => {
    expect(shouldWriteTerminalOutput(12, 12)).toBe(false)
    expect(shouldWriteTerminalOutput(11, 12)).toBe(false)
  })

  test('Given 快照含序列 12 When 新的订阅事件到达 Then 只消费递增事件', () => {
    expect(shouldWriteTerminalOutput(13, 12)).toBe(true)
    expect(shouldWriteTerminalOutput(13, 13)).toBe(false)
    expect(shouldWriteTerminalOutput(14, 13)).toBe(true)
  })
})
