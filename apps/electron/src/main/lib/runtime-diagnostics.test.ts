import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeDiagnostics, describeDiagnosticError } from './runtime-diagnostics'

let tempDir = ''

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'domi-runtime-diagnostics-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('runtime diagnostics', () => {
  test('追加结构化事件并清除敏感正文', () => {
    const diagnostics = createRuntimeDiagnostics({
      directory: tempDir,
      appVersion: '1.2.3',
      pid: 101,
      now: () => Date.UTC(2026, 7, 8, 5, 0, 0),
    })

    diagnostics.record('renderer_unresponsive', {
      reason: 'hung',
      prompt: '绝不能进入日志的用户正文',
      nested: { apiKey: 'sk-secret', safeCount: 3 },
    })

    const log = readFileSync(diagnostics.logPath, 'utf8')
    expect(log).toContain('renderer_unresponsive')
    expect(log).toContain('"safeCount":3')
    expect(log).not.toContain('绝不能进入日志的用户正文')
    expect(log).not.toContain('sk-secret')
    expect(log).toContain('[redacted]')
  })

  test('日志超过上限时只保留一份轮转文件', () => {
    let now = 1
    const diagnostics = createRuntimeDiagnostics({
      directory: tempDir,
      appVersion: '1.2.3',
      pid: 102,
      maxLogBytes: 260,
      now: () => now++,
    })

    diagnostics.record('first', { safe: 'a'.repeat(120) })
    diagnostics.record('second', { safe: 'b'.repeat(120) })
    diagnostics.record('third', { safe: 'c'.repeat(120) })

    expect(readFileSync(`${diagnostics.logPath}.1`, 'utf8')).toContain('second')
    expect(readFileSync(diagnostics.logPath, 'utf8')).toContain('third')
  })

  test('遗留 running marker 会在下次启动记录非正常退出', () => {
    let now = 100
    const first = createRuntimeDiagnostics({
      directory: tempDir,
      appVersion: '1.0.0',
      pid: 201,
      now: () => now++,
    })
    first.recordStart()

    now = 200
    const second = createRuntimeDiagnostics({
      directory: tempDir,
      appVersion: '1.0.1',
      pid: 202,
      now: () => now++,
    })
    second.recordStart()

    const log = readFileSync(second.logPath, 'utf8')
    expect(log).toContain('previous_unclean_exit')
    expect(log).toContain('"previousPid":201')
  })

  test('clean shutdown 不会在下次启动误报', () => {
    let now = 300
    const first = createRuntimeDiagnostics({
      directory: tempDir,
      appVersion: '1.0.0',
      pid: 301,
      now: () => now++,
    })
    first.recordStart()
    first.recordCleanShutdown()

    now = 400
    const second = createRuntimeDiagnostics({
      directory: tempDir,
      appVersion: '1.0.1',
      pid: 302,
      now: () => now++,
    })
    second.recordStart()

    const events = readFileSync(second.logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string })
    expect(events.filter((event) => event.event === 'previous_unclean_exit')).toHaveLength(0)
  })

  test('未知异常只记录类型、长度和 hash，不保存消息正文', () => {
    const description = describeDiagnosticError(new Error('用户消息或凭证不应落盘'))

    expect(description.name).toBe('Error')
    expect(description.messageLength).toBeGreaterThan(0)
    expect(description.messageHash).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.stringify(description)).not.toContain('用户消息')
  })
})
