import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { BrowserPageInput, BrowserSessionView, BrowserStateChange } from '@domi/shared'
import { browserStateMapAtom, applyBrowserStateChange } from '@/atoms/browser-atoms'
import { quotedSelectionMapAtom } from '@/atoms/preview-atoms'
import { createBrowserQuotedSelection } from '@/lib/browser-element-reference'
import { BrowserAddressBar } from './BrowserAddressBar'
import { Bot, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrowserSlot } from './BrowserSlot'

interface BrowserPanelProps {
  ownerSessionId: string
  browserSessionId: string
}

export function BrowserPanel({ ownerSessionId, browserSessionId }: BrowserPanelProps): React.ReactElement {
  const stateMap = useAtomValue(browserStateMapAtom)
  const setStateMap = useSetAtom(browserStateMapAtom)
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const projectedState = stateMap.get(browserSessionId) ?? null
  const [state, setState] = React.useState<BrowserSessionView | null>(projectedState)
  const [busy, setBusy] = React.useState(true)
  const [selectingElement, setSelectingElement] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const selectionAttemptRef = React.useRef(0)

  const acceptState = React.useCallback((change: BrowserStateChange) => {
    if (change.ownerSessionId !== ownerSessionId || change.browserSessionId !== browserSessionId) return
    setStateMap((current) => applyBrowserStateChange(current, change))
    if ('closed' in change) setState(null)
    else setState(change)
  }, [browserSessionId, ownerSessionId, setStateMap])

  React.useEffect(() => {
    setState(projectedState)
  }, [browserSessionId, projectedState])

  React.useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    window.electronAPI.browser.activate({ ownerSessionId, browserSessionId })
      .then((next) => { if (!cancelled) acceptState(next) })
      .catch((reason) => { if (!cancelled) setError(describeError(reason)) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [acceptState, browserSessionId, ownerSessionId])

  React.useEffect(() => {
    return () => {
      selectionAttemptRef.current += 1
      void window.electronAPI.browser.cancelElementSelection({ ownerSessionId, browserSessionId, reason: 'session-switch' })
        .catch(() => undefined)
    }
  }, [browserSessionId, ownerSessionId])

  const pageInput = React.useCallback((): BrowserPageInput | null => {
    if (!state?.page) return null
    return {
      ownerSessionId,
      browserSessionId: state.browserSessionId,
      pageId: state.page.pageId,
    }
  }, [ownerSessionId, state])

  const run = React.useCallback(async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (reason) {
      setError(describeError(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleToggleElementSelection = React.useCallback((): void => {
    const page = pageInput()
    if (!page) return
    if (selectingElement) {
      void window.electronAPI.browser.cancelElementSelection({
        ownerSessionId,
        browserSessionId: page.browserSessionId,
        reason: 'toolbar',
      }).catch((reason) => setError(describeError(reason)))
      return
    }

    const attempt = ++selectionAttemptRef.current
    setSelectingElement(true)
    setError(null)
    void window.electronAPI.browser.selectElement(page)
      .then((result) => {
        if (selectionAttemptRef.current !== attempt || result.status !== 'selected') return
        const element = result.element
        setQuotedSelectionMap((current) => {
          const next = new Map(current)
          next.set(ownerSessionId, createBrowserQuotedSelection(element))
          return next
        })
      })
      .catch((reason) => {
        if (selectionAttemptRef.current === attempt) setError(describeError(reason))
      })
      .finally(() => {
        if (selectionAttemptRef.current === attempt) setSelectingElement(false)
      })
  }, [ownerSessionId, pageInput, selectingElement, setQuotedSelectionMap])

  const control = state?.control ?? null
  const page = state?.page ?? null

  return (
    <section className="flex h-full min-w-0 flex-col bg-background" aria-label="内置浏览器">
      <BrowserAddressBar
        url={page?.url ?? ''}
        loading={page?.loadState === 'loading'}
        canGoBack={page?.canGoBack ?? false}
        canGoForward={page?.canGoForward ?? false}
        zoomPercent={page?.zoomPercent ?? 100}
        fitToWidth={page?.fitToWidth ?? false}
        selectingElement={selectingElement}
        disabled={busy || Boolean(control)}
        onNavigate={(url) => {
          const input = pageInput()
          if (!input) return
          void run(async () => acceptState(await window.electronAPI.browser.navigate({ ...input, url })))
        }}
        onBack={() => { const input = pageInput(); if (input) void run(() => window.electronAPI.browser.goBack(input)) }}
        onForward={() => { const input = pageInput(); if (input) void run(() => window.electronAPI.browser.goForward(input)) }}
        onReload={() => { const input = pageInput(); if (input) void run(() => window.electronAPI.browser.reload(input)) }}
        onStop={() => { const input = pageInput(); if (input) void run(() => window.electronAPI.browser.stop(input)) }}
        onZoom={(action) => {
          const input = pageInput()
          if (!input) return
          void run(async () => acceptState(await window.electronAPI.browser.setZoom({ ...input, action })))
        }}
        onToggleFit={() => {
          const input = pageInput()
          if (!input || !page) return
          void run(async () => acceptState(await window.electronAPI.browser.setFitToWidth({ ...input, enabled: !page.fitToWidth })))
        }}
        onToggleElementSelection={handleToggleElementSelection}
        onOpenExternal={() => { if (page?.url) window.electronAPI.openExternal(page.url) }}
      />
      {control && (
        <div className="flex h-9 shrink-0 items-center gap-2 bg-primary/8 px-3 text-xs text-foreground shadow-sm">
          <Bot className="size-3.5 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            {control.displayName}{control.intent ? ` · ${control.intent}` : ' 正在操作浏览器'}
          </span>
          {control.stoppable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => { void window.electronAPI.stopAgent(ownerSessionId, 'renderer-stop-control') }}
            >
              <Square className="size-3 fill-current" />
              停止
            </Button>
          )}
        </div>
      )}
      {error && (
        <div className="flex-shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
      {state?.sourceTarget?.stale && (
        <div className="flex-shrink-0 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          当前页面来自上一轮 Session Target；请确认本地服务仍对应当前代码。
        </div>
      )}
      {state ? (
        <BrowserSlot state={state} />
      ) : (
        <div className="flex flex-1 items-center justify-center bg-muted/15 text-xs text-muted-foreground">
          {busy ? '正在启动内置浏览器…' : '内置浏览器暂不可用'}
        </div>
      )}
    </section>
  )
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '内置浏览器操作失败。'
}
