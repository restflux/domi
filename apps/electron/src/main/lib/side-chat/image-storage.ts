import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import type { ValidatedSideChatImage } from './images'

interface DirectoryIdentity { path: string; stat: Stats }
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
function inspect(path: string): DirectoryIdentity {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) throw new Error('侧聊图片目录不可用')
  return { path, stat }
}
function assertIdentity(identity: DirectoryIdentity): void {
  const current = inspect(identity.path).stat
  if (current.dev !== identity.stat.dev || current.ino !== identity.stat.ino || current.birthtimeMs !== identity.stat.birthtimeMs) throw new Error('侧聊图片目录已变化')
}

/** 复用宿主的排他文件创建与目录身份校验模式；绝不将 Renderer filename 直接 join 到 workbench。
 * workbench 必须已由宿主创建。与其他本地存储相同，这不是 OS 沙箱，不承诺抵御同用户进程的文件系统竞态。
 */
export function saveSideChatImages(workbench: string, images: ValidatedSideChatImage[]): Array<{ label: string; path: string }> {
  if (!images.length) return []
  const ancestors: DirectoryIdentity[] = []
  for (let path = resolve(workbench); ; path = dirname(path)) {
    ancestors.push(inspect(path))
    if (dirname(path) === path) break
  }
  const assertDirectories = (): void => { for (const entry of ancestors) assertIdentity(entry) }
  assertDirectories()
  const directory = mkdtempSync(join(ancestors[0]!.path, 'side-chat-images-'))
  ancestors.unshift(inspect(directory))
  const created: string[] = []
  try {
    return images.map(image => {
      assertDirectories()
      const path = join(directory, `${randomUUID()}${extname(image.filename).toLowerCase()}`)
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      created.push(path)
      try {
        assertDirectories()
        const opened = fstatSync(fd)
        const current = lstatSync(path)
        if (current.isSymbolicLink() || !samePath(realpathSync(path), path) || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('侧聊图片文件身份已变化')
        writeFileSync(fd, image.bytes)
      } finally { closeSync(fd) }
      assertDirectories()
      return { label: image.filename, path }
    })
  } catch (error) {
    // 仅回收本次排他创建的文件；目录身份变化时宁可留下残留，不追随新目标清理。
    try {
      assertDirectories()
      for (const path of created) unlinkSync(path)
      rmdirSync(directory)
    } catch { /* 不掩盖原始保存失败。 */ }
    throw error
  }
}
