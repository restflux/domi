import { describe, expect, test } from 'bun:test'
import { buildHelpCard, buildWorkspaceListCard } from './feishu-message'

describe('飞书机器人项目选择引导', () => {
  test('Given 尚未开始对话 When 查看帮助 Then 明确提示可先选择项目', () => {
    const cardText = JSON.stringify(buildHelpCard())

    expect(cardText).toContain('对话前查看或选择项目')
    expect(cardText).toContain('首次对话前可先用 /workspace 选择项目')
  })

  test('Given 已配置机器人默认项目 When 对话前列出项目 Then 标记当前选择并给出选择命令', () => {
    const cardText = JSON.stringify(buildWorkspaceListCard([
      { index: 1, name: '项目 A', isCurrent: false },
      { index: 2, name: '项目 B', isCurrent: true },
    ]))

    expect(cardText).toContain('项目 B（当前）')
    expect(cardText).toContain('对话前可使用 /workspace <序号或名称> 选择项目')
  })
})
