import type { TerminalOutputEvent, TerminalOutputReadResult } from '@domi/shared'

export interface TerminalOutputBuffer {
  output: string
  sequence: number
  startOffset: number
  endOffset: number
}

export interface TerminalOutputReadOptions {
  offset?: number
  limit?: number
}

const DEFAULT_READ_CHARS = 12_000
const MAX_READ_CHARS = 48_000

export function createTerminalOutputBuffer(): TerminalOutputBuffer {
  return { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
}

export function appendTerminalOutput(
  buffer: TerminalOutputBuffer,
  event: TerminalOutputEvent,
  maxChars: number,
): TerminalOutputBuffer {
  const combined = `${buffer.output}${event.data}`
  const retained = combined.length > maxChars ? combined.slice(-maxChars) : combined
  const endOffset = buffer.endOffset + event.data.length
  return {
    output: retained,
    sequence: event.sequence,
    startOffset: endOffset - retained.length,
    endOffset,
  }
}

export function readTerminalOutput(
  buffer: TerminalOutputBuffer,
  options: TerminalOutputReadOptions = {},
): TerminalOutputReadResult {
  const limit = normalizeLimit(options.limit)
  const requestedOffset = normalizeOffset(options.offset)
  const defaultOffset = Math.max(buffer.startOffset, buffer.endOffset - limit)
  const startOffset = clamp(requestedOffset ?? defaultOffset, buffer.startOffset, buffer.endOffset)
  const endOffset = Math.min(buffer.endOffset, startOffset + limit)
  const raw = buffer.output.slice(startOffset - buffer.startOffset, endOffset - buffer.startOffset)
  return {
    output: normalizeTerminalText(raw),
    startOffset,
    endOffset,
    nextOffset: endOffset,
    truncatedBefore: (requestedOffset ?? defaultOffset) < buffer.startOffset || requestedOffset === undefined && defaultOffset > buffer.startOffset,
    truncatedAfter: endOffset < buffer.endOffset,
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_CHARS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_READ_CHARS) {
    throw new Error(`终端读取长度必须是 1 到 ${MAX_READ_CHARS} 之间的整数`)
  }
  return value
}

function normalizeOffset(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('终端输出偏移必须是非负整数')
  return value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeTerminalText(output: string): string {
  return output
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[()][0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u0000/g, '')
    .replace(/\r(?!\n)/g, '\n')
}
