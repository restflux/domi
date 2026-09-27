/** 改编自 ZCode BrowserViewportToolbar 的草稿校验；沿用 Domi 现有视口范围。 */
export function parseViewportDimensionDraft(draft: string, dimension: 'width' | 'height'): number | null {
  const trimmed = draft.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  const minimum = dimension === 'width' ? 240 : 320
  const maximum = dimension === 'width' ? 1920 : 1600
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}
