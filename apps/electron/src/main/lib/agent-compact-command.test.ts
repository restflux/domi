import { describe, expect, test } from 'bun:test'
import { parseAgentCompactCommand } from './agent-compact-command'

describe('parseAgentCompactCommand', () => {
  test.each([
    ['/compact', undefined],
    ['  /compact  ', undefined],
    ['/compact 保留 API 决策', '保留 API 决策'],
    ['/compact\n保留 API 决策\n继续使用当前方案', '保留 API 决策\n继续使用当前方案'],
    ['\n\t/compact\n\t保留 API 决策\n', '保留 API 决策'],
  ])('recognizes %j', (text, instructions) => {
    expect(parseAgentCompactCommand(text)).toEqual({
      matched: true,
      ...(instructions === undefined ? {} : { instructions }),
    })
  })

  test.each(['/compactness', '/compactfoo', '/Compact', 'prefix /compact', ''])('rejects %j', (text) => {
    expect(parseAgentCompactCommand(text)).toEqual({ matched: false })
  })

  test('trims only the command boundary and instruction edges', () => {
    expect(parseAgentCompactCommand('  /compact  保留第一条  \n  保留第二条  ')).toEqual({
      matched: true,
      instructions: '保留第一条  \n  保留第二条',
    })
  })
})
