import { beforeAll, describe, expect, test } from 'bun:test'
import { createBashToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { initializeShellAnalysis } from '../execution-policy/shell-analysis.ts'
import { createRtkBashToolDefinition, type PiRtkOutputOptions } from './pi-rtk-output.ts'
import { installPiFinalToolGuard, type PiFinalToolGuardSession } from './pi-final-tool-guard.ts'

beforeAll(initializeShellAnalysis)
const raw = ' M src/example.ts\n'.repeat(100)
const ctx = {} as Parameters<ToolDefinition['execute']>[4]
function setup(code: number | null = 0, output = raw) {
  const commands: string[] = []
  const saved: string[] = []
  let filters = 0
  const options: PiRtkOutputOptions = {
    isEnabled: () => true, getWorkflow: () => 'direct', supportedShell: true,
    dependencies: {
      filter: async () => { filters++; return '100 modified files' },
      saveOriginal: async text => { saved.push(text); return '/session/rtk-output/raw.txt' },
      record: () => {},
    },
  }
  const create = (onExit: (exitCode: number | null) => void) => createBashToolDefinition(process.cwd(), {
    exposeSessionEnvironment: false,
    operations: {
      async exec(command, _cwd, { onData }) {
        commands.push(command)
        onData(Buffer.from(output))
        onExit(code)
        return { exitCode: code }
      },
    },
  }) as unknown as ToolDefinition
  const execute = (command = 'git status') => createRtkBashToolDefinition(create, options)
    .execute('call-1', { command }, undefined, undefined, ctx)
  return { options, execute, commands, saved, filters: () => filters }
}

describe('Pi RTK 最终结果', () => {
  test('Given 成功命令 When 优化 Then 原命令只执行一次且原始输出可取回', async () => {
    const fixture = setup()
    const result = await fixture.execute()
    expect(fixture.commands).toEqual(['git status'])
    expect(fixture.saved).toEqual([raw])
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('RTK') })
    expect(result.details).toMatchObject({ fullOutputPath: '/session/rtk-output/raw.txt' })
  })
  test('Given 关闭、研究、WSL、未知或截断结果 When 执行 Then 不启动过滤和写原文', async () => {
    for (const mode of ['off', 'research', 'wsl', 'unknown', 'truncated']) {
      const fixture = setup(0, mode === 'truncated' ? raw.repeat(40) : raw)
      if (mode === 'off') fixture.options.isEnabled = () => false
      if (mode === 'research') fixture.options.getWorkflow = () => 'read-only'
      if (mode === 'wsl') fixture.options.supportedShell = false
      await fixture.execute(mode === 'unknown' ? 'bun test' : 'git status')
      expect(fixture.commands).toHaveLength(1)
      expect(fixture.filters()).toBe(0)
      expect(fixture.saved).toEqual([])
    }
  })
  test('Given 失败或 null 退出码 When SDK 返回 Then 不将其优化为成功', async () => {
    const failed = setup(2)
    await expect(failed.execute()).rejects.toThrow('Command exited with code 2')
    expect(failed.filters()).toBe(0)
    const killed = setup(null)
    const result = await killed.execute()
    expect(result.content[0]).toMatchObject({ text: raw })
    expect(killed.filters()).toBe(0)
  })
  test('Given filter 失败 When 完成 Then 返回原始输出且不重跑命令', async () => {
    const fixture = setup()
    fixture.options.dependencies.filter = async () => { throw new Error('rtk failed') }
    const result = await fixture.execute()
    expect(fixture.commands).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ text: raw })
  })
  test('Given final guard 拒绝原始 Bash When 调度 Then 不进入执行或 RTK', async () => {
    const fixture = setup()
    const session: PiFinalToolGuardSession = { agent: {} }
    installPiFinalToolGuard(session, { cwd: process.cwd(), authorize: async request => {
      expect(request.input).toEqual({ command: 'git status' })
      return { behavior: 'deny', message: 'blocked' }
    } })
    const decision = await session.agent.beforeToolCall?.({ toolCall: { name: 'bash', id: 'call-1' }, args: { command: 'git status' } })
    if (!decision?.block) await fixture.execute()
    expect(decision?.block).toBe(true)
    expect(fixture.commands).toEqual([])
    expect(fixture.filters()).toBe(0)
  })
})
