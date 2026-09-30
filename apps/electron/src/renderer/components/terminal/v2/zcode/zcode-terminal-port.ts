// ZCode TerminalSession 的 service 端口。PTY 创建仍必须先经 Main 检查 owner/Target/cwd；
// v2 renderer 只绑定已授权的 terminalId，不接受页面脚本传入 shell 或任意目录。
import type { ITheme, IWindowsPty } from '@xterm/xterm'
import type { TerminalSessionView } from '@domi/shared'

interface Subscription { dispose(): void }

export interface ZCodeTerminalPort {
  create(input: { cols: number; rows: number; cwd?: string }): Promise<{
    id: string
    shell: string
    fontFamily: string
    fontSize?: number
    theme?: ITheme
    fontFamilySource: string
    windowsPty?: IWindowsPty
  }>
  write(input: { id: string; data: string }): Promise<void>
  resize(input: { id: string; cols: number; rows: number }): Promise<void>
  dispose(input: { id: string }): Promise<void>
  onDynamicData(id: string): (listener: (data: string) => void) => Subscription
  onDynamicExit(id: string): (listener: (code: number) => void) => Subscription
}

export function createZCodeTerminalPort(
  terminal: TerminalSessionView,
  bridge: Pick<typeof window.electronAPI.terminal, 'snapshot' | 'input' | 'resize' | 'onOutput' | 'onStateChanged'>,
): ZCodeTerminalPort {
  const ownerSessionId = terminal.ownerSessionId
  const terminalId = terminal.terminalId
  const identity = { ownerSessionId, terminalId }
  let lastSequence = -1
  return {
    async create({ cols, rows }) {
      // 先取授权实例，拒绝过期的 owner 或已关闭会话；不从 renderer 再启动第二个 PTY。
      const snapshot = await bridge.snapshot(identity)
      if (snapshot.state.ownerSessionId !== ownerSessionId || snapshot.state.terminalId !== terminalId || (snapshot.state.status !== 'running' && snapshot.state.status !== 'starting')) {
        throw new Error('终端所属会话已改变或已关闭')
      }
      await bridge.resize({ ...identity, cols, rows })
      return {
        id: terminalId,
        shell: snapshot.state.profile,
        fontFamily: snapshot.state.appearance?.fontFamily ?? '',
        fontSize: snapshot.state.appearance?.fontSize,
        theme: snapshot.state.appearance?.theme,
        fontFamilySource: snapshot.state.appearance?.source ?? 'fallback',
      }
    },
    write: ({ id, data }) => id === terminalId ? bridge.input({ ...identity, data }) : Promise.reject(new Error('终端所有权不匹配')),
    resize: ({ id, cols, rows }) => id === terminalId ? bridge.resize({ ...identity, cols, rows }) : Promise.reject(new Error('终端所有权不匹配')),
    async dispose({ id }) {
      if (id !== terminalId) throw new Error('终端所有权不匹配')
      // 组件的 effect cleanup（包括 React StrictMode 首次重放）不是用户关闭终端。
      // PTY 由 Main 持有，显式关闭入口才调用 terminal.close；此处只释放 xterm 订阅。
    },
    onDynamicData(id) {
      if (id !== terminalId) throw new Error('终端所有权不匹配')
      return (listener) => {
        let active = true
        let replayed = false
        const pending: Array<{ terminalId: string; sequence: number; data: string }> = []
        const receive = (event: { terminalId: string; sequence: number; data: string }): void => {
          if (!active || event.terminalId !== terminalId) return
          if (!replayed) { pending.push(event); return }
          if (event.sequence <= lastSequence) return
          lastSequence = event.sequence
          listener(event.data)
        }
        const unsubscribe = bridge.onOutput(receive)
        void bridge.snapshot(identity).then((snapshot) => {
          if (!active) return
          if (snapshot.state.ownerSessionId !== ownerSessionId || snapshot.state.terminalId !== terminalId) return
          if (snapshot.sequence > lastSequence && snapshot.output) listener(snapshot.output)
          lastSequence = Math.max(lastSequence, snapshot.sequence)
          replayed = true
          for (const event of pending.sort((a, b) => a.sequence - b.sequence)) receive(event)
          pending.length = 0
        }).catch(() => { replayed = true; pending.sort((a, b) => a.sequence - b.sequence).forEach(receive); pending.length = 0 })
        return { dispose: () => { active = false; unsubscribe(); pending.length = 0 } }
      }
    },
    onDynamicExit(id) {
      if (id !== terminalId) throw new Error('终端所有权不匹配')
      return (listener) => {
        const unsubscribe = bridge.onStateChanged((change) => {
          if (change.terminalId !== terminalId || change.ownerSessionId !== ownerSessionId) return
          if ('closed' in change) return
          if (change.status === 'exited' || change.status === 'stopped' || change.status === 'failed') listener(change.exitCode ?? 1)
        })
        return { dispose: unsubscribe }
      }
    },
  }
}
