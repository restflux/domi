import { describe, expect, test } from 'bun:test'
import { compactBunTestOutput, compactTypecheckOutput } from './rtk-bun-output.ts'

import { bunSuccess } from './bun-output.fixture.ts'

describe('Bun 原生文本格式适配', () => {
  test('Given 完整成功报告 When 折叠 Then 仅省略 pass 明细并保留所有其他行', () => {
    expect(compactBunTestOutput(bunSuccess)).toBe(bunSuccess.split('\n').filter(line => !line.startsWith('(pass)')).join('\n'))
    expect(compactBunTestOutput(bunSuccess.replace(' [0.21ms]', ''))).toBeDefined()
    expect(compactBunTestOutput(bunSuccess.replaceAll('\n', '\r\n'))).toContain('warning: fixture warning must remain')
  })
  test('Given 失败、截断、计数不符或其他格式 When 解析 Then 拒绝猜测', () => {
    for (const text of [
      bunSuccess.replace('0 fail', '1 fail'),
      bunSuccess.replace('2 pass', '3 pass'),
      bunSuccess.replace(/Ran .*\n$/, ''),
      bunSuccess + 'unexpected tail',
      bunSuccess.replace('bun test v', 'vitest v'),
      '1 error\nAssertionError: expected 2 to be 3\n',
    ]) expect(compactBunTestOutput(text)).toBeUndefined()
  })
  test('Given typecheck 输出 When 处理 Then 仅移除已知命令回显，诊断与构建内容不动', () => {
    const diagnostic = 'src/a.ts(1,1): error TS2322: Type string is not assignable to number'
    expect(compactTypecheckOutput(`$ tsc --noEmit\n${diagnostic}`)).toContain(diagnostic)
    expect(compactTypecheckOutput('$ vite build\nwarning: chunk too large')).toBeUndefined()
    expect(compactTypecheckOutput('$ echo tsc --noEmit')).toBeUndefined()
  })
})
