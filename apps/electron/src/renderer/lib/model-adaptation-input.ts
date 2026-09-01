/**
 * 将模型 Token 输入从展示态切换为编辑态。
 * 合法数字中的分隔逗号会移除，避免受控输入实时重排文本导致光标跳动。
 */
export function prepareModelTokenInputForEdit(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^[\d,]+$/.test(trimmed) || !/\d/.test(trimmed)) return value
  return trimmed.replace(/,/g, '')
}

/**
 * 在输入结束后将合法数字格式化为易读的千分位文本。
 * 输入过程中不应调用此函数；负数、小数或字母会保留原值，以便显示内联错误。
 */
export function formatModelTokenInput(value: string): string {
  const editable = prepareModelTokenInputForEdit(value)
  if (!editable) return ''
  if (!/^\d+$/.test(editable)) return value
  const normalized = editable.replace(/^0+(?=\d)/, '')
  return normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 将纯数字或含逗号分隔符的 Token 文本解析为安全正整数。 */
export function parseModelTokenInput(value: string): number | undefined {
  const normalized = prepareModelTokenInputForEdit(value)
  if (!/^\d+$/.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
