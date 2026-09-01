import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSessionView } from '@domi/shared'

export function TerminalPane({ terminal }: { terminal: TerminalSessionView }): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const terminalRef = React.useRef<Terminal | null>(null)

  React.useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.cursorBlink = terminal.status === 'running'
  }, [terminal.status])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const xterm = new Terminal({
      convertEol: true,
      cursorBlink: terminal.status === 'running',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: '#111318',
        foreground: '#d8dee9',
        cursor: '#f7c873',
        selectionBackground: '#334155',
      },
    })
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(container)
    terminalRef.current = xterm
    let disposed = false
    let lastCols = 0
    let lastRows = 0

    const fit = (): void => {
      if (disposed || !container.isConnected) return
      try {
        fitAddon.fit()
        if (xterm.cols === lastCols && xterm.rows === lastRows) return
        lastCols = xterm.cols
        lastRows = xterm.rows
        void window.electronAPI.terminal.resize({
          ownerSessionId: terminal.ownerSessionId,
          terminalId: terminal.terminalId,
          cols: xterm.cols,
          rows: xterm.rows,
        })
      } catch {
        // Dock 动画或隐藏瞬间可能没有可测尺寸；下一次 ResizeObserver 会重试。
      }
    }

    let snapshotLoaded = false
    const pendingOutput: Array<{ sequence: number; data: string }> = []
    const outputDispose = window.electronAPI.terminal.onOutput((event) => {
      if (event.terminalId !== terminal.terminalId) return
      if (!snapshotLoaded) pendingOutput.push({ sequence: event.sequence, data: event.data })
      else xterm.write(event.data)
    })
    const dataDispose = xterm.onData((data) => {
      void window.electronAPI.terminal.input({
        ownerSessionId: terminal.ownerSessionId,
        terminalId: terminal.terminalId,
        data,
      })
    })
    const observer = new ResizeObserver(fit)
    observer.observe(container)

    void window.electronAPI.terminal.snapshot({
      ownerSessionId: terminal.ownerSessionId,
      terminalId: terminal.terminalId,
    }).then((snapshot) => {
      if (disposed) return
      if (snapshot.output) xterm.write(snapshot.output)
      snapshotLoaded = true
      for (const event of pendingOutput) {
        if (event.sequence > snapshot.sequence) xterm.write(event.data)
      }
      pendingOutput.length = 0
      requestAnimationFrame(fit)
      xterm.focus()
    }).catch((error: unknown) => {
      snapshotLoaded = true
      for (const event of pendingOutput) xterm.write(event.data)
      pendingOutput.length = 0
      if (!disposed) xterm.writeln(`\r\n[Domi] ${describeError(error)}`)
    })

    return () => {
      disposed = true
      observer.disconnect()
      outputDispose()
      dataDispose.dispose()
      xterm.dispose()
      terminalRef.current = null
    }
  }, [terminal.ownerSessionId, terminal.terminalId])

  return <div ref={containerRef} className="h-full min-h-0 w-full bg-[#111318] px-2 py-1" />
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '终端输出读取失败'
}
