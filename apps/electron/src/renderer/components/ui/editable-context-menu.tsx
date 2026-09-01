import * as React from 'react'
import {
  ClipboardPaste,
  ClipboardType,
  Copy,
  Redo2,
  Scissors,
  TextSelect,
  Trash2,
  Undo2,
} from 'lucide-react'
import type {
  EditableContextMenuAction,
  EditableContextMenuRequest,
} from '../../../types/editable-context-menu'
import {
  closeEditableContextMenuSession,
  createEditableContextMenuItems,
  createEditableContextMenuSession,
  getEditableContextMenuPlatform,
  resolveEditableContextMenuPlacement,
  resolveEditableContextMenuRequest,
  resolveEditableContextMenuTarget,
  type EditableContextMenuPlacement,
  type EditableContextMenuPoint,
  type EditableContextMenuSession,
} from '../../lib/editable-context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './dropdown-menu'

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement

type EditableSelectionSnapshot =
  | {
      kind: 'text-control'
      start: number | null
      end: number | null
      direction: 'forward' | 'backward' | 'none' | null
    }
  | {
      kind: 'contenteditable'
      range: Range | null
    }

const ESTIMATED_MENU_WIDTH = 240
const ESTIMATED_MENU_HEIGHT = 300

const TEXT_INPUT_TYPES = new Set([
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
])

function findEditableElement(target: EventTarget | null): EditableElement | null {
  if (!(target instanceof Element)) return null

  const candidate = target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')
  if (!(candidate instanceof HTMLElement)) return null

  if (candidate instanceof HTMLInputElement) {
    if (candidate.disabled || candidate.readOnly || !TEXT_INPUT_TYPES.has(candidate.type)) return null
    return candidate
  }

  if (candidate instanceof HTMLTextAreaElement) {
    return candidate.disabled || candidate.readOnly ? null : candidate
  }

  return candidate.isContentEditable ? candidate : null
}

function findEditableElementAtPoint(x: number, y: number): EditableElement | null {
  return findEditableElement(document.elementFromPoint(x, y))
}

function captureEditableSelection(target: EditableElement): EditableSelectionSnapshot {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return {
      kind: 'text-control',
      start: target.selectionStart,
      end: target.selectionEnd,
      direction: target.selectionDirection,
    }
  }

  const selection = window.getSelection()
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const commonAncestor = range?.commonAncestorContainer
  return {
    kind: 'contenteditable',
    range: commonAncestor && target.contains(
      commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement,
    )
      ? range?.cloneRange() ?? null
      : null,
  }
}

function restoreEditableSelection(
  target: EditableElement,
  snapshot: EditableSelectionSnapshot,
): void {
  target.focus({ preventScroll: true })

  if (
    snapshot.kind === 'text-control'
    && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  ) {
    if (snapshot.start !== null && snapshot.end !== null) {
      target.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction ?? undefined)
    }
    return
  }

  if (snapshot.kind === 'contenteditable' && snapshot.range) {
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(snapshot.range)
  }
}

function ActionIcon({ action }: { action: EditableContextMenuAction }): React.ReactElement {
  const className = 'size-3.5 shrink-0 text-muted-foreground'

  switch (action) {
    case 'undo':
      return <Undo2 className={className} />
    case 'redo':
      return <Redo2 className={className} />
    case 'cut':
      return <Scissors className={className} />
    case 'copy':
      return <Copy className={className} />
    case 'paste':
      return <ClipboardPaste className={className} />
    case 'pasteAsPlainText':
      return <ClipboardType className={className} />
    case 'delete':
      return <Trash2 className={className} />
    case 'selectAll':
      return <TextSelect className={className} />
  }
}

/** 全窗口共用的 Domi 风格可编辑区域右键菜单。 */
export function EditableContextMenu(): React.ReactElement {
  const capturedTargetRef = React.useRef<EditableElement | null>(null)
  const capturedSelectionRef = React.useRef<EditableSelectionSnapshot | null>(null)
  const capturedPointRef = React.useRef<EditableContextMenuPoint | null>(null)
  const targetRef = React.useRef<EditableElement | null>(null)
  const selectionRef = React.useRef<EditableSelectionSnapshot | null>(null)
  const nextSessionIdRef = React.useRef(0)
  const [menuSession, setMenuSession] = React.useState<EditableContextMenuSession | null>(null)
  const request = menuSession?.request ?? null
  const [placement, setPlacement] = React.useState<EditableContextMenuPlacement>({
    horizontal: 'right',
    vertical: 'up',
  })
  const platform = React.useMemo(
    () => getEditableContextMenuPlatform(navigator.userAgent),
    [],
  )

  React.useEffect(() => {
    let pendingOpenTimer: number | null = null

    const captureContextMenuTarget = (event: MouseEvent): void => {
      const target = findEditableElement(event.target)
      capturedTargetRef.current = target
      capturedSelectionRef.current = target ? captureEditableSelection(target) : null
      capturedPointRef.current = target ? { x: event.clientX, y: event.clientY } : null
    }

    // DOM 事件同时提供精确编辑节点与 viewport 坐标，不能等 Main IPC 返回后
    // 再依赖 Electron 坐标；Windows 内容偏移、DPI 或页面缩放会让锚点产生偏差。
    document.addEventListener('contextmenu', captureContextMenuTarget, true)

    const unsubscribe = window.electronAPI.onEditableContextMenu((nextRequest) => {
      const capturedTarget = capturedTargetRef.current
      const capturedSelection = capturedSelectionRef.current
      const capturedPoint = capturedPointRef.current
      capturedTargetRef.current = null
      capturedSelectionRef.current = null
      capturedPointRef.current = null

      const target = resolveEditableContextMenuTarget(
        capturedTarget,
        () => findEditableElementAtPoint(nextRequest.x, nextRequest.y),
      )
      if (!target) return

      targetRef.current = target
      selectionRef.current = target === capturedTarget && capturedSelection
        ? capturedSelection
        : captureEditableSelection(target)
      const positionedRequest = resolveEditableContextMenuRequest(nextRequest, capturedPoint)
      if (pendingOpenTimer !== null) window.clearTimeout(pendingOpenTimer)
      // 等原始右键 pointer 事件完成后再打开 Dropdown，避免被同一事件判定为 outside click。
      pendingOpenTimer = window.setTimeout(() => {
        pendingOpenTimer = null
        setPlacement(resolveEditableContextMenuPlacement({
          x: positionedRequest.x,
          y: positionedRequest.y,
          menuWidth: ESTIMATED_MENU_WIDTH,
          menuHeight: ESTIMATED_MENU_HEIGHT,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }))
        nextSessionIdRef.current += 1
        setMenuSession(createEditableContextMenuSession(nextSessionIdRef.current, positionedRequest))
      }, 0)
    })

    return () => {
      document.removeEventListener('contextmenu', captureContextMenuTarget, true)
      unsubscribe()
      if (pendingOpenTimer !== null) window.clearTimeout(pendingOpenTimer)
    }
  }, [])

  const measureMenuPanel = React.useCallback((node: HTMLDivElement | null): void => {
    if (!node || !request) return
    const rect = node.getBoundingClientRect()
    const nextPlacement = resolveEditableContextMenuPlacement({
      x: request.x,
      y: request.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
    setPlacement((current) => (
      current.horizontal === nextPlacement.horizontal
      && current.vertical === nextPlacement.vertical
        ? current
        : nextPlacement
    ))
  }, [request])

  const setMenuAnchor = React.useCallback((node: HTMLSpanElement | null): void => {
    if (!node || !request) return
    node.style.left = `${request.x}px`
    node.style.top = `${request.y}px`
  }, [request])

  const handleAction = React.useCallback((action: EditableContextMenuAction): void => {
    const target = targetRef.current
    const selection = selectionRef.current
    if (!target || !selection || !document.contains(target)) return

    restoreEditableSelection(target, selection)
    window.electronAPI.executeEditableContextMenuAction(action)
  }, [])

  const items = request ? createEditableContextMenuItems(request, platform) : []

  if (!menuSession) return <></>

  return (
    <DropdownMenu
      key={menuSession.id}
      modal={false}
      open
      onOpenChange={(open) => {
        if (open) return
        setMenuSession((current) => closeEditableContextMenuSession(current, menuSession.id))
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          ref={setMenuAnchor}
          aria-hidden="true"
          className="pointer-events-none fixed size-0 opacity-0"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={measureMenuPanel}
        side={placement.vertical === 'up' ? 'top' : 'bottom'}
        align={placement.horizontal === 'right' ? 'start' : 'end'}
        sideOffset={0}
        alignOffset={0}
        avoidCollisions={false}
        data-editable-context-menu-panel=""
        data-horizontal={placement.horizontal}
        data-vertical={placement.vertical}
        data-request-x={request?.x}
        data-request-y={request?.y}
        className="z-[300] min-w-[13.5rem] rounded-lg border-border/80 p-1.5 shadow-xl"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {items.map((item, index) => {
          if (item.type === 'separator') {
            return <DropdownMenuSeparator key={`separator-${index}`} className="my-1.5" />
          }

          return (
            <DropdownMenuItem
              key={item.action}
              disabled={!item.enabled}
              className="gap-2.5 rounded-md px-2 py-1.5"
              onSelect={() => handleAction(item.action)}
            >
              <ActionIcon action={item.action} />
              <span>{item.label}</span>
              <DropdownMenuShortcut className="pl-5 tracking-normal tabular-nums">
                {item.shortcut}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
