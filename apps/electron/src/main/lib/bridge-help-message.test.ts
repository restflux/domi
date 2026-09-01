import { describe, expect, test } from 'bun:test'
import { formatBridgeHelpMessage } from './bridge-help-message'

const EXPECTED_COMMANDS = [
  '/now',
  '/stop', '/s',
  '/new', '/n',
  '/list', '/ls',
  '/switch', '/sw',
  '/workspace', '/ws',
  '/model', '/m',
  '/help', '/h',
]

describe('formatBridgeHelpMessage', () => {
  test('保留全部命令、简写和首次项目选择引导', () => {
    const message = formatBridgeHelpMessage()

    for (const command of EXPECTED_COMMANDS) {
      expect(message).toContain(command)
    }
    expect(message).toContain('首次使用可先发送 /workspace 选择项目。')
  })

  test('高频任务在前，并按任务、会话、项目、模型、帮助排序', () => {
    const message = formatBridgeHelpMessage()
    const sectionNames = ['【任务】', '【会话】', '【项目】', '【模型】', '【帮助】']
    const positions = sectionNames.map((section) => message.indexOf(section))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(message.indexOf('/now')).toBeLessThan(message.indexOf('/new'))
    expect(message.indexOf('/stop')).toBeLessThan(message.indexOf('/new'))
  })

  test('去除换行后仍保留分组和命令间分隔', () => {
    const compact = formatBridgeHelpMessage().replace(/\s+/g, '')

    expect(compact).toContain('【任务】/now当前状态·/stop(/s)停止任务')
    expect(compact).toContain('【会话】/new(/n)[标题]新建·/list(/ls)查看列表·/switch(/sw)<序号>切换')
    expect(compact).toContain('【项目】/workspace(/ws)[名称]查看或选择')
    expect(compact).toContain('【模型】/model(/m)[渠道][模型]查看或切换')
    expect(compact).toContain('【帮助】/help(/h)')
  })
})
