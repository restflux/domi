import { describe, expect, test } from 'bun:test'
import { compareTestFailures, extractTestFailures } from './test-baseline.ts'

describe('Windows 测试基线解析器', () => {
  test('Given GitHub Actions group 文件头 When 解析 Bun 输出 Then 识别文件与失败', () => {
    const output = [
      '::group::apps/electron/src/main/lib/example.test.ts:',
      '(fail) Example > reports a failure [12.00ms]',
      '::endgroup::',
    ].join('\r\n')

    expect(extractTestFailures(output)).toEqual([
      'apps/electron/src/main/lib/example.test.ts :: Example > reports a failure',
    ])
  })

  test('Given 同一文件有重复 unnamed 失败 When 解析 Then 保留每一次出现', () => {
    const output = [
      'apps/cli/src/paths.test.ts:',
      '(fail) (unnamed)',
      '(fail) (unnamed)',
    ].join('\n')

    expect(extractTestFailures(output)).toEqual([
      'apps/cli/src/paths.test.ts :: (unnamed)',
      'apps/cli/src/paths.test.ts :: (unnamed)',
    ])
  })

  test('Given 同一文件有重复未处理错误 When 解析 Then 保留每一次出现', () => {
    const output = [
      'packages/shared/src/config/index.test.ts:',
      '# Unhandled error between tests',
      '# Unhandled error between tests',
    ].join('\n')

    expect(extractTestFailures(output)).toEqual([
      'packages/shared/src/config/index.test.ts :: [unhandled error]',
      'packages/shared/src/config/index.test.ts :: [unhandled error]',
    ])
  })
})

describe('Windows 测试基线比较器', () => {
  test('Given 已知、已消失和新增失败 When 按出现次数比较 Then 分别统计', () => {
    const comparison = compareTestFailures(
      ['a :: failure', 'a :: failure', 'b :: resolved'],
      ['a :: failure', 'a :: failure', 'a :: failure'],
      1,
    )

    expect(comparison.known).toHaveLength(2)
    expect(comparison.resolved).toEqual(['b :: resolved'])
    expect(comparison.regressions).toEqual(['a :: failure'])
    expect(comparison.unexpectedNonzeroExit).toBe(false)
  })

  test('Given 非零退出且没有可识别失败 When 比较 Then 标记异常退出', () => {
    const comparison = compareTestFailures(['a :: known'], [], 2)

    expect(comparison.resolved).toEqual(['a :: known'])
    expect(comparison.regressions).toEqual([])
    expect(comparison.unexpectedNonzeroExit).toBe(true)
  })
})
