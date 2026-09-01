import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'

export type ResolvedPreviewPath =
  | { kind: 'file'; url: string }
  | { kind: 'directory' }

/**
 * 把已经通过会话授权的本地路径转换为 renderer 可消费的预览目标。
 *
 * 文件注册为不暴露真实路径的 domi-file URL；目录保持为目录类型，由 renderer
 * 请求系统文件管理器打开。这样目录不会因为“不能注册成文件”而被误报为路径不存在。
 */
export function createResolvedPreviewPath(
  resolvedPath: string,
  registerFilePath: (filePath: string) => string,
): ResolvedPreviewPath | null {
  try {
    const stats = statSync(resolvedPath)
    if (stats.isDirectory()) return { kind: 'directory' }
    if (!stats.isFile()) return null
    return { kind: 'file', url: registerFilePath(resolvedPath) }
  } catch {
    return null
  }
}

/**
 * 为 HTML 预览注册文件所在目录，使相对 CSS、脚本和图片继续按页面目录解析。
 * Renderer 只接收 opaque domi-file token 与编码后的文件名，不接触本机绝对路径。
 */
export function createResolvedHtmlPreviewPath(
  resolvedPath: string,
  registerDirectoryPath: (directoryPath: string) => string,
): ResolvedPreviewPath | null {
  try {
    const stats = statSync(resolvedPath)
    if (!stats.isFile()) return null
    const directoryUrl = registerDirectoryPath(dirname(resolvedPath)).replace(/\/+$/, '')
    return {
      kind: 'file',
      url: `${directoryUrl}/${encodeURIComponent(basename(resolvedPath))}`,
    }
  } catch {
    return null
  }
}
