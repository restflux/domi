export function resolveChangedFileTerminalCwd(relativePath: string): string {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment.includes('\0'))) {
    throw new Error('改动文件路径无效。')
  }
  segments.pop()
  return segments.join('/') || '.'
}
