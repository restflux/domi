import { describe, expect, test } from 'bun:test'
import {
  buildAgentImageCommandPrompt,
  collectAvailableAgentImageToolNames,
  parseAgentImageCommand,
} from './agent-image-command'

describe('parseAgentImageCommand', () => {
  const commandCases = [
    ['/image 一只戴宇航头盔的橘猫', 'image', '一只戴宇航头盔的橘猫'],
    ['/img 复古旅行海报', 'img', '复古旅行海报'],
    ['/draw\n白底产品摄影\n主体居中', 'draw', '白底产品摄影\n主体居中'],
  ] as const

  test.each(commandCases)('Given 生图快捷命令 %j When 解析 Then 提取命令和图片描述', (text, command, prompt) => {
    expect(parseAgentImageCommand(text)).toEqual({ matched: true, command, prompt })
  })

  test('Given 图片附件位于命令前 When 解析 Then 仍识别正文中的 /image', () => {
    const text = [
      '<attached_files>',
      '- reference.png: C:\\tmp\\reference.png',
      '</attached_files>',
      '',
      '<quoted_context>',
      '保留原图构图',
      '</quoted_context>',
      '',
      '/image 改成蓝色夜景',
    ].join('\n')

    expect(parseAgentImageCommand(text)).toEqual({
      matched: true,
      command: 'image',
      prompt: '改成蓝色夜景',
    })
  })

  test.each(['/image', ' /img  ', '/draw\n'])('Given 命令后没有描述 %j When 解析 Then 标记为空描述', (text) => {
    const parsed = parseAgentImageCommand(text)
    expect(parsed.matched).toBe(true)
    expect(parsed.matched && parsed.prompt).toBeUndefined()
  })

  test.each(['/images cat', '/imagefoo cat', '请执行 /image cat', ''])('Given 非快捷命令 %j When 解析 Then 不匹配', (text) => {
    expect(parseAgentImageCommand(text)).toEqual({ matched: false })
  })
})

describe('collectAvailableAgentImageToolNames', () => {
  test('Given 本轮注入普通、Domi MCP 与无关工具 When 收集生图工具 Then 只返回可生成图片的工具名', () => {
    expect(collectAvailableAgentImageToolNames([
      { name: 'mcp__gpt_image__imagegen' },
      { name: 'mcp__nano_banana__generate_image' },
      { name: 'image_gen' },
      { name: 'Read' },
      null,
    ])).toEqual([
      'mcp__gpt_image__imagegen',
      'mcp__nano_banana__generate_image',
      'image_gen',
    ])
  })
})

describe('buildAgentImageCommandPrompt', () => {
  test('Given 已有生图工具和图片描述 When 构建 Prompt Then 强制调用可用工具并保留原消息', () => {
    const prompt = buildAgentImageCommandPrompt({
      command: { matched: true, command: 'image', prompt: '极简风应用图标' },
      enrichedMessage: '<attached_files>\n- ref.png: C:\\tmp\\ref.png\n</attached_files>\n\n/image 极简风应用图标',
      availableToolNames: ['mcp__gpt_image__imagegen'],
    })

    expect(prompt).toContain('mcp__gpt_image__imagegen')
    expect(prompt).toContain('必须调用')
    expect(prompt).toContain('参考图')
    expect(prompt).toContain('outputMode=session')
    expect(prompt).toContain('实际返回至少一张图片')
    expect(prompt).toContain('/image 极简风应用图标')
  })

  test('Given 活跃会话仍在初始化工具 When 构建 Prompt Then 要求按最终工具集生成或明确提示配置', () => {
    const prompt = buildAgentImageCommandPrompt({
      command: { matched: true, command: 'image', prompt: '一只猫' },
      enrichedMessage: '/image 一只猫',
      availableToolNames: undefined,
    })

    expect(prompt).toContain('工具集仍在初始化')
    expect(prompt).toContain('优先调用实际可用的生图工具')
    expect(prompt).toContain('若最终没有可用生图工具')
  })

  test('Given 没有可用生图工具 When 构建 Prompt Then 要求说明配置入口且不得伪装成功', () => {
    const prompt = buildAgentImageCommandPrompt({
      command: { matched: true, command: 'image', prompt: '一只猫' },
      enrichedMessage: '/image 一只猫',
      availableToolNames: [],
    })

    expect(prompt).toContain('当前会话没有可用的生图工具')
    expect(prompt).toContain('GPT Image')
    expect(prompt).toContain('Nano Banana')
    expect(prompt).toContain('不要声称图片已经生成')
  })

  test('Given 未填写图片描述 When 构建 Prompt Then 返回用法引导且不调用工具', () => {
    const prompt = buildAgentImageCommandPrompt({
      command: { matched: true, command: 'image' },
      enrichedMessage: '/image',
      availableToolNames: ['mcp__nano_banana__generate_image'],
    })

    expect(prompt).toContain('没有提供图片描述')
    expect(prompt).toContain('/image 一只戴宇航头盔的橘猫')
    expect(prompt).toContain('不要调用生图工具')
  })
})
