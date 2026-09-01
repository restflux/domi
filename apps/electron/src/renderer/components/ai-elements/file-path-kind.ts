export const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
])

const TRAILING_LINE_COLUMN_RE = /^(.+?)(?::\d+(?::\d+)?)$/

/** 判断路径是否指向可在内置预览中显示的图片。 */
export function isImageFilePath(filePath: string): boolean {
  const trimmed = filePath.trim()
  if (!trimmed || /[\\/]$/.test(trimmed)) return false

  const cleanPath = TRAILING_LINE_COLUMN_RE.exec(trimmed)?.[1] ?? trimmed
  const filename = cleanPath.split(/[\\/]/).pop() ?? cleanPath
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return false

  return IMAGE_FILE_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase())
}
