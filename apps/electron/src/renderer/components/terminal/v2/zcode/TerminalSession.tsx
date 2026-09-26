import * as React from 'react'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm, type ILink } from '@xterm/xterm'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { TerminalSessionView } from '@domi/shared'
import '@xterm/xterm/css/xterm.css'
import { applyBrowserStateChange, browserStateMapAtom } from '@/atoms/browser-atoms.ts'
import { activateSessionRightWorkspaceTab, rightWorkspaceOpenAtom, rightWorkspaceSessionStateMapAtom } from '@/atoms/right-workspace-atoms.ts'
import { browserTabId } from '@/lib/right-workspace-model.ts'
import { getHttpLinksForTerminalBufferLine } from '../terminalLinks.ts'
import { mergeTerminalTheme } from '../terminalTheme.ts'
import { normalizePowerShellReadlineRedraw } from '../terminalDataTransform.ts'
import { createTerminalInputFallbackKeydownCandidate, createPendingTerminalInputFallback, markTerminalInputFallbackHandled, recordTerminalInputFallbackHandledData, recordTerminalInputFallbackRecentData, consumeTerminalInputFallbackHandledData, resolveTerminalInputFallbackAction, type TerminalInputFallbackHandledData } from '../terminalComposedInputFallback.ts'
import { shouldWriteTerminalOutput } from './terminalOutputSequence.ts'

interface TerminalSessionProps {
  terminal: TerminalSessionView
  visible: boolean
  resizing?: boolean
}

/**
 * ZCode TerminalSession 的 xterm/clipboard/IME/resize 交互移植。
 * ZCode 的 terminalService 后端由 Domi 的 ownerSessionId+terminalId PTY IPC 取代；
 * Browser 链接只可交给 Domi Main 安全策略，不能由 xterm 直接导航。
 */
export function TerminalSession({ terminal, visible, resizing = false }: TerminalSessionProps): React.ReactElement {
  const container = React.useRef<HTMLDivElement>(null)
  const xtermRef = React.useRef<XTerm | null>(null)
  const visibleRef = React.useRef(visible)
  const resizingRef = React.useRef(resizing)
  const fitRef = React.useRef<(() => void) | null>(null)
  const setBrowserStates = useSetAtom(browserStateMapAtom)
  const setWorkspaceStates = useSetAtom(rightWorkspaceSessionStateMapAtom)
  const setWorkspaceOpen = useSetAtom(rightWorkspaceOpenAtom)
  visibleRef.current = visible
  resizingRef.current = resizing

  React.useEffect(() => { xtermRef.current?.refresh(0, xtermRef.current.rows - 1); fitRef.current?.() }, [visible, resizing])
  React.useEffect(() => { if (xtermRef.current) xtermRef.current.options.cursorBlink = terminal.status === 'running' }, [terminal.status])

  const openLink = React.useCallback(async (url: string): Promise<void> => {
    try {
      const state = await window.electronAPI.browser.open({ ownerSessionId: terminal.ownerSessionId, url, disposition: 'new-tab' })
      setBrowserStates((current) => applyBrowserStateChange(current, state))
      setWorkspaceStates((current) => activateSessionRightWorkspaceTab(current, terminal.ownerSessionId, browserTabId(state.browserSessionId)))
      setWorkspaceOpen(true)
    } catch (error) {
      toast.error('无法打开终端链接', { description: error instanceof Error ? error.message : '链接不可用' })
    }
  }, [terminal.ownerSessionId, setBrowserStates, setWorkspaceStates, setWorkspaceOpen])

  React.useEffect(() => {
    const element = container.current
    if (!element) return
    const ownerSessionId = terminal.ownerSessionId
    const terminalId = terminal.terminalId
    const xterm = new XTerm({ allowProposedApi: true, cursorBlink: terminal.status === 'running', fontSize: 12, fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace', scrollback: 5000, theme: mergeTerminalTheme(undefined) })
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.loadAddon(new ClipboardAddon())
    xterm.open(element)
    xtermRef.current = xterm
    let disposed = false
    let loaded = false
    let frame = 0
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let resizeInFlight = false
    let pendingSize: { cols: number; rows: number } | null = null
    let lastSize = ''
    const pendingOutput: Array<{ sequence: number; data: string }> = []
    let lastOutputSequence = -1
    const writeOutput = (event: { sequence: number; data: string }): void => {
      if (!shouldWriteTerminalOutput(event.sequence, lastOutputSequence)) return
      lastOutputSequence = event.sequence
      xterm.write(normalizePowerShellReadlineRedraw(event.data, terminal.profile))
    }
    const sendResize = (size: { cols: number; rows: number }): void => {
      const key = `${size.cols}:${size.rows}`
      if (lastSize === key) return
      if (resizeInFlight) { pendingSize = size; return }
      lastSize = key
      resizeInFlight = true
      void window.electronAPI.terminal.resize({ ownerSessionId, terminalId, ...size }).catch(() => {
        // 下次布局变化时重试；不向 PTY 发送无主 terminal 的请求。
        lastSize = ''
      }).finally(() => {
        resizeInFlight = false
        if (pendingSize && !disposed) { const next = pendingSize; pendingSize = null; sendResize(next) }
      })
    }
    const fit = (): void => {
      if (disposed || !visibleRef.current || element.clientWidth === 0 || element.clientHeight === 0) return
      try {
        fitAddon.fit()
        const size = { cols: xterm.cols, rows: xterm.rows }
        if (resizingRef.current) {
          // ZCode resize 策略：拖动时合帧并以 300ms 节流 PTY，松手最终 fit。
          if (!resizeTimer) resizeTimer = setTimeout(() => { resizeTimer = undefined; sendResize(size) }, 300)
        } else {
          if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = undefined }
          sendResize(size)
        }
      } catch { /* 隐藏或刚卸载的终端不发送无效尺寸。 */ }
    }
    const scheduleFit = (): void => { if (frame) cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = 0; fit() }) }
    fitRef.current = scheduleFit
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(element)
    const themeObserver = new MutationObserver(() => { xterm.options.theme = mergeTerminalTheme(undefined) })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const linkProvider = xterm.registerLinkProvider({ provideLinks(line, callback) {
      callback(getHttpLinksForTerminalBufferLine(xterm.buffer.active, line, xterm.cols)?.map((link): ILink => ({ range: link.range, text: link.text, activate: () => { void openLink(link.text) } })) ?? undefined)
    } })
    // ZCode keyboard behavior: shortcut copying only when selection exists;
    // shortcut paste explicitly handles native paste duplicate on Electron/Windows.
    let keydownCandidate: ReturnType<typeof createTerminalInputFallbackKeydownCandidate> = null
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      keydownCandidate = event.metaKey || event.ctrlKey || event.altKey ? null : createTerminalInputFallbackKeydownCandidate({ eventTimeStamp: event.timeStamp, key: event.key, now: performance.now() })
      if (!(event.metaKey || event.ctrlKey)) return true
      const key = event.key.toLowerCase()
      if (key === 'c' && xterm.hasSelection()) { void navigator.clipboard.writeText(xterm.getSelection()); return false }
      if (key === 'v') { event.preventDefault(); void navigator.clipboard.readText().then((text) => { if (text) xterm.paste(text) }); return false }
      return true
    })
    const isWindows = navigator.platform.toLowerCase().includes('win')
    const textarea = isWindows ? xterm.textarea : undefined
    let recentHandled: TerminalInputFallbackHandledData[] = []
    const pendingIme = new Array<ReturnType<typeof createPendingTerminalInputFallback>>()
    const imeTimers = new Set<ReturnType<typeof setTimeout>>()
    const flushInput = (event: Event): void => {
      if (!(event instanceof InputEvent) || !textarea || event.inputType !== 'insertText' || !event.data || !event.composed || disposed) return
      const pending = createPendingTerminalInputFallback(event.data)
      const now = performance.now()
      pendingIme.push(pending)
      consumeTerminalInputFallbackHandledData({ history: recentHandled, inputEventTimeStamp: event.timeStamp, maxAgeMs: 250, maxInputDelayMs: 75, now, pending })
      const timer = setTimeout(() => {
        imeTimers.delete(timer)
        pendingIme.splice(pendingIme.indexOf(pending), 1)
        if (disposed) return
        const action = resolveTerminalInputFallbackAction({ pending, textareaValue: textarea.value })
        if (action.shouldWrite) void window.electronAPI.terminal.input({ ownerSessionId, terminalId, data: pending.text })
        if (action.shouldClearTextarea) textarea.value = ''
      }, 32)
      imeTimers.add(timer)
    }
    textarea?.addEventListener('input', flushInput, true)
    const dataDispose = xterm.onData((data) => {
      if (isWindows) {
        const now = performance.now()
        const handled = recordTerminalInputFallbackHandledData({ candidate: keydownCandidate, data, history: recentHandled, maxAgeMs: 250, now })
        recentHandled = handled.usedCandidate ? handled.history : recordTerminalInputFallbackRecentData({ data, history: handled.history, maxAgeMs: 250, now })
        if (handled.usedCandidate) keydownCandidate = null
        markTerminalInputFallbackHandled(pendingIme, data)
      }
      void window.electronAPI.terminal.input({ ownerSessionId, terminalId, data })
    })
    // ZCode PTY output path mapped to Domi subscribe-before-snapshot sequence handshake.
    const outputDispose = window.electronAPI.terminal.onOutput((event) => {
      if (disposed || event.terminalId !== terminalId) return
      if (!loaded) pendingOutput.push({ sequence: event.sequence, data: event.data })
      else writeOutput(event)
    })
    void window.electronAPI.terminal.snapshot({ ownerSessionId, terminalId }).then((snapshot) => {
      if (disposed) return
      if (snapshot.output) xterm.write(normalizePowerShellReadlineRedraw(snapshot.output, terminal.profile))
      lastOutputSequence = snapshot.sequence
      loaded = true
      for (const event of pendingOutput) writeOutput(event)
      pendingOutput.length = 0
      scheduleFit()
    }).catch((error: unknown) => {
      if (disposed) return
      loaded = true
      for (const event of pendingOutput) writeOutput(event)
      pendingOutput.length = 0
      xterm.writeln(`\r\n[Domi] ${error instanceof Error ? error.message : '终端输出读取失败'}`)
    })
    scheduleFit()
    return () => {
      disposed = true
      fitRef.current = null
      if (frame) cancelAnimationFrame(frame)
      if (resizeTimer) clearTimeout(resizeTimer)
      for (const timer of imeTimers) clearTimeout(timer)
      textarea?.removeEventListener('input', flushInput, true)
      observer.disconnect()
      themeObserver.disconnect()
      outputDispose()
      dataDispose.dispose()
      linkProvider.dispose()
      xterm.dispose()
      xtermRef.current = null
    }
  }, [terminal.ownerSessionId, terminal.terminalId, terminal.profile, openLink])

  return <div ref={container} className="terminal-xterm-shell h-full min-h-0 w-full px-2 py-1" />
}
