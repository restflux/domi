import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

/**
 * 解析最终 canonical target；待创建文件则从最近存在的父目录继续解析，
 * 避免通过已存在的 symlink/junction 父目录绕过 Workspace Boundary。
 */
export async function canonicalizePath(path: string): Promise<string> {
  let candidate = resolve(path)
  const missingSegments: string[] = []

  while (true) {
    try {
      const existingTarget = await realpath(candidate)
      return resolve(existingTarget, ...missingSegments.reverse())
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error

      const parent = dirname(candidate)
      if (parent === candidate) throw error
      missingSegments.push(basename(candidate))
      candidate = parent
    }
  }
}
