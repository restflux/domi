import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testRoot = join(tmpdir(), `domi-system-prompts-${process.pid}`)
const configPath = join(testRoot, 'system-prompts.json')

mock.module('./config-paths', () => ({
  getSystemPromptsPath: () => configPath,
}))

const {
  createSystemPrompt,
  getEffectiveWorkSystemPrompt,
  getSystemPromptConfig,
  updateWorkPromptActivation,
} = await import('./system-prompt-manager')

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true })
  mkdirSync(testRoot, { recursive: true })
})

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true })
})

describe('Work 系统提示词配置', () => {
  test('Given 首次使用 When 读取配置 Then 同时提供 Chat 默认提示词和启用的 Work 内置示例', () => {
    const config = getSystemPromptConfig()

    expect(config.prompts.some((prompt) => prompt.scope === 'chat' && prompt.isBuiltin)).toBe(true)
    expect(config.prompts.some((prompt) => prompt.scope === 'work' && prompt.isBuiltin)).toBe(true)
    expect(config.enabledWorkPromptIds).toEqual(['builtin-work-product-delivery'])
    expect(getEffectiveWorkSystemPrompt()).toContain('产品界面与开发交付边界')
  })

  test('Given 旧版 Chat 配置 When 读取 Then 旧提示词归入 Chat 且默认启用 Work 内置示例', () => {
    writeFileSync(configPath, JSON.stringify({
      prompts: [{
        id: 'legacy-chat',
        name: '旧提示词',
        content: 'legacy',
        isBuiltin: false,
        createdAt: 1,
        updatedAt: 1,
      }],
      defaultPromptId: 'legacy-chat',
      appendDateTimeAndUserName: false,
    }), 'utf-8')

    const config = getSystemPromptConfig()
    const legacy = config.prompts.find((prompt) => prompt.id === 'legacy-chat')

    expect(legacy?.scope).toBe('chat')
    expect(config.defaultPromptId).toBe('legacy-chat')
    expect(config.enabledWorkPromptIds).toEqual(['builtin-work-product-delivery'])
  })

  test('Given 单选版 Work 配置 When 迁移 Then 保留原来的生效状态', () => {
    writeFileSync(configPath, JSON.stringify({
      prompts: [{
        id: 'legacy-work',
        name: '旧 Work 提示词',
        content: '旧规则',
        scope: 'work',
        isBuiltin: false,
        createdAt: 1,
        updatedAt: 1,
      }],
      defaultWorkPromptId: 'legacy-work',
      workPromptEnabled: true,
      appendDateTimeAndUserName: true,
    }), 'utf-8')

    expect(getSystemPromptConfig().enabledWorkPromptIds).toEqual(['legacy-work'])
    expect(getEffectiveWorkSystemPrompt()).toBe('旧规则')
  })

  test('Given 单选版 Work 配置已关闭 When 迁移 Then 不启用任何 Work 提示词', () => {
    writeFileSync(configPath, JSON.stringify({
      prompts: [],
      defaultWorkPromptId: 'builtin-work-product-delivery',
      workPromptEnabled: false,
      appendDateTimeAndUserName: true,
    }), 'utf-8')

    expect(getSystemPromptConfig().enabledWorkPromptIds).toEqual([])
    expect(getEffectiveWorkSystemPrompt()).toBeUndefined()
  })

  test('Given 多条 Work 提示词已启用 When 解析 Then 按列表顺序合并非空内容', () => {
    const first = createSystemPrompt({
      name: '第一条',
      content: '第一条规则',
      scope: 'work',
    })
    const second = createSystemPrompt({
      name: '第二条',
      content: '第二条规则',
      scope: 'work',
    })

    updateWorkPromptActivation('builtin-work-product-delivery', false)
    updateWorkPromptActivation(first.id, true)
    updateWorkPromptActivation(second.id, true)

    const content = getEffectiveWorkSystemPrompt()
    expect(content).toBe('第一条规则\n\n第二条规则')
    expect(content!.indexOf(first.content)).toBeLessThan(content!.indexOf(second.content))
  })

  test('Given Work 提示词逐条切换 When 解析 Then 只合并已启用项', () => {
    const created = createSystemPrompt({
      name: '我的 Work 规则',
      content: '只把开发说明写入交付报告。',
      scope: 'work',
    })

    expect(getSystemPromptConfig().enabledWorkPromptIds).not.toContain(created.id)
    updateWorkPromptActivation(created.id, true)
    expect(getEffectiveWorkSystemPrompt()).toContain('只把开发说明写入交付报告。')

    updateWorkPromptActivation(created.id, false)
    expect(getEffectiveWorkSystemPrompt()).not.toContain('只把开发说明写入交付报告。')

    updateWorkPromptActivation('builtin-work-product-delivery', false)
    expect(getEffectiveWorkSystemPrompt()).toBeUndefined()
  })
})
