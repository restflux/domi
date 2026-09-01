import { containsObviousSecret } from '../security/sensitive-data.ts'

export const BROWSER_TYPE_MAX_CHARS = 16_384
export const BROWSER_EXTRACT_DEFAULT_MAX_CHARS = 8_000
export const BROWSER_EXTRACT_MAX_CHARS = 24_000

export type BrowserScrollDirection = 'up' | 'down' | 'left' | 'right'
export type BrowserScrollDistance = 'small' | 'medium' | 'large'

export interface BrowserOperationTarget {
  ref: string
  pageId: string
  navigationEpoch: number
  backendDOMNodeId: number
  role?: string
  name?: string
  disabled?: boolean
  readonly?: boolean
  password?: boolean
  multiline?: boolean
}

const CLICKABLE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
])

const EDITABLE_ROLES = new Set(['searchbox', 'textbox'])

export function assertBrowserClickTarget(target: BrowserOperationTarget): void {
  const role = target.role?.toLowerCase() ?? ''
  if (target.disabled || !CLICKABLE_ROLES.has(role)) {
    throw new Error('该浏览器元素不可点击，请重新生成 Snapshot 并选择可交互元素。')
  }
}

export function assertBrowserTypeInput(
  target: BrowserOperationTarget,
  text: string,
): { text: string; textLength: number } {
  const role = target.role?.toLowerCase() ?? ''
  if (target.password) throw new Error('BrowserType 不允许向密码输入框写入内容。')
  if (target.disabled) throw new Error('该浏览器输入控件已禁用。')
  if (target.readonly) throw new Error('该浏览器输入控件为只读。')
  if (!EDITABLE_ROLES.has(role)) throw new Error('该浏览器元素不可输入文本。')
  if (text.includes('\0') || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new Error('BrowserType 文本包含不支持的控制字符。')
  }
  if (text.length > BROWSER_TYPE_MAX_CHARS) {
    throw new Error(`BrowserType 文本过长，最多允许 ${BROWSER_TYPE_MAX_CHARS} 个字符。`)
  }
  if (containsObviousSecret(text, { includeAssignments: true })) {
    throw new Error('BrowserType 检测到明显敏感凭据，已拒绝写入网页。')
  }
  return { text, textLength: text.length }
}

export function resolveBrowserScrollDelta(
  direction: BrowserScrollDirection,
  distance: BrowserScrollDistance,
  viewport: { width: number; height: number },
): { deltaX: number; deltaY: number } {
  const width = normalizeViewportDimension(viewport.width)
  const height = normalizeViewportDimension(viewport.height)
  const ratio = distance === 'small' ? 0.3 : distance === 'medium' ? 0.5 : 0.9
  const horizontal = Math.max(120, Math.round(width * ratio))
  const vertical = Math.max(120, Math.round(height * ratio))
  if (direction === 'up') return { deltaX: 0, deltaY: -vertical }
  if (direction === 'down') return { deltaX: 0, deltaY: vertical }
  if (direction === 'left') return { deltaX: -horizontal, deltaY: 0 }
  return { deltaX: horizontal, deltaY: 0 }
}

export function resolveBrowserExtractMaxChars(requested?: number): number {
  if (requested === undefined) return BROWSER_EXTRACT_DEFAULT_MAX_CHARS
  if (!Number.isFinite(requested)) throw new Error('BrowserExtract maxChars 必须是有限数字。')
  return Math.max(1, Math.min(BROWSER_EXTRACT_MAX_CHARS, Math.floor(requested)))
}

export function normalizeBrowserExtractText(
  raw: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const boundedMaxChars = resolveBrowserExtractMaxChars(maxChars)
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return normalized.length > boundedMaxChars
    ? { text: normalized.slice(0, boundedMaxChars), truncated: true }
    : { text: normalized, truncated: false }
}

function normalizeViewportDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 800
}
