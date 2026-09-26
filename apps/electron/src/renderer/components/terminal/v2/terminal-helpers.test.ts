import { describe, expect, test } from 'bun:test'
import type { IBuffer } from '@xterm/xterm'
import { getHttpLinksForTerminalBufferLine } from './terminalLinks'
import { normalizePowerShellReadlineRedraw } from './terminalDataTransform'

function textBuffer(text: string): IBuffer {
  return {
    length: 1,
    getLine: (index: number) => index !== 0 ? undefined : {
      isWrapped: false,
      getCell: (cell: number) => cell < text.length ? {
        getWidth: () => 1,
        getChars: () => text[cell] ?? '',
      } : undefined,
    },
  } as unknown as IBuffer
}

describe('ZCode terminal helpers on Domi terminal buffers', () => {
  test('Given a URL with trailing punctuation When discovering links Then the activated range excludes punctuation', () => {
    const text = 'Visit https://example.com/path, now'
    const [link] = getHttpLinksForTerminalBufferLine(textBuffer(text), 1, text.length) ?? []
    expect(link?.text).toBe('https://example.com/path')
    expect(link?.range.start).toEqual({ x: 7, y: 1 })
    expect(link?.range.end).toEqual({ x: 30, y: 1 })
  })

  test('Given a PSReadLine redraw When using PowerShell Then only the redraw background is normalized', () => {
    const redraw = '\u001b[1;1H\u001b[37mabc\u001b[40m  '
    expect(normalizePowerShellReadlineRedraw(redraw, 'pwsh')).toContain('\u001b[49m')
    expect(normalizePowerShellReadlineRedraw(redraw, 'bash')).toBe(redraw)
    expect(normalizePowerShellReadlineRedraw('\u001b[40m plain', 'pwsh')).toBe('\u001b[40m plain')
  })
})
