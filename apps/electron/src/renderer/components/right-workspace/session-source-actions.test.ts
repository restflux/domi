import { describe, expect, test } from 'bun:test'
import { getSessionSourceCapabilities, getSessionSourceOpenMode } from './session-source-actions'

const context = {
  sessionId: 'session-a',
  sessionPath: '/workspace/session-a',
  attachedFiles: ['/external/image.png'],
  attachedDirectories: ['/external/docs'],
}

describe('会话来源操作范围', () => {
  test('Given 已授权图片 When 单击浮窗来源 Then 大屏展示，不占用右侧文件预览标签', () => {
    const permissions = getSessionSourceCapabilities('/workspace/session-a/.context/image.png', context)
    expect(getSessionSourceOpenMode({ isImage: true, isDirectory: false }, permissions)).toBe('lightbox')
    expect(getSessionSourceOpenMode({ isImage: false, isDirectory: false }, permissions)).toBe('preview')
    expect(getSessionSourceOpenMode({ isImage: false, isDirectory: true }, permissions)).toBe('browse')
    expect(getSessionSourceOpenMode({ isImage: true, isDirectory: false }, { readAccess: null, canMutate: false })).toBe('unavailable')
  })
  test('Given 会话工作台的文件 When 打开来源菜单 Then 可以用原有受控操作且不能扩张路径空间', () => {
    expect(getSessionSourceCapabilities('/workspace/session-a/.context/image.png', context)).toEqual({
      readAccess: { sessionId: 'session-a', pathSpace: 'session-workbench' },
      canMutate: true,
    })
  })

  test('Given 明确附加的外部文件或目录 When 操作来源 Then 仅提供宿主授权的读取动作', () => {
    expect(getSessionSourceCapabilities('/external/image.png', context)).toEqual({
      readAccess: { sessionId: 'session-a' },
      canMutate: false,
    })
    expect(getSessionSourceCapabilities('/external/docs/note.md', context).canMutate).toBe(false)
  })

  test('Given 消息伪造任意路径、相邻前缀或路径穿越 When 操作来源 Then 不授予读取与写入入口', () => {
    for (const path of ['/private/secret', '/workspace/session-a-other/file.txt', '/workspace/session-a/../outside', '/external/docs/../secret']) {
      expect(getSessionSourceCapabilities(path, context)).toEqual({ readAccess: null, canMutate: false })
    }
    expect(getSessionSourceCapabilities('/workspace/session-a', context).canMutate).toBe(false)
    expect(getSessionSourceCapabilities('/private/file', { ...context, sessionPath: '/' }).readAccess).toBeNull()
  })
})
