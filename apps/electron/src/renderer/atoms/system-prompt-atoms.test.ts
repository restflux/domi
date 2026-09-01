import { describe, expect, test } from 'bun:test'
import type { SystemPromptConfig } from '@domi/shared'
import { resolveSystemMessage } from './system-prompt-atoms'

const config: SystemPromptConfig = {
  prompts: [
    {
      id: 'chat-prompt',
      name: 'Chat',
      content: 'chat content',
      scope: 'chat',
      isBuiltin: false,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'work-prompt',
      name: 'Work',
      content: 'work content',
      scope: 'work',
      isBuiltin: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  defaultPromptId: 'chat-prompt',
  enabledWorkPromptIds: ['work-prompt'],
  appendDateTimeAndUserName: false,
}

describe('Chat 系统提示词解析', () => {
  test('Given Chat 提示词 When 解析 system message Then 返回 Chat 内容', () => {
    expect(resolveSystemMessage('chat-prompt', config, '测试用户')).toBe('chat content')
  })

  test('Given Work 提示词 ID When 解析 Chat system message Then Work 内容不会进入 Chat', () => {
    expect(resolveSystemMessage('work-prompt', config, '测试用户')).toBeUndefined()
  })
})
