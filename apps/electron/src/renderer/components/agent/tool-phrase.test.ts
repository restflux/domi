import { describe, expect, test } from 'bun:test'
import { getToolPhrase } from './tool-phrase'

describe('工具语义短语', () => {
  test('Read 行号区间按实际读取行数计算尾行', () => {
    expect(getToolPhrase('Read', {
      file_path: '/w/a.ts',
      offset: 1,
      limit: 151,
    }).label).toBe('读取 a.ts 第 1-151 行')
  })

  test('文件工具兼容 Host 使用的 path 字段', () => {
    expect(getToolPhrase('Read', { path: '/w/read.ts' }).label).toBe('读取 read.ts')
    expect(getToolPhrase('Edit', { path: '/w/edit.ts' }).label).toBe('编辑 edit.ts')
    expect(getToolPhrase('Write', { path: '/w/write.ts', content: 'a\nb' }).label).toBe('写入 write.ts')
  })

  test('MultiEdit 显示文件与编辑项数量', () => {
    expect(getToolPhrase('MultiEdit', {
      path: '/w/a.ts',
      edits: [{}, {}, {}],
    }).label).toBe('批量编辑 a.ts · 3 处')
  })

  test('LS 使用目录语义而不是暴露原始工具名', () => {
    expect(getToolPhrase('LS', { path: '/w/src' }).label).toBe('查看目录 src')
  })

  test('长搜索表达式与范围默认截短', () => {
    const phrase = getToolPhrase('Grep', {
      pattern: 'a'.repeat(80),
      path: `/workspace/${'nested/'.repeat(8)}`,
    })

    expect(phrase.label).toContain('…')
    expect(phrase.label.length).toBeLessThan(100)
  })
})
