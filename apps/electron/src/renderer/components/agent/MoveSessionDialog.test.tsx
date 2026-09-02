import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  copyGeneratedHandoffContent,
  getInitialHandoffWorkspaceId,
  HandoffLocationChoice,
} from './MoveSessionDialog.tsx'

describe('MoveSessionDialog model', () => {
  test('已执行会话默认选择当前项目', () => {
    expect(getInitialHandoffWorkspaceId(false, 'current-project')).toBe('current-project')
  })

  test('草稿迁移仍要求用户选择其他项目', () => {
    expect(getInitialHandoffWorkspaceId(true, 'current-project')).toBe('')
  })

  test('选中的工作位置卡片显示明确状态并可整卡点击', () => {
    const onSelect = mock(() => undefined)
    const choice = HandoffLocationChoice({
      selected: true,
      title: '使用项目当前目录',
      description: '当前独立工作区中的修改不会自动带到项目目录。',
      onSelect,
    })

    expect(choice.props.role).toBe('radio')
    expect(choice.props['aria-checked']).toBe(true)
    choice.props.onClick()
    expect(onSelect).toHaveBeenCalledTimes(1)

    const html = renderToStaticMarkup(choice)
    expect(html).toContain('bg-primary/10')
    expect(html).toContain('使用项目当前目录')
    expect(html).toContain('已选择')
    expect(html).toContain('当前独立工作区中的修改不会自动带到项目目录。')
  })

  test('仅复制操作写入 AI 返回的完整交接正文', async () => {
    const copy = mock(async (_value: string) => undefined)
    const generated = '## 任务目标\n继续任务\n\n## 已完成工作\n完成主体实现'

    await copyGeneratedHandoffContent(generated, copy)

    expect(copy).toHaveBeenCalledWith(generated)
  })

  test('不可用的 Worktree 卡片保留禁用和未选中状态', () => {
    const choice = HandoffLocationChoice({
      selected: false,
      disabled: true,
      title: '新建独立工作区（Worktree）',
      description: '这个项目目前不能创建 Worktree。',
      onSelect: () => undefined,
    })

    expect(choice.props.disabled).toBe(true)
    expect(choice.props['aria-checked']).toBe(false)
  })
})
