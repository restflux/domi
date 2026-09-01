import { describe, expect, test } from 'bun:test'
import type { CommandResult } from './git-command-runner.ts'
import { extractGitErrorMessage } from './git-workspace-module.ts'

function result(stderr: string, stdout = ''): CommandResult {
  return { ok: false, stdout, stderr, exitCode: 1, timedOut: false }
}

describe('extractGitErrorMessage', () => {
  test('优先返回包含错误关键词的行而非末尾 hint', () => {
    const stderr = [
      'To C:/tmp/remote.git',
      ' ! [rejected]        main -> main (non-fast-forward)',
      "error: failed to push some refs to 'C:/tmp/remote.git'",
      "hint: Updates were rejected because the tip of your current branch is behind",
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    ].join('\n')
    expect(extractGitErrorMessage(result(stderr))).toBe(
      '! [rejected]        main -> main (non-fast-forward)',
    )
  })

  test('无错误关键词时过滤提示行后取最后一行', () => {
    const stderr = [
      'Updating 1234567..89abcde',
      'hint: something generic',
      'some real failure line',
    ].join('\n')
    expect(extractGitErrorMessage(result(stderr))).toBe('some real failure line')
  })

  test('纯 hint 输出时回退到原始最后一行', () => {
    const stderr = [
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    ].join('\n')
    expect(extractGitErrorMessage(result(stderr))).toBe(
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    )
  })

  test('fatal 行优先于普通行', () => {
    expect(extractGitErrorMessage(result('fatal: not a git repository\nsome noise'))).toBe(
      'fatal: not a git repository',
    )
  })

  test('空输出返回兜底文案', () => {
    expect(extractGitErrorMessage(result(''))).toBe('Git 命令失败。')
  })
})

describe('extractGitErrorMessage CONFLICT', () => {
  test('merge 冲突时优先返回 CONFLICT 行', () => {
    const stderr = [
      'CONFLICT (content): Merge conflict in a.txt',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n')
    expect(extractGitErrorMessage(result(stderr))).toBe(
      'CONFLICT (content): Merge conflict in a.txt',
    )
  })
})
