export type AgentImageCommandName = 'image' | 'img' | 'draw'

export type AgentImageCommand =
  | { matched: false }
  | { matched: true; command: AgentImageCommandName; prompt?: string; source?: 'natural' }

const IMAGE_COMMAND_PATTERN = /^\/(image|img|draw)(?=$|\s)([\s\S]*)$/u
const LEADING_USER_CONTEXT_BLOCK_PATTERN = /^\s*<(attached_files|quoted_file|quoted_context)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/u
const IMAGE_GENERATION_TOOL_NAMES = new Set(['imagegen', 'generate_image', 'image_gen'])

/**
 * 移除 AgentView 拼在用户正文前的附件/引用协议块，只用于定位快捷命令。
 * 原始消息不会被修改，后续仍完整交给模型，以便生图工具读取参考图路径。
 */
function stripLeadingUserContextBlocks(text: string): string {
  let remaining = text
  while (true) {
    const match = remaining.match(LEADING_USER_CONTEXT_BLOCK_PATTERN)
    if (!match) return remaining
    remaining = remaining.slice(match[0].length)
  }
}

/** 严格解析位于用户正文开头的 /image、/img 或 /draw 生图命令。 */
export function parseAgentImageCommand(text: string): AgentImageCommand {
  const commandText = stripLeadingUserContextBlocks(text).trim()
  const match = commandText.match(IMAGE_COMMAND_PATTERN)
  if (!match) return { matched: false }

  const prompt = match[2]?.trim()
  return {
    matched: true,
    command: match[1] as AgentImageCommandName,
    ...(prompt ? { prompt } : {}),
  }
}

/**
 * 自然语言只接收本轮正文开头的明确指令；模糊表达继续走普通对话。
 * 不扫描附件、引用或历史，也不改写持久化消息。这里只加强工具引导，不执行图片接口。
 */
export function parseAgentImageRequest(text: string): AgentImageCommand {
  const command = parseAgentImageCommand(text)
  if (command.matched) return command
  const body = stripLeadingUserContextBlocks(text).trim().replace(/^(\*\*\*|\*\*|__)([\s\S]+)\1$/u, '$2').trim()
  if (/[<>`]|^\s*>/u.test(body)) return { matched: false }
  // 咨询、提示词编写、条件请求及明确否定都保守退出，避免将提及生图误当成生成授权。
  if (/(?:先问|确认|稍后|收费|费用|支持|会不会|要不要|是什么|什么意思|提示词|为什么|为何|怎么|如何|能否|能不能|是否|如果|假如|示例|举例|比如|例如|翻译|引用|转述|解释|分析|讨论|教程|方法|步骤|指令|命令|异常|无响应|不工作|不行|有问题|出错|错误|没反应|不出来|报错|失败|mermaid|svg|echarts)/iu.test(body)) return { matched: false }
  if (/(?:不|别|勿|无需|不用|不要|暂缓|停止|取消)[^。！？\n]{0,16}(?:生图|生成|制作|画|图片|图像|概念图|效果图)/u.test(body)) return { matched: false }
  if (/(?:需要多久|什么时候|以后|明天|下次|可以吗|可不可以|吗)|(?:图片|图像|图)的?(?:功能|按钮|接口|代码|文案)/u.test(body)) return { matched: false }
  const request = /^(?:请|麻烦|帮我|请帮我|给我)?\s*(?:直接|立即|现在|先)?\s*(?:生图(?:\s|给|看|让|[，,。！？!?：:]|$)|(?:生成|制作|绘制)(?:一张|一幅|个|一份)?[^。！？!?\n，,；;：:]{0,80}(?:图片|图像|插画|概念图|效果图|海报)|画(?:一张|一幅|个图|张图|幅图))/u
  if (!request.test(body)) return { matched: false }
  return { matched: true, command: 'image', prompt: body, source: 'natural' }
}

/** 判断 Pi 本轮实际注入的工具中，哪些可用于图片生成或编辑。 */
export function collectAvailableAgentImageToolNames(tools: readonly unknown[]): string[] {
  const names = new Set<string>()
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !('name' in tool) || typeof tool.name !== 'string') continue
    const normalized = tool.name.trim().toLowerCase()
    const leafName = normalized.split(/(?:__|[./:])/u).at(-1)
    if (IMAGE_GENERATION_TOOL_NAMES.has(normalized) || (leafName && IMAGE_GENERATION_TOOL_NAMES.has(leafName))) {
      names.add(tool.name)
    }
  }
  return [...names]
}

interface BuildAgentImageCommandPromptInput {
  command: Extract<AgentImageCommand, { matched: true }>
  enrichedMessage: string
  availableToolNames?: readonly string[]
}

/**
 * 命令与明确自然语言请求共用工具引导，用户可见历史仍保存原始消息，
 * 这里只加强发给模型的当轮 Prompt，避免模型只返回提示词而不调用生图工具。
 */
export function buildAgentImageCommandPrompt(input: BuildAgentImageCommandPromptInput): string {
  const { command, enrichedMessage, availableToolNames } = input
  const requestOrigin = command.source === 'natural' ? '用户在本轮明确请求' : '用户通过 /image 明确请求'

  if (!command.prompt) {
    return [
      '<domi_image_command>',
      '用户输入了生图快捷命令，但没有提供图片描述。不要调用生图工具。',
      '请直接给出简短用法提示：`/image 一只戴宇航头盔的橘猫，电影海报风格`。',
      '</domi_image_command>',
      '',
      enrichedMessage,
    ].join('\n')
  }

  if (availableToolNames === undefined) {
    return [
      '<domi_image_command>',
      `${requestOrigin}生成或编辑图片；当前活跃会话的工具集仍在初始化。`,
      '工具集就绪后，优先调用实际可用的生图工具完成请求，不要只返回提示词或操作说明。',
      '若最终没有可用生图工具，请说明需要前往 Domi 的 AI 工具设置，在图片生成中选择已配置的渠道与模型（或完善旧版 GPT Image / Nano Banana 配置）；不要声称图片已经生成。',
      '</domi_image_command>',
      '',
      enrichedMessage,
    ].join('\n')
  }

  if (availableToolNames.length === 0) {
    return [
      '<domi_image_command>',
      `${requestOrigin}生成或编辑图片，但当前会话没有可用的生图工具。`,
      '不要声称图片已经生成，也不要只返回一段可复制的图片提示词来假装完成。',
      '请直接说明需要前往 Domi 的 AI 工具设置，在图片生成中选择已配置的渠道与模型（或完善旧版 GPT Image / Nano Banana 配置） 后重试。',
      '</domi_image_command>',
      '',
      enrichedMessage,
    ].join('\n')
  }

  return [
    '<domi_image_command>',
    `${requestOrigin}生成或编辑图片。你必须调用下列当前可用的生图工具完成请求，不要只返回提示词或操作说明：`,
    ...availableToolNames.map((name) => `- ${name}`),
    '若原始消息包含 <attached_files> 中的图片，请把对应本地路径作为参考图传给生图工具；没有参考图时执行文生图。',
    '默认使用 outputMode=session，只生成会话附件；只有用户明确要求把图片保存到项目或供项目代码引用时才使用 outputMode=workspace。',
    '只有工具结果 isError 不为 true 且实际返回至少一张图片时，才能说明生成完成；工具被拒绝、失败或没有图片时必须如实说明，不能声称已生成。',
    '</domi_image_command>',
    '',
    enrichedMessage,
  ].join('\n')
}
