/**
 * 生成图片画廊 — 纯收集逻辑
 *
 * 从会话消息附件与磁盘目录中收集生成图片条目。
 * 本文件保持零 Electron 依赖（仅 node:fs / node:path），
 * 以便 bun test 直接覆盖纯逻辑；Electron 编排见 gallery-service.ts。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AgentCwdMode, GeneratedImageItem } from '@domi/shared'

/** 已知图片扩展名 → MIME 类型映射 */
const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** 内部收集条目；contentHash 仅用于跨目录副本去重，不通过 shared API 暴露 */
export interface GalleryCoreImageItem extends GeneratedImageItem {
  contentHash?: string
}

export interface AgentGalleryDirectory {
  dir: string
  source: 'agent-workspace' | 'agent-attachment'
}

/**
 * 计算 Agent 会话可扫描的画廊目录。
 *
 * project cwd 被同一项目的多个会话共享，不能直接扫描其中的 generated-images，
 * 否则其他会话生成的图片会串入当前会话。生图工具始终另存一份会话附件，
 * 因此 project 模式只读当前会话附件；旧式 session 私有 cwd 继续兼容工作目录图片。
 */
export function buildAgentGalleryDirectories(
  attachmentDir: string,
  agentCwd: string | undefined,
  agentCwdMode: AgentCwdMode | undefined,
): AgentGalleryDirectory[] {
  const directories: AgentGalleryDirectory[] = [
    { dir: attachmentDir, source: 'agent-attachment' },
  ]
  if (agentCwd && agentCwdMode !== 'project') {
    directories.unshift({ dir: join(agentCwd, 'generated-images'), source: 'agent-workspace' })
  }
  return directories
}

/** 判断消息附件是否为图片 */
export function isImageMediaType(mediaType: string | undefined): boolean {
  return !!mediaType && mediaType.startsWith('image/')
}

/**
 * 扫描目录下的图片文件
 *
 * 目录不存在时返回空数组；跳过子目录与无法 stat 的条目。
 */
export function scanImageDirectory(dir: string, source: GeneratedImageItem['source']): GalleryCoreImageItem[] {
  if (!existsSync(dir)) return []
  try {
    const dirStat = lstatSync(dir)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return []
  } catch {
    return []
  }

  const items: GalleryCoreImageItem[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    try {
      const stat = lstatSync(fullPath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const mediaType = IMAGE_EXT_TO_MIME[extname(entry).toLowerCase()]
      if (!mediaType) continue
      items.push({
        localPath: fullPath,
        filename: entry,
        mediaType,
        size: stat.size,
        mtime: stat.mtimeMs,
        source,
        contentHash: createHash('sha1').update(readFileSync(fullPath)).digest('hex'),
      })
    } catch {
      // stat 失败（文件被占用/已删除）跳过
    }
  }
  return items
}

interface MessageLikeAttachment {
  localPath?: string
  filename?: string
  mediaType?: string
  size?: number
}

interface MessageLike {
  role?: string
  createdAt?: number
  attachments?: MessageLikeAttachment[]
}

/**
 * 从会话消息列表中收集图片附件（仅 assistant 角色）
 *
 * mtime 用消息 createdAt 兜底（附件保存时间早于消息时间，展示排序足够）。
 */
export function collectImagesFromMessages(messages: MessageLike[]): GalleryCoreImageItem[] {
  const items: GalleryCoreImageItem[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const att of message.attachments ?? []) {
      if (!isImageMediaType(att.mediaType) || !att.localPath) continue
      items.push({
        localPath: att.localPath,
        filename: att.filename || att.localPath.split(/[\\/]/).pop() || 'image',
        mediaType: att.mediaType!,
        size: att.size ?? 0,
        mtime: message.createdAt ?? 0,
        source: 'chat',
      })
    }
  }
  return items
}

/**
 * 去重并按 mtime 倒序（新的在前）
 *
 * 先按路径去重，再按内容哈希去重 Agent 的双份落盘副本。
 * 同内容优先保留工作目录条目，以展示生图工具生成的可读文件名；
 * 会话范围 Gallery IPC 会负责安全读取和另存为。
 */
export function dedupeAndSortImages(items: GalleryCoreImageItem[]): GeneratedImageItem[] {
  const byPath = new Map<string, GalleryCoreImageItem>()
  for (const item of items) {
    const existing = byPath.get(item.localPath)
    if (!existing || item.mtime > existing.mtime) byPath.set(item.localPath, item)
  }

  const sourceRank: Record<GeneratedImageItem['source'], number> = {
    'agent-workspace': 3,
    chat: 2,
    'agent-attachment': 1,
  }
  const byContent = new Map<string, GalleryCoreImageItem>()
  const withoutHash: GalleryCoreImageItem[] = []
  for (const item of byPath.values()) {
    if (!item.contentHash) {
      withoutHash.push(item)
      continue
    }
    const existing = byContent.get(item.contentHash)
    if (!existing || sourceRank[item.source] > sourceRank[existing.source]) {
      byContent.set(item.contentHash, item)
    }
  }

  return [...byContent.values(), ...withoutHash]
    .map(({ contentHash: _contentHash, ...item }) => item)
    .sort((a, b) => b.mtime - a.mtime)
}
