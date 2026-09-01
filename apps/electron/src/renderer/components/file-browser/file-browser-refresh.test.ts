import { describe, expect, test } from 'bun:test'
import { createFileBrowserRootSignature } from './file-browser-refresh'

describe('文件浏览器刷新', () => {
  test('同一物理根在常规文件变化后保持相同签名', () => {
    const before = createFileBrowserRootSignature([
      { path: 'D:\\workspace\\domi', scope: 'project' },
    ])
    const after = createFileBrowserRootSignature([
      { path: 'D:\\workspace\\domi', scope: 'project' },
    ])

    expect(after).toBe(before)
  })

  test('切换文件来源或物理根时产生不同签名', () => {
    const project = createFileBrowserRootSignature([
      { path: 'D:\\workspace\\domi', scope: 'project' },
    ])
    const session = createFileBrowserRootSignature([
      { path: 'C:\\Users\\A\\.domi\\session', scope: 'session' },
    ])
    const anotherProject = createFileBrowserRootSignature([
      { path: 'D:\\workspace\\other', scope: 'project' },
    ])

    expect(session).not.toBe(project)
    expect(anotherProject).not.toBe(project)
  })
})
