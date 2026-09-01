export const DEFAULT_AGENT_SESSION_TITLE = '新 Agent 会话'
export const INITIAL_WORKTREE_TITLE_TIMEOUT_MS = 10_000

const MAX_TITLE_LENGTH = 20
const MARKDOWN_PREFIX = /^(?:[#>*\-\d.)]\s*)+/
const DOCUMENT_EXTENSION = /\.(?:pdf|docx?|odt|rtf|txt|md|markdown|pptx?|xlsx?|csv)$/i

export interface WorktreeTitleAttachment {
  filename: string
  mediaType: string
}

function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('')
}

function cleanTitle(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/^["'“”‘’「《]+|["'“”‘’」》]+$/g, '').trim()
  return cleaned ? truncateCodePoints(cleaned, MAX_TITLE_LENGTH) : null
}

/** 标题模型只接收用户文本和附件元数据，绝不拼入本地路径、Base64 或 Markdown 图片数据。 */
export function buildWorktreeTitleGenerationMessage(
  userText: string,
  attachments: readonly WorktreeTitleAttachment[],
): string {
  const text = userText.trim()
  if (attachments.length === 0) return text
  const attachmentLines = attachments.map((file) => `- ${file.filename} (${file.mediaType || 'unknown'})`)
  return [
    text,
    '<attachments>',
    ...attachmentLines,
    '</attachments>',
  ].filter(Boolean).join('\n')
}

function isDocumentAttachment(file: WorktreeTitleAttachment): boolean {
  return file.mediaType.startsWith('text/')
    || file.mediaType === 'application/pdf'
    || file.mediaType.includes('document')
    || file.mediaType.includes('spreadsheet')
    || file.mediaType.includes('presentation')
    || DOCUMENT_EXTENSION.test(file.filename)
}

export function createWorktreeTitleFallback(
  userText: string,
  attachments: readonly WorktreeTitleAttachment[],
): string {
  const firstLine = userText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (firstLine) {
    const cleaned = firstLine.replace(MARKDOWN_PREFIX, '').replace(/\s+/g, ' ').trim()
    if (cleaned) return truncateCodePoints(cleaned, MAX_TITLE_LENGTH)
  }
  if (attachments.length === 0) return '新任务'
  if (attachments.every((file) => file.mediaType.startsWith('image/'))) return '图片分析任务'
  if (attachments.every(isDocumentAttachment)) return '文档处理任务'
  return '附件处理任务'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function generateInitialWorktreeSessionTitle(input: {
  userText: string
  attachments: readonly WorktreeTitleAttachment[]
  generateTitle?: (userMessage: string) => Promise<string | null>
  timeoutMs?: number
}): Promise<string> {
  const fallback = createWorktreeTitleFallback(input.userText, input.attachments)
  if (!input.generateTitle) return fallback

  try {
    const source = buildWorktreeTitleGenerationMessage(input.userText, input.attachments)
    const generated = await withTimeout(
      input.generateTitle(source),
      input.timeoutMs ?? INITIAL_WORKTREE_TITLE_TIMEOUT_MS,
    )
    return cleanTitle(generated) ?? fallback
  } catch {
    return fallback
  }
}
