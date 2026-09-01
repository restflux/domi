/**
 * 生成图片画廊服务（Electron 编排层）
 *
 * 聚合 Chat / Agent 会话中由生图工具产出的图片：
 * - Chat：会话消息 JSONL 中 assistant 消息的图片附件
 * - Agent：{agentCwd}/generated-images/ 工作目录 + ~/.domi/attachments/{sessionId}/ 附件目录
 *
 * 纯收集逻辑见 gallery-core.ts（可单测）；本文件只做 Electron 侧编排与路径授权。
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path'
import type { GeneratedImageItem, GeneratedImagesRequest } from '@domi/shared'
import { resolveAttachmentPath } from './config-paths'
import { getConversationMessages } from './conversation-manager'
import { getAgentSessionMeta, resolveAgentCwd } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import {
  buildAgentGalleryDirectories,
  collectImagesFromMessages,
  dedupeAndSortImages,
  scanImageDirectory,
  type AgentGalleryDirectory,
} from './gallery-core'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

function attachmentAbsolutePath(localPath: string): string {
  return isAbsolute(localPath) ? localPath : resolveAttachmentPath(localPath)
}

function agentGalleryDirectories(sessionId: string): AgentGalleryDirectory[] {
  const attachmentDir = resolveAttachmentPath(sessionId)
  try {
    const meta = getAgentSessionMeta(sessionId)
    const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
    const agentCwd = resolveAgentCwd(workspace, sessionId, meta?.agentCwdMode)
    return buildAgentGalleryDirectories(attachmentDir, agentCwd, meta?.agentCwdMode)
  } catch (error) {
    console.warn('[Gallery] 解析 Agent 工作目录失败:', error)
    return buildAgentGalleryDirectories(attachmentDir, undefined, undefined)
  }
}

/**
 * 列出会话的生成图片
 *
 * @param request Chat 会话传 conversationId；Agent 会话传 sessionId
 */
export function listGeneratedImages(request: GeneratedImagesRequest): GeneratedImageItem[] {
  if (request.kind === 'chat') {
    const messages = getConversationMessages(request.conversationId)
    const attachmentDir = resolveAttachmentPath(request.conversationId)
    const items = collectImagesFromMessages(messages)
      .map((item) => ({
        ...item,
        // 对外统一返回绝对路径，便于定位文件与会话范围授权比较
        localPath: attachmentAbsolutePath(item.localPath),
      }))
      .filter((item) => isWithinDirectory(item.localPath, attachmentDir) && isImageFile(item.localPath))
    return dedupeAndSortImages(items)
  }

  const items = agentGalleryDirectories(request.sessionId).flatMap(({ dir, source }) =>
    scanImageDirectory(dir, source)
  )
  return dedupeAndSortImages(items)
}

function normalizedPath(filePath: string): string {
  const value = normalize(resolve(filePath))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isWithinDirectory(filePath: string, directory: string): boolean {
  try {
    const dirStat = lstatSync(directory)
    const fileStat = lstatSync(filePath)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) {
      return false
    }
    const rel = relative(normalizedPath(realpathSync(directory)), normalizedPath(realpathSync(filePath)))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

function isImageFile(filePath: string): boolean {
  if (!IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase()) || !existsSync(filePath)) return false
  try {
    const stat = lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 校验路径确属当前会话画廊，并读取为 base64。
 * 不接受会话授权范围外路径，避免 renderer 借画廊 IPC 读取任意文件。
 */
export function readGeneratedImageAsBase64(request: GeneratedImagesRequest, localPath: string): string {
  const wanted = normalizedPath(localPath)
  let allowed = false

  if (request.kind === 'chat') {
    const messages = getConversationMessages(request.conversationId)
    const attachmentDir = resolveAttachmentPath(request.conversationId)
    allowed = isWithinDirectory(wanted, attachmentDir) && collectImagesFromMessages(messages).some(
      (item) => normalizedPath(attachmentAbsolutePath(item.localPath)) === wanted
    )
  } else {
    allowed = agentGalleryDirectories(request.sessionId).some(({ dir }) => isWithinDirectory(wanted, dir))
  }

  if (!allowed || !isImageFile(wanted)) throw new Error('图片不属于当前会话画廊')
  return readFileSync(wanted).toString('base64')
}
