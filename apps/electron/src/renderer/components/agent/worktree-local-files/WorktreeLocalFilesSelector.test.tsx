import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocalFileTreeRow, localFileFolderSelection } from './WorktreeLocalFilesSelector.tsx'

const noop = (): void => {}

describe('项目文件树选择', () => {
  test('不可选项置灰并禁用，不常驻原因；整行可键盘聚焦以获取提示', () => {
    const markup = renderToStaticMarkup(<LocalFileTreeRow node={{ path: 'config/tracked.json', name: 'tracked.json', kind: 'file', selectable: false, reason: '文件由 Git 管理，无需复制' }} checked={false} expanded={false} disabled={false} fullPath onToggle={noop} onExpand={noop} onClear={noop} />)
    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('aria-label="选择 config/tracked.json"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('opacity-50')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('role="group"')
    expect(markup).not.toContain('文件由 Git 管理')
  })
  test('不可选文件夹禁止展开和勾选，原因不占用文件树行', () => {
    const markup = renderToStaticMarkup(<LocalFileTreeRow node={{ path: 'node_modules', name: 'node_modules', kind: 'directory', selectable: false, reason: '依赖目录不可选择' }} checked={false} expanded={false} disabled={false} onToggle={noop} onExpand={noop} onClear={noop} />)
    expect(markup).toContain('aria-label="展开 node_modules"')
    expect(markup.match(/disabled=""/g)).toHaveLength(2)
    expect(markup).toContain('tabindex="0"')
    expect(markup).not.toContain('依赖目录不可选择')
  })
  test('文件夹展开、批量选择与清除是独立操作，可展示已选数量', () => {
    const markup = renderToStaticMarkup(<LocalFileTreeRow node={{ path: 'config', name: 'config', kind: 'directory', selectable: true }} checked="indeterminate" expanded disabled={false} selectedCount={2} onToggle={noop} onExpand={noop} onClear={noop} />)
    expect(markup).toContain('aria-label="收起 config"')
    expect(markup).toContain('aria-checked="mixed"')
    expect(markup).toContain('已选 2 个文件')
    expect(markup).toContain('aria-label="清除 config 中的选择"')
    expect(markup).not.toContain('role="group"')
    expect(markup).not.toContain('tabindex="0"')
  })
  test('文件夹选择只依据具体快照，逐项取消后变为部分选择且不误匹配相似目录', () => {
    expect(localFileFolderSelection('config', ['config/a', 'config/b'], ['config/a', 'config/b'])).toBe(true)
    expect(localFileFolderSelection('config', ['config/a'], ['config/a', 'config/b'])).toBe('indeterminate')
    expect(localFileFolderSelection('config', ['config-old/a'])).toBe(false)
    expect(localFileFolderSelection('config', ['config/a'])).toBe('indeterminate')
  })
})
