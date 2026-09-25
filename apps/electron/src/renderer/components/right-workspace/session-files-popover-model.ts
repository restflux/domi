import type { GeneratedImageItem, SDKMessage, SDKUserMessage } from '@domi/shared'
import { extractUserText, isUserInputMessage } from '@domi/session-core'
import { parseAttachedFiles, isImageFile } from '@/lib/message-attachments'
import type { RightWorkspaceTool } from '@/lib/right-workspace-model'

export const SESSION_FILES_CARD_VISIBLE_LIMIT = 3

/** 只有工作目录中明确标记为生成的图片才进入“输出内容”；普通文件不能凭路径猜测来源。 */
export function selectConfirmedSessionOutputs(
  images: readonly GeneratedImageItem[],
): GeneratedImageItem[] {
  return images
    .filter((image) => image.source === 'agent-workspace')
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SESSION_FILES_CARD_VISIBLE_LIMIT)
}

export interface SessionFileSource {
  path: string
  filename: string
  isDirectory: boolean
  isImage: boolean
}

/** 消息中的附件也是输入来源；不从工作目录或工具结果猜测来源。 */
export function selectSessionFileSources(
  messages: readonly SDKMessage[],
  attachedFiles: readonly string[],
  attachedDirectories: readonly string[],
): SessionFileSource[] {
  const sources: SessionFileSource[] = []
  const seen = new Set<string>()
  const add = (path: string, filename: string, isDirectory: boolean): void => {
    if (!path || seen.has(path)) return
    seen.add(path)
    sources.push({ path, filename, isDirectory, isImage: !isDirectory && isImageFile(filename) })
  }

  // 优先展示最近一轮用户输入；会话元数据中的显式附件也应保留。
  for (const message of [...messages].reverse()) {
    if (message.type !== 'user') continue
    // SDKMessage 的兼容分支允许任意 type 字符串，需在判定后收窄。
    const userMessage = message as SDKUserMessage
    if (!isUserInputMessage(userMessage)) continue
    const text = extractUserText(userMessage)
    for (const file of parseAttachedFiles(text ?? '').files) add(file.path, file.filename, false)
  }
  for (const path of attachedFiles) add(path, path.split(/[\\/]/).pop() ?? path, false)
  for (const path of attachedDirectories) add(path, path.split(/[\\/]/).pop() ?? path, true)
  return sources.slice(0, SESSION_FILES_CARD_VISIBLE_LIMIT)
}

export const DEFAULT_SESSION_FILES_POPOVER_OPEN = false

/** 会话文件使用浮窗后，展开完整右侧工作区时不再回落到文件工具。 */
export function resolveRightWorkspaceToolAfterSessionFilesClose(
  activeTool: RightWorkspaceTool | undefined,
): RightWorkspaceTool {
  return !activeTool || activeTool === 'files' ? 'changes' : activeTool
}

export interface SessionFilesPopoverPointerInput {
  insideTrigger: boolean
  insidePanel: boolean
  insideOverlay?: boolean
}

export function shouldCloseSessionFilesPopoverOnPointerDown(
  input: SessionFilesPopoverPointerInput,
): boolean {
  return !input.insideTrigger && !input.insidePanel && !input.insideOverlay
}
