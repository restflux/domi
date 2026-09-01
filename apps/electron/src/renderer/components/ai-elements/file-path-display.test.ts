import { describe, expect, test } from 'bun:test'
import { getFilePathDisplayPath } from './file-path-display.ts'

describe('getFilePathDisplayPath', () => {
  test('Agent 会话中的相对项目路径不再伪装成会话工作台绝对路径', () => {
    expect(getFilePathDisplayPath(
      'docs/report.html',
      ['C:\\Users\\A\\.domi\\agent-workspaces\\demo\\session-1'],
      true,
    )).toBe('docs/report.html')
  })

  test('非 Session Target 场景仍可用候选目录展示完整路径', () => {
    expect(getFilePathDisplayPath('docs/report.html', ['D:\\workspace\\demo'], false))
      .toBe('D:\\workspace\\demo/docs/report.html')
  })
})
