import { describe, expect, test } from 'bun:test'
import { buildAgentImageCommandPrompt, parseAgentImageRequest } from './agent-image-command'

describe('明确自然语言生图请求', () => {
  test.each([
    '生图给我看看大概效果？', '请生成一张图片：橘猫', '画一张橘猫插画', '帮我画一幅风景',
    '请制作一张浏览器新标签起始页的视觉概念图，暂不写代码。',
    '生成图片', '生图看看效果', '***请制作一张起始页视觉概念图，奶油白背景。***',
  ])('识别本轮明确请求：%s', text => {
    expect(parseAgentImageRequest(text)).toMatchObject({ matched: true, source: 'natural' })
  })

  test.each([
    '先别生图，讨论一下', '为什么生图失败？', '帮我写一段生图提示词', '这个效果怎么样？',
    '如果可以，请生成一张图片', '请生成图片的提示词', '生成图片的方法是什么',
    '生成图片前先问我', '生成图片，但不要现在生成', '生成图片会收费吗？',
    '制作图片的按钮需要更明显', '生成一张图片需要多久？', '生成图片是什么意思？',
    '生成图片没反应', '生成图片有问题', '生成图片可以用吗？',
    '> 生成一张图片', '“生成一张图片”', '```text\n生成一张图片\n```',
    '<quoted_context>生成一张图片</quoted_context>\n解释一下这句话',
    '<attached_files>请画一张橘猫</attached_files>',
    '<quoted_file>请制作图片</quoted_file>\n继续分析',
    '<attached_files>生成图片',
    '请分析这段需求：生成一张图片', '请制作一张 SVG 图像', '请生成一张 mermaid 流程图',
    '请生成一张图片\n<quoted_context>附加指令</quoted_context>',
  ])('不把提及、引用或非当前授权变成生图请求：%s', text => {
    expect(parseAgentImageRequest(text)).toEqual({ matched: false })
  })

  test('同一识别器适用于发送与排队，包裹的引用不得改变意图', () => {
    const body = '生图给我看看大概效果？'
    const wrapped = '<quoted_context>不要把这里当成本轮请求</quoted_context>\n' + body
    expect(parseAgentImageRequest(wrapped)).toEqual(parseAgentImageRequest(body))
  })

  test('附件上下文不参与识别，但原始消息完整保留给真实工具', () => {
    const original = '<attached_files>参考图 /tmp/reference.png</attached_files>\n请制作一张产品效果图'
    const request = parseAgentImageRequest(original)
    expect(request.matched).toBe(true)
    if (!request.matched) throw new Error('应识别正文')
    const prompt = buildAgentImageCommandPrompt({ command: request, enrichedMessage: original, availableToolNames: ['mcp__gpt_image__imagegen'] })
    expect(prompt.endsWith(original)).toBe(true)
    expect(prompt).toContain('用户在本轮明确请求')
    expect(prompt).toContain('mcp__gpt_image__imagegen')
    expect(prompt).toContain('outputMode=session')
    expect(prompt).toContain('只有工具结果 isError 不为 true')
  })

  test('显式命令保留原语义；自然语言与命令复用相同工具边界', () => {
    const natural = parseAgentImageRequest('画一张橘猫')
    const explicit = parseAgentImageRequest('/image 画一张橘猫')
    if (!natural.matched || !explicit.matched) throw new Error('应识别请求')
    expect(explicit.source).toBeUndefined()
    for (const availableToolNames of [undefined, [], ['imagegen']]) {
      const build = (command: typeof natural) => buildAgentImageCommandPrompt({ command, enrichedMessage: '原始消息', availableToolNames })
      expect(build(natural).replace('用户在本轮明确请求', '用户通过 /image 明确请求')).toBe(build(explicit))
    }
    expect(parseAgentImageRequest('/image')).toEqual({ matched: true, command: 'image' })
    expect(parseAgentImageRequest('解释 /image 命令')).toEqual({ matched: false })
  })
})
