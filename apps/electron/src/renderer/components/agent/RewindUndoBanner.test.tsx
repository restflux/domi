import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RewindUndoBanner } from './RewindUndoBanner.tsx'

describe('RewindUndoBanner', () => {
  test('可撤销时显示单级撤销边界和操作入口', () => {
    const html = renderToStaticMarkup(
      <RewindUndoBanner
        state={{ exists: true, available: true, filesChanged: ['src/a.ts'], conflicts: [] }}
        inProgress={false}
        onUndo={() => undefined}
      />,
    )

    expect(html).toContain('已回退到历史状态')
    expect(html).toContain('发送下一条消息或切换分支后将无法撤销')
    expect(html).toContain('撤销回退')
    expect(html).toContain('1 个文件')
  })

  test('执行中禁用重复撤销', () => {
    const html = renderToStaticMarkup(
      <RewindUndoBanner
        state={{ exists: true, available: true, filesChanged: [], conflicts: [] }}
        inProgress
        onUndo={() => undefined}
      />,
    )

    expect(html).toContain('撤销中…')
    expect(html).toContain('disabled=""')
  })

  test('事务仍存在但发生冲突时保留原因并禁用按钮', () => {
    const html = renderToStaticMarkup(
      <RewindUndoBanner
        state={{ exists: true, available: false, filesChanged: ['src/a.ts'], conflicts: ['src/a.ts'], error: '文件已被修改' }}
        inProgress={false}
        onUndo={() => undefined}
      />,
    )

    expect(html).toContain('当前无法撤销：文件已被修改')
    expect(html).toContain('disabled=""')
  })

  test('没有可撤销事务时不渲染', () => {
    expect(renderToStaticMarkup(
      <RewindUndoBanner
        state={{ exists: false, available: false, filesChanged: [], conflicts: [], error: '没有可撤销的回退' }}
        inProgress={false}
        onUndo={() => undefined}
      />,
    )).toBe('')
  })
})
