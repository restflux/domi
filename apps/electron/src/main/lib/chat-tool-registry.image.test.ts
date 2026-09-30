import { expect, mock, test } from 'bun:test'

mock.module('./chat-tool-config', () => ({ getChatToolsConfig: () => ({ toolStates: {}, toolCredentials: {}, customTools: [] }) }))
mock.module('./image-generation/config', () => ({ getImageGenerationToolId: (selection: { modelId: string }) => selection.modelId.startsWith('gemini') ? 'nano-banana' : 'gpt-image' }))
mock.module('./chat-tools/web-search-tool', () => ({ WEB_SEARCH_TOOL_META: { id: 'web-search' }, WEB_SEARCH_TOOL_DEFINITIONS: [{ name: 'web-search' }], isWebSearchAvailable: () => true }))
mock.module('./chat-tools/agent-recommend-tool', () => ({ AGENT_RECOMMEND_TOOL_META: { id: 'agent-recommend' }, AGENT_RECOMMEND_TOOL_DEFINITIONS: [], isAgentRecommendAvailable: () => false }))
mock.module('./chat-tools/gpt-image-tool', () => ({ GPT_IMAGE_TOOL_META: { id: 'gpt-image' }, GPT_IMAGE_TOOL_DEFINITIONS: [{ name: 'imagegen' }], isGptImageAvailable: () => true }))
mock.module('./chat-tools/nano-banana-tool', () => ({ NANO_BANANA_TOOL_META: { id: 'nano-banana' }, NANO_BANANA_TOOL_DEFINITIONS: [{ name: 'generate_image' }], isNanoBananaAvailable: () => true }))
const { getEnabledTools } = await import('./chat-tool-registry')

test('普通消息即使生图渠道可用也不注入生图工具，普通工具仍由用户选择控制', () => {
  expect(getEnabledTools([]).tools).toBeUndefined()
  expect(getEnabledTools(['web-search']).tools?.map((tool) => tool.name)).toContain('web-search')
})
test('明确生图请求后只暴露对应协议的生图工具', () => {
  expect(getEnabledTools([], { channelId: 'images', modelId: 'gpt-image-2.5-flare' }, true).tools?.map((tool) => tool.name)).toEqual(['imagegen'])
  expect(getEnabledTools([], { channelId: 'images', modelId: 'gemini-3.1-flash-image' }, true).tools?.map((tool) => tool.name)).toEqual(['generate_image'])
})
