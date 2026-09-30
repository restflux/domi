import { describe, expect, test } from 'bun:test'
import type { TerminalSessionView, TerminalOutputEvent, TerminalStateChange } from '@domi/shared'
import { createZCodeTerminalPort } from './zcode-terminal-port.ts'

function fixture() {
  const state: TerminalSessionView = {
    terminalId: 'pty-1', ownerSessionId: 'owner-1', kind: 'user-shell', presentation: 'dock',
    title: '终端', cwd: '/work', profile: 'bash', status: 'running', startedAt: 1,
  }
  const events = { output: undefined as ((event: TerminalOutputEvent) => void) | undefined,
    state: undefined as ((event: TerminalStateChange) => void) | undefined }
  const calls: string[] = []
  let snapshotSequence = 3
  const bridge = {
    async snapshot() { return { state, output: 'history', sequence: snapshotSequence } },
    async input(input: { data: string }) { calls.push(`input:${input.data}`) },
    async resize(input: { cols: number; rows: number }) { calls.push(`resize:${input.cols}x${input.rows}`) },
    async close() { calls.push('close'); return true },
    onOutput(listener: (event: TerminalOutputEvent) => void) { events.output = listener; return () => { events.output = undefined } },
    onStateChanged(listener: (event: TerminalStateChange) => void) { events.state = listener; return () => { events.state = undefined } },
  }
  return { port: createZCodeTerminalPort(state, bridge), state, calls, events, setSequence: (value: number) => { snapshotSequence = value } }
}

describe('ZCode 终端 service 端口的 Domi owner 桥接', () => {
  test('Given 属于当前会话的已运行 PTY，When ZCode 组件 create，Then 只检查并 resize，绝不再创建第二个进程', async () => {
    const { port, calls } = fixture()
    expect((await port.create({ cols: 80, rows: 24 })).id).toBe('pty-1')
    expect(calls).toEqual(['resize:80x24'])
  })

  test('Given utility 探测到系统终端样式，When v2 绑定已有 PTY，Then 返回来自 Main 快照的字体字号与配色', async () => {
    const { port, state } = fixture()
    state.appearance = {
      fontFamily: 'Cascadia Code, monospace', fontSize: 15,
      theme: { background: '#112233', foreground: '#ffffff' }, source: 'system',
    }
    const profile = await port.create({ cols: 80, rows: 24 })
    expect(profile).toMatchObject({
      fontFamily: 'Cascadia Code, monospace', fontSize: 15,
      theme: { background: '#112233', foreground: '#ffffff' }, fontFamilySource: 'system',
    })
  })

  test('Given React StrictMode 重放首次挂载，When 尚在启动的组件 dispose 后重挂，Then 不关闭 Main 持有的 PTY', async () => {
    const { port, calls } = fixture()
    await port.dispose({ id: 'pty-1' })
    expect((await port.create({ cols: 80, rows: 24 })).id).toBe('pty-1')
    expect(calls).toEqual(['resize:80x24'])
  })

  test('Given 主进程仍在启动 PTY，When ZCode 组件先挂载，Then 允许绑定 starting 状态而非主动关闭进程', async () => {
    const { port, state, calls } = fixture()
    state.status = 'starting'
    expect((await port.create({ cols: 80, rows: 24 })).id).toBe('pty-1')
    expect(calls).toEqual(['resize:80x24'])
  })

  test('Given 被篡改的 terminalId，When 写入或释放，Then 拒绝访问其他会话 PTY', async () => {
    const { port, calls } = fixture()
    await expect(port.write({ id: 'other', data: 'attack' })).rejects.toThrow('所有权')
    await expect(port.dispose({ id: 'other' })).rejects.toThrow('所有权')
    expect(calls).toEqual([])
  })

  test('Given 快照期间有实时输出，When 重挂载，Then 按 sequence 去重并在 dispose 后停止派送', async () => {
    const { port, events } = fixture()
    const received: string[] = []
    const subscription = port.onDynamicData('pty-1')((text) => received.push(text))
    events.output?.({ terminalId: 'pty-1', sequence: 4, data: 'live' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    events.output?.({ terminalId: 'pty-1', sequence: 3, data: 'duplicate' })
    expect(received).toEqual(['history', 'live'])
    subscription.dispose()
    expect(events.output).toBeUndefined()
  })

  test('Given Main 报告退出，When 来源 owner 不符或已关闭，Then 仅当前 PTY 状态触发 exit 回调', () => {
    const { port, events, state } = fixture()
    const exits: number[] = []
    const subscription = port.onDynamicExit('pty-1')((code) => exits.push(code))
    events.state?.({ ...state, ownerSessionId: 'other', status: 'stopped', exitCode: 2 })
    events.state?.({ ...state, status: 'stopped', exitCode: 7 })
    events.state?.({ ...state, status: 'exited', exitCode: 0 })
    expect(exits).toEqual([7, 0])
    subscription.dispose()
  })
})
