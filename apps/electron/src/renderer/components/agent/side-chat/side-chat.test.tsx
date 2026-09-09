import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentChannelIdAtom, agentModelIdAtom, agentSidePanelOpenAtom, agentDiffPanelTabAtom } from '@/atoms/agent-atoms'
import { agentSideChatMapAtom } from '@/atoms/chat-atoms'
import { openSideChatPanelAtom, sideChatDraftAtomFamily, sideChatViewAtomFamily, sideChatVisibleMapAtom, sideChatHandoffAtomFamily } from '@/atoms/side-chat-atoms'
import { rightWorkspaceSessionStateMapAtom } from '@/atoms/right-workspace-atoms'
import { sideChatTextMessages, sideChatHandoffPrompt, sideChatSendInput } from './side-chat-behavior'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SideChatMessage } from './SideChatMessage'
import type { SDKMessage } from '@domi/shared'

const answer: SDKMessage = { type: 'assistant', parent_tool_use_id: null, uuid: 'answer', message: { content: [{ type: 'thinking', thinking: '不可转交的内部思考' }, { type: 'text', text: '建议检查边界。' }] } }

describe('Work 侧聊', () => {
  test('历史回答显示自身记录模型，不把当前选择套到旧消息上', () => {
    const historical: SDKMessage = { ...answer, message: { model: 'old-model', content: [{ type: 'text', text: '旧回答' }] } }
    expect(sideChatTextMessages([historical])[0]?.modelId).toBe('old-model')
    expect(sideChatTextMessages([answer])[0]?.modelId).toBeUndefined()
  })
  test('用户消息复用身份展示和复制，不显示转交操作', () => {
    const html = renderToStaticMarkup(<TooltipProvider><SideChatMessage role="user" text="我的问题" handoffDisabled={false} onHandoff={() => {}} onError={() => {}} /></TooltipProvider>)
    expect(html).toContain('我的问题')
    expect(html).toContain('复制')
    expect(html).not.toContain('交给主助手')
  })
  test('仅图片历史仍显示用户消息并复用附件缩略图，不把存储路径当正文', () => {
    const text = '<attached_files>\n- 截图.png: C:/host/child/side-chat-images-1/image.png\n</attached_files>\n'
    const messages: SDKMessage[] = [{ type: 'user', parent_tool_use_id: null, uuid: 'image-only', message: { content: [{ type: 'text', text }] } }]
    expect(sideChatTextMessages(messages)).toHaveLength(1)
    const html = renderToStaticMarkup(<TooltipProvider><SideChatMessage role="user" text={text} handoffDisabled={false} onHandoff={() => {}} onError={() => {}} /></TooltipProvider>)
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('C:/host/child')
    expect(html).not.toContain('编辑图片')
    expect(html).not.toContain('交给主助手')
  })
  test('默认发送不把全局模型固化为覆盖，只传递该父会话明确选定的模型', () => {
    const draft = { text: ' 问题 ', quotedText: '原文', model: null, focusRevision: 0 }
    expect(sideChatSendInput('a', draft)).toEqual({ parentSessionId: 'a', message: '问题', quotedText: '原文' })
    expect(sideChatSendInput('a', { ...draft, model: { channelId: 'custom', modelId: 'other' } })).toEqual({ parentSessionId: 'a', message: '问题', quotedText: '原文', channelId: 'custom', modelId: 'other' })
  })
  test('带引用打开侧聊不发送，并保留输入草稿和旧 Chat 映射', () => {
    const store = createStore()
    store.set(agentSideChatMapAtom, new Map([['parent', 'legacy-chat']]))
    store.set(sideChatDraftAtomFamily('parent'), { text: '我还没写完', quotedText: '', model: null, focusRevision: 0 })
    store.set(openSideChatPanelAtom, { parentSessionId: 'parent', quotedText: '选定正文' })
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentDiffPanelTabAtom).get('parent')).toBe('chat')
    expect(store.get(rightWorkspaceSessionStateMapAtom).get('parent')?.activeTabId).toBe('side-chat')
    expect(store.get(sideChatDraftAtomFamily('parent'))).toEqual({ text: '我还没写完', quotedText: '选定正文', model: null, focusRevision: 1 })
    expect(store.get(sideChatViewAtomFamily('parent'))).toBeNull()
    expect(store.get(agentSideChatMapAtom).get('parent')).toBe('legacy-chat')
  })
  test('父会话间草稿、模型、引用、消息和回传入口互相隔离', () => {
    const store = createStore()
    store.set(sideChatDraftAtomFamily('a'), { text: 'A', quotedText: '引用 A', model: { channelId: 'side', modelId: 'side-model' }, focusRevision: 1 })
    store.set(sideChatViewAtomFamily('a'), { parentSessionId: 'a', sessionId: 'child-a', messages: [answer], isRunning: true })
    store.set(sideChatHandoffAtomFamily('a'), { send: async () => {} })
    store.set(openSideChatPanelAtom, { parentSessionId: 'b' })
    expect(store.get(sideChatDraftAtomFamily('b')).text).toBe('')
    expect(store.get(sideChatDraftAtomFamily('b')).model).toBeNull()
    expect(store.get(sideChatViewAtomFamily('b'))).toBeNull()
    expect(store.get(sideChatHandoffAtomFamily('b'))).toBeNull()
    expect(store.get(sideChatDraftAtomFamily('a')).text).toBe('A')
  })
  test('关闭再打开保留运行中侧聊与草稿，不删除旧问答关联', () => {
    const store = createStore()
    store.set(sideChatViewAtomFamily('a'), { parentSessionId: 'a', sessionId: 'child', messages: [answer], isRunning: true })
    store.set(openSideChatPanelAtom, { parentSessionId: 'a', quotedText: '待询问' })
    store.set(sideChatVisibleMapAtom, new Map([['a', false]]))
    store.set(openSideChatPanelAtom, { parentSessionId: 'a' })
    expect(store.get(sideChatViewAtomFamily('a'))?.isRunning).toBe(true)
    expect(store.get(sideChatDraftAtomFamily('a')).quotedText).toBe('待询问')
  })
  test('回答只包含可见正文，工具结果、系统上下文和 thinking 不进入回传', () => {
    const messages: SDKMessage[] = [answer, { type: 'system', subtype: 'init', text: '系统上下文' }, { type: 'user', parent_tool_use_id: 'tool', message: { content: [{ type: 'text', text: '工具返回' }] } }]
    expect(sideChatTextMessages(messages)).toEqual([{ id: 'answer', role: 'assistant', text: '建议检查边界。' }])
    expect(sideChatHandoffPrompt(sideChatTextMessages(messages)[0]!.text)).toContain('仅在符合原要求时采纳')
    expect(sideChatHandoffPrompt(sideChatTextMessages(messages)[0]!.text)).not.toContain('内部思考')
  })
  test('侧聊复用主消息展示和富文本入口，保留旧记录且不开放主任务能力', () => {
    const store = createStore()
    store.set(agentChannelIdAtom, 'main-channel')
    store.set(agentModelIdAtom, 'main-model')
    store.set(agentSideChatMapAtom, new Map([['a', 'old-chat']]))
    store.set(sideChatViewAtomFamily('a'), { parentSessionId: 'a', sessionId: 'child', messages: [answer], isRunning: false })
    // 富文本编辑器依赖浏览器DOM；SSR只验证共享消息展示，不伪造编辑器运行。
    const html = renderToStaticMarkup(<Provider store={store}><TooltipProvider><SideChatMessage role="assistant" text="建议检查边界。" modelId="main-model" handoffDisabled={false} onHandoff={() => {}} onError={() => {}} /></TooltipProvider></Provider>)
    const panel = readFileSync(new URL('./SideChatPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('查看旧问答记录')
    expect(html).toContain('交给主助手')
    expect(html).toContain('建议检查边界')
    expect(html).toContain('main-model')
    expect(html).toContain('复制')
    expect(html).toContain('message-item')
    expect(panel).toContain('<RichTextInput')
    expect(panel).toContain('enableMentions={false}')
    expect(panel).toContain('key={parentSessionId}')
    expect(panel).not.toContain('<Textarea')
    expect(html).not.toContain('不可转交的内部思考')
    expect(store.get(agentModelIdAtom)).toBe('main-model')
  })
})
