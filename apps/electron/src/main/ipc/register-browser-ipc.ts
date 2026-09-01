import {
  BROWSER_IPC_CHANNELS,
  type BrowserActivateInput,
  type BrowserElementSelectionCancelInput,
  type BrowserFitToWidthInput,
  type BrowserInspectInput,
  type BrowserLayoutInput,
  type BrowserNavigateInput,
  type BrowserOpenInput,
  type BrowserPageInput,
  type BrowserZoomInput,
} from '@domi/shared'
import type { BrowserSessionService } from '../lib/browser/browser-session-service.ts'

interface BrowserIpcRegistrar {
  handle: (channel: string, listener: (event: { sender: { id: number } }, input: unknown) => unknown) => void
}

export interface BrowserIpcGuard {
  assertSender: (senderId: number) => void
}

export function registerBrowserIpc(
  ipc: BrowserIpcRegistrar,
  browser: Pick<BrowserSessionService, 'open' | 'activate' | 'inspect' | 'navigate' | 'goBack' | 'goForward' | 'reload' | 'stop' | 'setZoom' | 'setFitToWidth' | 'setLayout' | 'selectElement' | 'cancelElementSelection' | 'close'>,
  guard: BrowserIpcGuard,
): void {
  const register = <T>(channel: string, parse: (input: unknown) => T, run: (input: T) => unknown): void => {
    ipc.handle(channel, async (event, rawInput) => {
      guard.assertSender(event.sender.id)
      return run(parse(rawInput))
    })
  }

  register(BROWSER_IPC_CHANNELS.OPEN, parseOpenInput, (input) => browser.open(input))
  register(BROWSER_IPC_CHANNELS.ACTIVATE, parseActivateInput, (input) => browser.activate(input.ownerSessionId, input.browserSessionId))
  register(BROWSER_IPC_CHANNELS.INSPECT, parseInspectInput, (input) => browser.inspect(input.ownerSessionId, input.browserSessionId))
  register(BROWSER_IPC_CHANNELS.NAVIGATE, parseNavigateInput, (input) => browser.navigate(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.GO_BACK, parsePageInput, (input) => browser.goBack(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.GO_FORWARD, parsePageInput, (input) => browser.goForward(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.RELOAD, parsePageInput, (input) => browser.reload(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.STOP, parsePageInput, (input) => browser.stop(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.SET_ZOOM, parseZoomInput, (input) => browser.setZoom(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.SET_FIT_TO_WIDTH, parseFitToWidthInput, (input) => browser.setFitToWidth(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.SET_LAYOUT, parseLayoutInput, (input) => browser.setLayout(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.SELECT_ELEMENT, parsePageInput, (input) => browser.selectElement(input.ownerSessionId, input))
  register(BROWSER_IPC_CHANNELS.CANCEL_ELEMENT_SELECTION, parseElementSelectionCancelInput, (input) => browser.cancelElementSelection(input.ownerSessionId, input.browserSessionId, input.reason))
  register(BROWSER_IPC_CHANNELS.CLOSE, parseInspectInput, (input) => browser.close(input.ownerSessionId, input.browserSessionId))
}

function parseOpenInput(input: unknown): BrowserOpenInput {
  const value = requireRecord(input, ['ownerSessionId', 'url', 'disposition'], ['ownerSessionId'])
  const disposition = value.disposition
  if (disposition !== undefined && disposition !== 'reuse-active' && disposition !== 'new-tab') invalid()
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    ...(value.url === undefined ? {} : { url: requireUrl(value.url) }),
    ...(disposition === undefined ? {} : { disposition }),
  }
}

function parseActivateInput(input: unknown): BrowserActivateInput {
  return parseInspectInput(input)
}

function parseInspectInput(input: unknown): BrowserInspectInput {
  const value = requireRecord(input, ['ownerSessionId', 'browserSessionId'])
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    browserSessionId: requireId(value.browserSessionId),
  }
}

function parseElementSelectionCancelInput(input: unknown): BrowserElementSelectionCancelInput {
  const value = requireRecord(input, ['ownerSessionId', 'browserSessionId', 'reason'])
  if (value.reason !== 'toolbar' && value.reason !== 'session-switch') {
    throw new Error('网页元素选择取消原因无效。')
  }
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    browserSessionId: requireId(value.browserSessionId),
    reason: value.reason,
  }
}

function parsePageInput(input: unknown): BrowserPageInput {
  const value = requireRecord(input, ['ownerSessionId', 'browserSessionId', 'pageId'])
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    browserSessionId: requireId(value.browserSessionId),
    pageId: requireId(value.pageId),
  }
}

function parseNavigateInput(input: unknown): BrowserNavigateInput {
  const value = requireRecord(input, ['ownerSessionId', 'browserSessionId', 'pageId', 'url'])
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    browserSessionId: requireId(value.browserSessionId),
    pageId: requireId(value.pageId),
    url: requireUrl(value.url),
  }
}

function parseZoomInput(input: unknown): BrowserZoomInput {
  const value = requireRecord(input, ['ownerSessionId', 'browserSessionId', 'pageId', 'action'])
  if (value.action !== 'decrease' && value.action !== 'increase' && value.action !== 'reset') invalid()
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    browserSessionId: requireId(value.browserSessionId),
    pageId: requireId(value.pageId),
    action: value.action,
  }
}

function parseFitToWidthInput(input: unknown): BrowserFitToWidthInput {
  const value = requireRecord(input, ['ownerSessionId', 'browserSessionId', 'pageId', 'enabled'])
  if (typeof value.enabled !== 'boolean') invalid()
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    browserSessionId: requireId(value.browserSessionId),
    pageId: requireId(value.pageId),
    enabled: value.enabled,
  }
}

function parseLayoutInput(input: unknown): BrowserLayoutInput {
  const value = requireRecord(input, ['ownerSessionId', 'browserSessionId', 'pageId', 'revision', 'visible', 'bounds'])
  if (!Number.isSafeInteger(value.revision) || typeof value.visible !== 'boolean') invalid()
  const bounds = requireRecord(value.bounds, ['x', 'y', 'width', 'height'])
  const coordinates = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (coordinates.some((number) => typeof number !== 'number' || !Number.isFinite(number))) invalid()
  if ((bounds.width as number) < 0 || (bounds.height as number) < 0 || (bounds.width as number) > 100_000 || (bounds.height as number) > 100_000) invalid()
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    browserSessionId: requireId(value.browserSessionId),
    pageId: requireId(value.pageId),
    revision: value.revision as number,
    visible: value.visible,
    bounds: {
      x: Math.round(bounds.x as number),
      y: Math.round(bounds.y as number),
      width: Math.round(bounds.width as number),
      height: Math.round(bounds.height as number),
    },
  }
}

function requireRecord(input: unknown, allowedKeys: string[], requiredKeys = allowedKeys): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  const value = input as Record<string, unknown>
  const keys = Object.keys(value)
  if (keys.some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !(key in value))) invalid()
  return value
}

function requireId(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 200 || /[\0\r\n]/.test(input)) invalid()
  return input
}

function requireUrl(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length < 1 || input.length > 4096 || input.includes('\0')) invalid()
  return input
}

function invalid(): never {
  throw new Error('浏览器 IPC 请求无效。')
}
