import { describe, expect, test } from 'bun:test'
import type { TerminalSessionView } from '@domi/shared'
import {
  accumulateTerminalServiceOutput,
  extractLocalServiceUrls,
  formatElapsed,
  selectRunningAgentTerminals,
} from './running-terminals-model.ts'

const NOW = 1_000_000

const terminal = (overrides: Partial<TerminalSessionView>): TerminalSessionView => ({
  terminalId: 't1',
  ownerSessionId: 's1',
  kind: 'agent-run',
  presentation: 'workspace',
  title: 'Dev',
  cwd: '/repo',
  profile: 'bash',
  status: 'running',
  startedAt: 1,
  ...overrides,
})

describe('running terminals model', () => {
  test('只保留当前会话且仍在启动/运行的后台 agent 终端，并按启动时间排序', () => {
    const input = [
      terminal({ terminalId: 'a', ownerSessionId: 's2', startedAt: 90 }),
      terminal({ terminalId: 'b', status: 'exited', startedAt: 10 }),
      terminal({ terminalId: 'c', kind: 'user-shell', startedAt: 20 }),
      terminal({ terminalId: 'd', status: 'starting', startedAt: 30 }),
      terminal({ terminalId: 'e', startedAt: 40 }),
    ]
    const result = selectRunningAgentTerminals(input, 's1')
    expect(result.map((item) => item.terminalId)).toEqual(['d', 'e'])
  })

  test('不存在运行中的后台进程时返回空数组', () => {
    expect(selectRunningAgentTerminals([], 's1')).toEqual([])
    expect(selectRunningAgentTerminals(
      [terminal({ status: 'exited' }), terminal({ status: 'failed' })],
      's1',
    )).toEqual([])
  })

  test('只提取本地服务 URL，并把 wildcard 地址转换为可访问地址', () => {
    expect(extractLocalServiceUrls([
      '\u001b[32mLocal:\u001b[0m http://localhost:5173/',
      'Network: http://0.0.0.0:3080/api',
      'docs: https://example.com/reference',
      'duplicate: http://localhost:5173/',
    ].join('\n'))).toEqual([
      'http://localhost:5173/',
      'http://127.0.0.1:3080/api',
    ])
  })

  test('跨终端输出分片识别服务 URL，并保留历史入口', () => {
    const first = accumulateTerminalServiceOutput(undefined, 'ready at http://127.0.')
    expect(first.urls).toEqual([])

    const second = accumulateTerminalServiceOutput(first, '0.1:3080\n')
    expect(second.urls).toEqual(['http://127.0.0.1:3080/'])

    const third = accumulateTerminalServiceOutput(second, 'admin http://localhost:3080/admin\n')
    expect(third.urls).toEqual([
      'http://127.0.0.1:3080/',
      'http://localhost:3080/admin',
    ])
  })

  test('格式化已运行时长：秒 / 分钟 / 小时 / 天', () => {
    expect(formatElapsed(NOW - 5_000, NOW)).toBe('5 秒')
    expect(formatElapsed(NOW - 90_000, NOW)).toBe('1 分钟')
    expect(formatElapsed(NOW - 5_400_000, NOW)).toBe('1 小时 30 分钟')
    expect(formatElapsed(NOW - 172_800_000, NOW)).toBe('2 天 0 小时')
  })

  test('缺失启动时间时显示占位符', () => {
    expect(formatElapsed(undefined, NOW)).toBe('—')
  })
})
