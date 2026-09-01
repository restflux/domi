import { describe, expect, test } from 'bun:test'
import { toFriendlyFileError } from './FileBrowser.tsx'

describe('文件浏览器错误文案清洗', () => {
  test('剥掉 Electron IPC 包装前缀与内部错误类名', () => {
    const error = new Error(
      "Error invoking remote method 'agent:list-directory': SessionCheckoutError: Isolated Checkout 需要恢复后才能租用",
    )
    expect(toFriendlyFileError(error)).toContain('需要恢复')
    expect(toFriendlyFileError(error)).not.toContain('SessionCheckoutError')
    expect(toFriendlyFileError(error)).not.toContain('Error invoking remote method')
  })

  test('普通内部术语映射为可读文案', () => {
    expect(toFriendlyFileError(new Error("Error invoking remote method 'agent:list-directory': Error: Session Target 目录不存在或超出授权范围")))
      .toBe('目录不存在或超出授权范围')
    expect(toFriendlyFileError(new Error('访问路径超出当前会话的授权范围')))
      .toBe('路径超出当前会话授权范围')
    expect(toFriendlyFileError(new Error('Agent 文件 IPC 缺少 Session 上下文')))
      .toBe('会话文件暂不可用')
  })

  test('非错误输入与空消息安全兜底', () => {
    expect(toFriendlyFileError(null)).toBe('加载失败')
    expect(toFriendlyFileError('')).toBe('加载失败')
    expect(toFriendlyFileError(new Error('磁盘空间不足'))).toBe('磁盘空间不足')
  })
})
