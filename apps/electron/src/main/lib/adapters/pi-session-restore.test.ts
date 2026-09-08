import { describe, expect, test } from 'bun:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'

// 使用真实 SDK 的内存存储接口，不读取用户会话或发起 Provider 请求。
describe('Pi 外部会话恢复', () => {
  test('Given 已压缩会话的外部 entries When 恢复内存会话 Then 保留压缩边界且不恢复被摘要替代的历史', () => {
    const source = SessionManager.inMemory(process.cwd())
    source.appendMessage({ role: 'user', content: '旧的长历史', timestamp: 1 })
    const keptId = source.appendMessage({ role: 'user', content: '当前工作要求', timestamp: 2 })
    source.appendCompaction('已完成调研，接着实现', keptId, 80_000)
    source.appendMessage({ role: 'user', content: '继续验证', timestamp: 3 })
    const header = source.getHeader()
    if (!header) throw new Error('内存会话缺少 header')

    const restored = SessionManager.inMemory(process.cwd(), undefined, [header, ...source.getEntries()])
    const context = restored.buildSessionContext()

    expect(restored.getSessionId()).toBe(source.getSessionId())
    expect(restored.getLeafId()).toBe(source.getLeafId())
    expect(restored.getEntries()).toEqual(source.getEntries())
    expect(restored.isPersisted()).toBe(false)
    expect(context.messages).toEqual(source.buildSessionContext().messages)
    expect(context.messages.some((message) => message.role === 'compactionSummary')).toBe(true)
    expect(JSON.stringify(context.messages)).not.toContain('旧的长历史')
    expect(JSON.stringify(context.messages)).toContain('当前工作要求')
    expect(JSON.stringify(context.messages)).toContain('继续验证')
  })
})
