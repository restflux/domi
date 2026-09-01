import { isAbsolute, win32 } from 'node:path'
import type { FileAccessOptions } from '@domi/shared'

/** Session Target 路径能力中只读预览解析需要的最小接口。 */
export interface PreviewPathAccess {
  resolveLegacyAbsolutePreviewPath(filePath: string, options?: FileAccessOptions): Promise<string | null>
  usesSessionTargetPathSpace(options?: FileAccessOptions): boolean
  resolveRelative(sessionId: string, relativePath: string): Promise<string | null>
  resolveUniquePreviewBasename(sessionId: string, fileName: string): Promise<string | null>
}

/** 把通用文件查找与最终授权注入进来，保持路径空间决策可独立回归测试。 */
export interface PreviewPathResolverDependencies {
  resolveCandidatePath(filePath: string, candidateBasePaths?: string[]): Promise<string | null>
  authorizeResolvedPath(filePath: string, options?: FileAccessOptions): Promise<boolean>
}

/**
 * 统一解析只读预览路径。
 *
 * Active Pi 默认先按 Session Target 相对路径解析。历史消息没有 pathSpace 且目标内不存在时，
 * 才允许候选基础目录定位文件，并再次通过会话真实授权根校验；显式 pathSpace 永不降级。
 */
export async function resolvePreviewReadPath(
  filePath: string,
  options: FileAccessOptions | undefined,
  access: PreviewPathAccess,
  dependencies: PreviewPathResolverDependencies,
): Promise<string | null> {
  const legacyAbsolutePath = await access.resolveLegacyAbsolutePreviewPath(filePath, options)
  if (legacyAbsolutePath) return legacyAbsolutePath

  if (access.usesSessionTargetPathSpace(options)) {
    const targetPath = options?.sessionId
      ? await access.resolveRelative(options.sessionId, filePath)
      : null
    if (targetPath) return targetPath

    // 失效的历史绝对路径不能按 basename 搜索并绑定到另一份同名授权文件。
    if (isAbsolute(filePath) || win32.isAbsolute(filePath)) return null

    // pathSpace 显式声明后不允许候选目录改变语义；仅兼容没有路径空间元数据的历史记录。
    if (options?.pathSpace !== undefined) return null

    // 历史回复常只保留 `report.md` 这类裸文件名。仅在当前 Session Target 内唯一命中时补全，
    // 不把同名文件绑定到另一个 checkout，也不向 renderer 暴露真实 target 根路径。
    if (options?.sessionId && !filePath.includes('/') && !filePath.includes('\\')) {
      const basenamePath = await access.resolveUniquePreviewBasename(options.sessionId, filePath)
      if (basenamePath) return basenamePath
    }

    const candidatePath = await dependencies.resolveCandidatePath(filePath, options?.candidateBasePaths)
    if (!candidatePath) return null
    return access.resolveLegacyAbsolutePreviewPath(candidatePath, options)
  }

  const resolvedPath = await dependencies.resolveCandidatePath(filePath, options?.candidateBasePaths)
  if (!resolvedPath) return null
  return await dependencies.authorizeResolvedPath(resolvedPath, options)
    ? resolvedPath
    : null
}
