import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  realpathSync, writeFileSync, type Stats,
} from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

interface DirectoryIdentity { path: string; canonicalPath: string; stat: Stats }
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
function inspect(path: string): DirectoryIdentity {
  const stat = lstatSync(path)
  const canonicalPath = realpathSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(canonicalPath, path)) throw new Error('RTK 原文目录不可用')
  return { path, canonicalPath, stat }
}
function assertIdentity(identity: DirectoryIdentity): void {
  const current = inspect(identity.path)
  if (!samePath(current.canonicalPath, identity.canonicalPath) || current.stat.dev !== identity.stat.dev
    || current.stat.ino !== identity.stat.ino || current.stat.birthtimeMs !== identity.stat.birthtimeMs) {
    throw new Error('RTK 原文目录身份已变化')
  }
}

/** 在 run 创建时绑定宿主目录身份；链接/目录替换后不重新绑定，更不写入新目标。 */
export function createRtkOriginalStore(sessionDirectory: string): (text: string) => Promise<string> {
  let ancestors: DirectoryIdentity[]
  try {
    ancestors = []
    for (let path = resolve(sessionDirectory); ; path = dirname(path)) {
      ancestors.push(inspect(path))
      if (parse(path).root === path) break
    }
  } catch {
    return async () => { throw new Error('RTK 原文工作台不可用') }
  }
  const directory = join(resolve(sessionDirectory), 'rtk-output')
  let outputIdentity: DirectoryIdentity | undefined
  try { outputIdentity = inspect(directory) } catch {
    // 仅 ENOENT 的新目录允许后续创建；已存在的异常目录会在保存时继续 fail closed。
  }
  return async text => {
    // 有界的同步 check/open/write 区间避免应用自身异步调用交错；仍不是 OS 沙箱。
    for (const identity of ancestors) assertIdentity(identity)
    try { mkdirSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    outputIdentity ??= inspect(directory)
    assertIdentity(outputIdentity)
    if (readdirSync(directory).length >= 256) throw new Error('RTK 原文存储已达上限')
    const path = join(directory, `${randomUUID()}.txt`)
    for (const identity of ancestors) assertIdentity(identity)
    assertIdentity(outputIdentity)
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      for (const identity of ancestors) assertIdentity(identity)
      assertIdentity(outputIdentity)
      const opened = fstatSync(fd)
      const current = lstatSync(path)
      if (current.isSymbolicLink() || !samePath(realpathSync(path), path)
        || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('RTK 原文文件身份已变化')
      writeFileSync(fd, text, 'utf8')
    } finally { closeSync(fd) }
    for (const identity of ancestors) assertIdentity(identity)
    assertIdentity(outputIdentity)
    return path
  }
}
