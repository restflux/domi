import { describe, expect, test } from 'bun:test'
import {
  buildWorktreeTitleGenerationMessage,
  createWorktreeTitleFallback,
  generateInitialWorktreeSessionTitle,
} from './worktree-session-title.ts'

const image = { filename: '目录截图.png', mediaType: 'image/png' }
const document = { filename: '需求说明.pdf', mediaType: 'application/pdf' }

describe('worktree session title', () => {
  test('标题模型输入保留长文本并只附带附件名称与类型', () => {
    const text = '这是一段很长的首条消息，用来说明 Worktree 路径设计与命名问题。'
    const message = buildWorktreeTitleGenerationMessage(text, [image, document])

    expect(message).toContain(text)
    expect(message).toContain('目录截图.png (image/png)')
    expect(message).toContain('需求说明.pdf (application/pdf)')
    expect(message).not.toContain('base64')
    expect(message).not.toContain('C:\\')
  })

  test('纯附件按图片、文档和一般文件生成稳定兜底标题', () => {
    expect(createWorktreeTitleFallback('', [image])).toBe('图片分析任务')
    expect(createWorktreeTitleFallback('', [document])).toBe('文档处理任务')
    expect(createWorktreeTitleFallback('', [{ filename: 'archive.zip', mediaType: 'application/zip' }])).toBe('附件处理任务')
    expect(createWorktreeTitleFallback('', [])).toBe('新任务')
  })

  test('AI 成功时使用语义标题', async () => {
    const title = await generateInitialWorktreeSessionTitle({
      userText: '请优化 Worktree 路径',
      attachments: [],
      generateTitle: async () => '优化 Worktree 路径',
      timeoutMs: 50,
    })

    expect(title).toBe('优化 Worktree 路径')
  })

  test('AI 失败或超时时不阻塞并使用本地兜底', async () => {
    const failed = await generateInitialWorktreeSessionTitle({
      userText: '',
      attachments: [image],
      generateTitle: async () => { throw new Error('offline') },
      timeoutMs: 50,
    })
    const timedOut = await generateInitialWorktreeSessionTitle({
      userText: '修复 Worktree 创建流程',
      attachments: [],
      generateTitle: () => new Promise((resolve) => setTimeout(() => resolve('迟到标题'), 50)),
      timeoutMs: 5,
    })

    expect(failed).toBe('图片分析任务')
    expect(timedOut).toBe('修复 Worktree 创建流程')
  })
})
