export type AgentImageCommandName = 'image' | 'img' | 'draw'

export type AgentImageCommand =
  | { matched: false }
  | { matched: true; command: AgentImageCommandName; prompt?: string }

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
 * 把快捷命令转换为宿主级明确意图。用户可见历史仍保存原始 /image 文本，
 * 这里只加强发给模型的当轮 Prompt，避免模型只返回提示词而不调用生图工具。
 */
export function buildAgentImageCommandPrompt(input: BuildAgentImageCommandPromptInput): string {
  const { command, enrichedMessage, availableToolNames } = input

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
      '用户通过 /image 明确请求生成或编辑图片；当前活跃会话的工具集仍在初始化。',
      '工具集就绪后，优先调用实际可用的生图工具完成请求，不要只返回提示词或操作说明。',
      '若最终没有可用生图工具，请说明需要前往 Domi 的 AI 工具设置，配置并开启 GPT Image 或 Nano Banana；不要声称图片已经生成。',
      '</domi_image_command>',
      '',
      enrichedMessage,
    ].join('\n')
  }

  if (availableToolNames.length === 0) {
    return [
      '<domi_image_command>',
      '用户通过 /image 明确请求生成或编辑图片，但当前会话没有可用的生图工具。',
      '不要声称图片已经生成，也不要只返回一段可复制的图片提示词来假装完成。',
      '请直接说明需要前往 Domi 的 AI 工具设置，配置并开启 GPT Image 或 Nano Banana 后重试。',
      '</domi_image_command>',
      '',
      enrichedMessage,
    ].join('\n')
  }

  return [
    '<domi_image_command>',
    '用户通过 /image 明确请求生成或编辑图片。你必须调用下列当前可用的生图工具完成请求，不要只返回提示词或操作说明：',
    ...availableToolNames.map((name) => `- ${name}`),
    '若原始消息包含 <attached_files> 中的图片，请把对应本地路径作为参考图传给生图工具；没有参考图时执行文生图。',
    '默认使用 outputMode=session，只生成会话附件；只有用户明确要求把图片保存到项目或供项目代码引用时才使用 outputMode=workspace。',
    '只有工具结果 isError 不为 true 且实际返回至少一张图片时，才能说明生成完成；工具被拒绝、失败或没有图片时必须如实说明，不能声称已生成。',
    '</domi_image_command>',
    '',
    enrichedMessage,
  ].join('\n')
}
