const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const PATH_SEP_RE = /[\\/]/
const TRAILING_SEP_RE = /[\\/]$/

/**
 * 计算文件路径芯片的悬浮文案。
 * Agent 会话相对路径属于 Session Target；工作台候选目录只用于历史兼容解析，不能冒充真实路径。
 */
export function getFilePathDisplayPath(
  filePath: string,
  candidateBases: readonly string[],
  preferSessionTargetRelative: boolean,
): string {
  if (filePath.startsWith('/') || WIN_DRIVE_RE.test(filePath)) return filePath
  if (preferSessionTargetRelative || candidateBases.length === 0) return filePath

  const segments = filePath.split(PATH_SEP_RE)
  const firstSegment = segments[0]
  if (firstSegment) {
    for (const base of candidateBases) {
      const normalized = base.replace(/[\\/]+$/, '')
      const baseName = normalized.split(PATH_SEP_RE).pop()
      if (baseName === firstSegment) {
        const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
        const parentDir = lastSep >= 0 ? normalized.slice(0, lastSep) : ''
        if (!normalized) return filePath
        return parentDir ? `${parentDir}/${filePath}` : `/${filePath}`
      }
    }
  }
  const base = candidateBases[0]!
  return TRAILING_SEP_RE.test(base) ? `${base}${filePath}` : `${base}/${filePath}`
}
