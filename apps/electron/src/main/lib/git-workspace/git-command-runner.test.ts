import { describe, expect, test } from 'bun:test'
import { getInFlightGitCommandCountForTest, runCommand, runGitCommand } from './git-command-runner.ts'

describe('git command runner', () => {
  test('runs parameter arrays without a shell and preserves stdout', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'hello world'])

    expect(result).toEqual({
      ok: true,
      stdout: 'hello world',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })
  })

  test('returns diagnostics for non-zero exit', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stderr.write("failed"); process.exit(7)'])

    expect(result.ok).toBeFalse()
    expect(result.exitCode).toBe(7)
    expect(result.stderr).toBe('failed')
    expect(result.timedOut).toBeFalse()
  })

  test('terminates commands that exceed the timeout', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { timeoutMs: 20 })

    expect(result.ok).toBeFalse()
    expect(result.timedOut).toBeTrue()
  })

  test('deduplicates identical in-flight git requests and releases the key', async () => {
    const first = runGitCommand(['--version'], process.cwd(), { dedupeKey: 'version' })
    const second = runGitCommand(['--version'], process.cwd(), { dedupeKey: 'version' })

    expect(first).toBe(second)
    expect(getInFlightGitCommandCountForTest()).toBe(1)
    const result = await first
    expect(result.ok).toBeTrue()
    expect(result.stdout).toContain('git version')
    expect(getInFlightGitCommandCountForTest()).toBe(0)
  })
})
