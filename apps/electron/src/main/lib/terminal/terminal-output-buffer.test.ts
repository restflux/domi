import { describe, expect, test } from 'bun:test'
import { appendTerminalOutput, createTerminalOutputBuffer, readTerminalOutput } from './terminal-output-buffer.ts'

describe('terminal output buffer', () => {
  test('keeps a bounded suffix with monotonic stream offsets', () => {
    let buffer = createTerminalOutputBuffer()
    buffer = appendTerminalOutput(buffer, { terminalId: 't1', sequence: 1, data: '12345' }, 8)
    buffer = appendTerminalOutput(buffer, { terminalId: 't1', sequence: 2, data: '67890' }, 8)

    expect(buffer).toEqual({ output: '34567890', sequence: 2, startOffset: 2, endOffset: 10 })
  })

  test('reads by raw offset and strips terminal control sequences', () => {
    let buffer = createTerminalOutputBuffer()
    buffer = appendTerminalOutput(buffer, { terminalId: 't1', sequence: 1, data: '\u001b[31mred\u001b[0m\rprogress' }, 100)

    const read = readTerminalOutput(buffer, { offset: 0, limit: 100 })
    expect(read.output).toBe('red\nprogress')
    expect(read.startOffset).toBe(0)
    expect(read.endOffset).toBe(buffer.endOffset)
    expect(read.nextOffset).toBe(buffer.endOffset)
  })

  test('reports truncation when requested output has fallen out of the buffer', () => {
    let buffer = createTerminalOutputBuffer()
    buffer = appendTerminalOutput(buffer, { terminalId: 't1', sequence: 1, data: 'abcdefghij' }, 5)

    const read = readTerminalOutput(buffer, { offset: 0, limit: 2 })
    expect(read.output).toBe('fg')
    expect(read.truncatedBefore).toBe(true)
    expect(read.truncatedAfter).toBe(true)
    expect(read.nextOffset).toBe(7)
  })
})
