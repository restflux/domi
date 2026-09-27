import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GeneratedImage } from './service'

const SCHEME = 'domi-session-image://'
const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const IMAGE_NAME = `${SESSION_ID}\\.(png|jpg|jpeg)`
const SESSION_IMAGE = new RegExp(`^(${SESSION_ID})/(${IMAGE_NAME})$`, 'i')
const MAX_IMAGE_BYTES = 100 * 1024 * 1024

export function isSessionImageReference(raw: string): boolean {
  return raw.startsWith(SCHEME) || SESSION_IMAGE.test(raw)
}

/** 会话附件只在生图工具内解析，不作为普通文件路径交给其他工具。 */
export function readSessionImageReference(raw: string, sessionId: string, attachmentsRoot: string | (() => string)): GeneratedImage | null {
  const isHandle = raw.startsWith(SCHEME)
  const localPath = isHandle ? raw.slice(SCHEME.length) : raw
  const match = SESSION_IMAGE.exec(localPath)
  if (!match) {
    if (isHandle) throw new Error('无效的会话图片引用')
    return null
  }
  if (match[1] !== sessionId) throw new Error('只能引用当前会话的图片附件')
  const directory = join(typeof attachmentsRoot === 'function' ? attachmentsRoot() : attachmentsRoot, sessionId)
  const path = join(directory, match[2]!)
  try {
    const parent = lstatSync(directory)
    const file = lstatSync(path)
    if (!parent.isDirectory() || parent.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > MAX_IMAGE_BYTES) {
      throw new Error('无效的会话图片附件')
    }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.size > MAX_IMAGE_BYTES) throw new Error('无效的会话图片附件')
      return { data: readFileSync(fd).toString('base64'), mimeType: match[3]!.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg' }
    } finally { closeSync(fd) }
  } catch { throw new Error('无效的会话图片附件；请确认图片仍存在于当前会话') }
}

export function formatSessionImageReference(localPath: string): string {
  return `${SCHEME}${localPath}`
}
