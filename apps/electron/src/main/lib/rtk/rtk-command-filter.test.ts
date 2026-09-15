import { beforeAll, describe, expect, test } from 'bun:test'
import { analyzeShellCommand, initializeShellAnalysis } from '../execution-policy/shell-analysis.ts'
import { selectRtkFilter } from './rtk-command-filter.ts'

beforeAll(initializeShellAnalysis)

describe('RTK 格式选择', () => {
  test('Given 单条明确文本命令 When 选择 Then 使用已验证的内置 filter', () => {
    for (const [command, filter] of [
      ['git status', 'git-status'], ['git status --short', 'git-status'],
      ['git log -5', 'git-log'], ['git log --oneline -10', 'git-log'],
      ['bun test ./src/a.test.ts', 'bun-test'], ['bun test', 'bun-test'],
      ['bun --cwd apps/electron test ./src/a.test.ts', 'bun-test'],
      ['bun run typecheck', 'typecheck-script'], ['bun run --cwd packages/shared typecheck', 'typecheck-script'],
      ['tsc --noEmit', 'tsc'], ['bun x tsc --noEmit', 'tsc'], ['vitest run', 'vitest'],
    ] as const) expect(selectRtkFilter(analyzeShellCommand(command))).toBe(filter)
  })

  test('Given 复杂、机器可读或未支持的命令 When 选择 Then 不做格式猜测', () => {
    for (const command of [
      'git status && git log', 'git status | cat', 'git status > out', 'git status; git log',
      'git status --porcelain', 'git status -z', 'git log --format=%H', 'git diff',
      'git log --stat', 'git log --patch', 'git log --oneline HEAD..main',
      'git -C /repo status', 'env X=1 git status', 'X=1 git status', 'echo $(git status)',
      'bash -c "git status"', 'git status "$FLAGS"', 'git status *',
      'bun test --reporter=junit', 'bun test --watch', 'bun run build', 'bun run unknown', 'bun x vitest run --reporter=json',
      'vitest run --outputFile=x', 'tsc --listFiles', 'echo git status', '/tmp/git status',
    ]) expect(selectRtkFilter(analyzeShellCommand(command))).toBeUndefined()
  })
})
