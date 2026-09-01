export const BROWSER_ELEMENT_SELECTION_WORLD_ID = 1004
export const BROWSER_ELEMENT_SELECTION_MAX_TEXT = 2_000
export const BROWSER_ELEMENT_SELECTION_MAX_NAME = 300
export const BROWSER_ELEMENT_SELECTION_MAX_ROLE = 100
export const BROWSER_ELEMENT_SELECTION_MAX_TAG = 40
export const BROWSER_ELEMENT_SELECTION_MAX_HREF = 2_048

export type BrowserElementSelectionCancelReason =
  | 'escape'
  | 'toolbar'
  | 'navigation'
  | 'close'
  | 'session-switch'
  | 'control'
  | 'replaced'
  | 'error'

export interface BrowserElementSelectionElement {
  tagName: string
  role?: string
  name?: string
  text: string
  href?: string
  truncated: boolean
}

export type BrowserElementSelectionCandidate =
  | { status: 'selected'; element: BrowserElementSelectionElement }
  | { status: 'cancelled'; reason: BrowserElementSelectionCancelReason }

const CANCEL_REASONS = new Set<BrowserElementSelectionCancelReason>([
  'escape',
  'toolbar',
  'navigation',
  'close',
  'session-switch',
  'control',
  'replaced',
  'error',
])

const FORM_VALUE_TAGS = new Set(['input', 'textarea', 'select'])
const PICKER_STATE_KEY = '__DOMI_BROWSER_ELEMENT_SELECTION__'

export const BROWSER_ELEMENT_SELECTION_SCRIPT = String.raw`(() => {
  const stateKey = '${PICKER_STATE_KEY}';
  const previous = globalThis[stateKey];
  if (previous && typeof previous.cancel === 'function') previous.cancel('replaced');

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-domi-browser-element-selection', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2147483647',
      pointerEvents: 'none',
      display: 'none',
      border: '2px solid rgb(59, 130, 246)',
      borderRadius: '6px',
      background: 'rgba(59, 130, 246, 0.10)',
      boxSizing: 'border-box',
      transition: 'left 50ms linear, top 50ms linear, width 50ms linear, height 50ms linear',
    });

    const badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'absolute',
      left: '0',
      top: '-24px',
      maxWidth: '320px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      padding: '3px 7px',
      borderRadius: '5px',
      background: 'rgb(37, 99, 235)',
      color: 'white',
      font: '12px/16px system-ui, sans-serif',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
    });
    overlay.appendChild(badge);
    (document.documentElement || document.body).appendChild(overlay);

    let current = null;
    let finished = false;

    const normalizeText = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const tagNameOf = (element) => String(element && element.tagName || '').toLowerCase();
    const isOverlay = (element) => element === overlay || overlay.contains(element);
    const isIframe = (element) => tagNameOf(element) === 'iframe';
    const isFormValueElement = (element) => {
      const tag = tagNameOf(element);
      return tag === 'input' || tag === 'textarea' || tag === 'select';
    };
    const resolveRole = (element) => {
      const explicit = normalizeText(element.getAttribute && element.getAttribute('role'), 100);
      if (explicit) return explicit;
      const tag = tagNameOf(element);
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'input') {
        const inputType = String(element.getAttribute('type') || 'text').toLowerCase();
        if (inputType === 'checkbox') return 'checkbox';
        if (inputType === 'radio') return 'radio';
        if (inputType === 'button' || inputType === 'submit' || inputType === 'reset') return 'button';
        if (inputType === 'range') return 'slider';
        return 'textbox';
      }
      return '';
    };
    const resolveName = (element) => {
      const ariaLabel = normalizeText(element.getAttribute && element.getAttribute('aria-label'), 300);
      if (ariaLabel) return ariaLabel;
      const labelledBy = normalizeText(element.getAttribute && element.getAttribute('aria-labelledby'), 500);
      if (labelledBy) {
        const labelledText = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => node.textContent)
          .join(' ');
        const normalized = normalizeText(labelledText, 300);
        if (normalized) return normalized;
      }
      if (element.labels && typeof element.labels.length === 'number') {
        const labelText = Array.from(element.labels).map((label) => label.textContent).join(' ');
        const normalized = normalizeText(labelText, 300);
        if (normalized) return normalized;
      }
      const alt = normalizeText(element.getAttribute && element.getAttribute('alt'), 300);
      if (alt) return alt;
      const title = normalizeText(element.getAttribute && element.getAttribute('title'), 300);
      if (title) return title;
      if (!isFormValueElement(element)) return normalizeText(element.innerText || element.textContent, 300);
      return '';
    };
    const resolveHref = (element) => {
      let currentElement = element;
      while (currentElement) {
        if (tagNameOf(currentElement) === 'a' && currentElement.hasAttribute('href')) {
          try {
            return new URL(currentElement.getAttribute('href'), document.baseURI).href;
          } catch {
            return '';
          }
        }
        currentElement = currentElement.parentElement;
      }
      return '';
    };
    const describe = (element) => {
      const tagName = tagNameOf(element);
      const role = resolveRole(element);
      const name = resolveName(element);
      const rawText = isFormValueElement(element) ? '' : normalizeText(element.innerText || element.textContent, 5000);
      return {
        tagName,
        inputType: tagName === 'input' ? String(element.getAttribute('type') || 'text').toLowerCase() : '',
        role,
        name,
        text: rawText,
        href: resolveHref(element),
      };
    };
    const updateOverlay = (element) => {
      if (!element || isOverlay(element)) return;
      current = element;
      const rect = element.getBoundingClientRect();
      const forbidden = isIframe(element);
      overlay.style.display = rect.width > 0 && rect.height > 0 ? 'block' : 'none';
      overlay.style.left = Math.max(0, rect.left) + 'px';
      overlay.style.top = Math.max(0, rect.top) + 'px';
      overlay.style.width = Math.max(0, rect.width) + 'px';
      overlay.style.height = Math.max(0, rect.height) + 'px';
      overlay.style.borderColor = forbidden ? 'rgb(239, 68, 68)' : 'rgb(59, 130, 246)';
      overlay.style.background = forbidden ? 'rgba(239, 68, 68, 0.10)' : 'rgba(59, 130, 246, 0.10)';
      badge.style.background = forbidden ? 'rgb(220, 38, 38)' : 'rgb(37, 99, 235)';
      const description = describe(element);
      badge.textContent = forbidden
        ? 'iframe 不可选择'
        : [description.role || description.tagName, description.name].filter(Boolean).join(' · ');
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange, true);
      overlay.remove();
      if (globalThis[stateKey] === state) delete globalThis[stateKey];
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const onPointerMove = (event) => updateOverlay(event.target);
    const onViewportChange = () => {
      if (current) updateOverlay(current);
    };
    const onClick = (event) => {
      const element = event.target;
      if (!element || isOverlay(element)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (isIframe(element)) return;
      finish({ status: 'selected', element: describe(element) });
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      finish({ status: 'cancelled', reason: 'escape' });
    };
    const state = { cancel: (reason) => finish({ status: 'cancelled', reason }) };
    globalThis[stateKey] = state;
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange, true);
  });
})()`

export function buildBrowserElementSelectionCancelScript(reason: BrowserElementSelectionCancelReason): string {
  if (!CANCEL_REASONS.has(reason)) throw new Error('网页元素选择取消原因无效。')
  return `(() => { const state = globalThis.${PICKER_STATE_KEY}; if (!state || typeof state.cancel !== 'function') return false; state.cancel(${JSON.stringify(reason)}); return true; })()`
}

export function normalizeBrowserElementSelectionCandidate(value: unknown): BrowserElementSelectionCandidate {
  const record = requireRecord(value)
  if (record.status === 'cancelled') {
    if (typeof record.reason !== 'string' || !CANCEL_REASONS.has(record.reason as BrowserElementSelectionCancelReason)) {
      throw new Error('网页元素选择取消结果无效。')
    }
    return { status: 'cancelled', reason: record.reason as BrowserElementSelectionCancelReason }
  }
  if (record.status !== 'selected') throw new Error('网页元素选择结果无效。')

  const element = requireRecord(record.element)
  const tagName = normalizeRequiredString(element.tagName, BROWSER_ELEMENT_SELECTION_MAX_TAG).toLowerCase()
  const textSource = FORM_VALUE_TAGS.has(tagName) ? '' : normalizeWhitespace(element.text)
  const text = textSource.slice(0, BROWSER_ELEMENT_SELECTION_MAX_TEXT)
  const role = normalizeOptionalString(element.role, BROWSER_ELEMENT_SELECTION_MAX_ROLE)
  const name = normalizeOptionalString(element.name, BROWSER_ELEMENT_SELECTION_MAX_NAME)
  const href = normalizeSafeHref(element.href)

  return {
    status: 'selected',
    element: {
      tagName,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      text,
      ...(href ? { href } : {}),
      truncated: textSource.length > text.length,
    },
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('网页元素选择结果无效。')
  return value as Record<string, unknown>
}

function normalizeWhitespace(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function normalizeRequiredString(value: unknown, maxLength: number): string {
  const normalized = normalizeWhitespace(value)
  if (!normalized) throw new Error('网页元素选择字段缺失。')
  return normalized.slice(0, maxLength)
}

function normalizeOptionalString(value: unknown, maxLength: number): string | undefined {
  const normalized = normalizeWhitespace(value)
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function normalizeSafeHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > BROWSER_ELEMENT_SELECTION_MAX_HREF) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}
