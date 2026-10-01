import { expect, test } from 'bun:test'
import { claimSideChatLaunch, registerSideChatLaunch, SIDE_CHAT_BOUNDARY_PROMPT, SIDE_CHAT_BOUNDARY_MESSAGE } from './policy'

test('每轮启动由宿主一次性登记，父子标识不能错配或重放', () => {
  const input = {}
  expect(claimSideChatLaunch('child', 'parent', input)).toBe(false)
  const release = registerSideChatLaunch('child', 'parent', input)
  expect(claimSideChatLaunch('child', 'other', input)).toBe(false)
  expect(claimSideChatLaunch('child', 'parent', {})).toBe(false)
  expect(claimSideChatLaunch('child', 'parent', input)).toBe(true)
  expect(claimSideChatLaunch('child', 'parent', input)).toBe(false)
  release()
})

test('完整会话边界：提示词附录与 fork 边界指令同语义约束，不再限制工具', () => {
  // ZCode 对齐：侧聊是完整会话，能力边界靠指令而不是工具白名单。
  expect(SIDE_CHAT_BOUNDARY_PROMPT).toContain('只回答用户在本侧聊中提出的新问题')
  expect(SIDE_CHAT_BOUNDARY_PROMPT).toContain('未经用户在本侧聊中明确要求，不要修改工作区')
  expect(SIDE_CHAT_BOUNDARY_PROMPT).not.toContain('只能使用提供的只读工具')
  expect(SIDE_CHAT_BOUNDARY_MESSAGE).toContain('仅供参考')
  expect(SIDE_CHAT_BOUNDARY_MESSAGE).toContain('遵守权限审批')
})
