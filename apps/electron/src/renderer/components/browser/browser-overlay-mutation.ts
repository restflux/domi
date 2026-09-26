const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"], [data-browser-native-overlay="true"]'

/** 跳过已知高频编辑区，其余 DOM 变化保守重查，避免漏掉尚未挂上 role 的 portal。 */
export function hasBrowserOverlayMutation(records: readonly MutationRecord[]): boolean {
  const touchesOverlay = (node: Node): boolean => {
    if (node.nodeType !== 1) return false
    const element = node as Element
    return element.matches(OVERLAY_SELECTOR) || element.querySelector(OVERLAY_SELECTOR) !== null
  }
  const isKnownNoise = (node: Node): boolean => node.nodeType === 1
    && (node as Element).closest('.xterm, .ProseMirror') !== null

  for (const record of records) {
    if (record.type === 'childList') {
      for (const node of record.addedNodes) if (touchesOverlay(node)) return true
      for (const node of record.removedNodes) if (touchesOverlay(node)) return true
    }
    if (record.type === 'attributes' || record.type === 'childList') {
      if (touchesOverlay(record.target) || !isKnownNoise(record.target)) return true
    }
  }
  return false
}
