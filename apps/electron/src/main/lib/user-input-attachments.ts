/**
 * 审批/问答横幅粘贴图片的主进程落盘。
 *
 * 渲染进程把粘贴的图片以 base64 随 AskUserResponse / ExitPlanModeResponse 提交，
 * 这里写入系统临时目录，并把绝对路径以 `[附图 n]: <路径>` 追加进对应答案/反馈文本，
 * Agent 通过 Read 工具即可查看图片（纯读取不受 Execution Policy 限制）。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AskUserResponse,
  ExitPlanModeResponse,
  UserInputImageAttachment,
} from '@domi/shared'

/** 临时目录名（位于 os.tmpdir() 下） */
const ATTACHMENT_DIR_NAME = 'domi-user-input-attachments'

/** 清理文件名中的路径分隔与非法字符，避免目录逃逸 */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^\w.\- ]+/g, '_').trim()
  return cleaned || 'pasted-image.png'
}

/** 把单个附件写入临时目录，返回绝对路径 */
async function saveAttachment(attachment: UserInputImageAttachment): Promise<string> {
  const dir = join(tmpdir(), ATTACHMENT_DIR_NAME)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${sanitizeFilename(attachment.filename)}`)
  await writeFile(filePath, Buffer.from(attachment.dataBase64, 'base64'))
  return filePath
}

function formatAttachmentRefs(paths: string[]): string {
  return paths.map((path, idx) => `[附图 ${idx + 1}]: ${path}`).join('\n')
}

/**
 * 处理 AskUser 响应：保存附件并把路径追加进对应答案。
 *
 * questionKey 与渲染端约定一致（问题文本或 DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY）；
 * 答案里没有该 key 时会创建只含附图引用的条目，保证 Agent 总能看到图片路径。
 */
export async function mergeAskUserAttachments(response: AskUserResponse): Promise<Record<string, string>> {
  const answers: Record<string, string> = { ...response.answers }
  const attachments = response.attachments ?? []
  if (attachments.length === 0) return answers

  const byKey = new Map<string, string[]>()
  for (const attachment of attachments) {
    try {
      const path = await saveAttachment(attachment)
      const key = attachment.questionKey ?? ''
      const list = byKey.get(key) ?? []
      list.push(path)
      byKey.set(key, list)
    } catch (error) {
      console.error('[用户输入附件] AskUser 图片保存失败:', error)
    }
  }

  for (const [key, paths] of byKey) {
    if (paths.length === 0) continue
    const refs = formatAttachmentRefs(paths)
    answers[key] = answers[key] ? `${answers[key]}\n${refs}` : refs
  }
  return answers
}

/**
 * 处理 ExitPlanMode 响应：保存附件并把路径追加进反馈文本。
 * 仅 feedback 动作携带附件；全部保存失败时返回原响应。
 */
export async function mergeExitPlanFeedbackAttachments(response: ExitPlanModeResponse): Promise<ExitPlanModeResponse> {
  const attachments = response.attachments ?? []
  if (response.action !== 'feedback' || attachments.length === 0) return response

  const paths: string[] = []
  for (const attachment of attachments) {
    try {
      paths.push(await saveAttachment(attachment))
    } catch (error) {
      console.error('[用户输入附件] 计划反馈图片保存失败:', error)
    }
  }
  if (paths.length === 0) return response

  const base = response.feedback?.trim() ?? ''
  return { ...response, feedback: `${base}${base ? '\n' : ''}${formatAttachmentRefs(paths)}` }
}
