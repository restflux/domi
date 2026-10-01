import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createStore } from 'jotai'
import { agentDiffPanelTabAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { openSideChatPanelAtom, sideChatVisibleMapAtom, sideChatHandoffAtomFamily, sideChatDraftAtomFamily, sideChatPendingForceNewAtom, sideChatPendingFocusAtom } from '@/atoms/side-chat-atoms'
import { rightWorkspaceSessionStateMapAtom } from '@/atoms/right-workspace-atoms'
import { sideChatHandoffPrompt, sideChatSendInput } from './side-chat-behavior'

describe('ZCode 式侧聊面板', () => {
  test('面板复用 AgentMessages 与主输入区形态，按子会话单视图渲染', () => {
    const source = readFileSync(new URL('./SideChatPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('AgentMessages')
    expect(source).toContain('AgentSessionProvider')
    // 完整会话：面板内直接审批权限/问答
    expect(source).toContain('PermissionBanner sessionId={childSessionId}')
    expect(source).toContain('AskUserBanner sessionId={childSessionId}')
    // 主输入区同款组件与容器形态；窄栏仅图标/紧凑控件，无独立上传按钮
    expect(source).toContain('InputToolbarOverflow')
    expect(source).toContain('ExecutionControls sessionId={childSessionId}')
    expect(source).toContain('agent-composer-surface')
    expect(source).toContain('collapsible')
    expect(source).toContain('enableMentions')
    expect(source).toContain('onPasteFiles={(files) => void addImages(files)}')
    expect(source).not.toContain('type="file"')
    expect(source).not.toContain('ImagePlus')
    // 不引入附言/队列、语音、上下文徽章等文字型或低频控件
    expect(source).not.toContain('SpeechButton')
    expect(source).not.toContain('ContextUsageBadge')
    expect(source).not.toContain('AgentThinkingPopover')
    // 引用 chips 与限流提示；空时间线用紧凑提示替代欢迎屏
    expect(source).toContain('待发送引用')
    expect(source).toContain('最多同时引用 8 段内容')
    expect(source).toContain('已继承主对话上下文')
    // 无内部 tab 行、无新开入口、无只读提示
    expect(source).not.toContain('新开侧聊')
    expect(source).not.toContain('侧聊 {index + 1}')
    expect(source).not.toContain('只读 ·')
    expect(source).toContain('<RichTextInput')
  })

  test('打开入口聚焦面板、登记 forceNew 与聚焦意图，由工作区同步器消费', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(openSideChatPanelAtom, { parentSessionId: 'a' })
    expect(store.get(sideChatVisibleMapAtom).get('a')).toBe(true)
    expect(store.get(agentDiffPanelTabAtom).get('a')).toBe('chat')
    expect(store.get(rightWorkspaceSessionStateMapAtom).get('a')?.activeTool).toBe('side-chat')
    expect(store.get(sideChatPendingFocusAtom).get('a')).toBe(true)
    expect(store.get(sideChatPendingForceNewAtom).get('a')).toBeUndefined()
    store.set(openSideChatPanelAtom, { parentSessionId: 'a', forceNew: true })
    expect(store.get(sideChatPendingForceNewAtom).get('a')).toBe(true)
    // 多开实例 tab 由右侧工作区标签条承载（right-workspace-model）。
    const model = readFileSync(new URL('../../../lib/right-workspace-model.ts', import.meta.url), 'utf8')
    expect(model).toContain('side-chat:${string}')
    expect(model).toContain('export function sideChatTabId')
  })

  test('handoff 只交正文包装后的文本，草稿与发送负载按子会话隔离', () => {
    expect(sideChatHandoffPrompt('  建议检查边界  ')).toContain('请判断以下侧聊建议是否适合当前任务')
    const store = createStore()
    store.set(sideChatDraftAtomFamily('child-1'), { text: '第一问', model: { channelId: 'c1', modelId: 'm1' }, focusRevision: 0 })
    store.set(sideChatDraftAtomFamily('child-2'), { text: '第二问', model: null, focusRevision: 0 })
    store.set(sideChatHandoffAtomFamily('parent'), { send: async () => {} })
    const payload = sideChatSendInput('parent', 'child-1', store.get(sideChatDraftAtomFamily('child-1')))
    expect(payload).toEqual({ parentSessionId: 'parent', childSessionId: 'child-1', message: '第一问', channelId: 'c1', modelId: 'm1' })
    const bare = sideChatSendInput('parent', 'child-2', store.get(sideChatDraftAtomFamily('child-2')))
    expect(bare).toEqual({ parentSessionId: 'parent', childSessionId: 'child-2', message: '第二问' })
  })
})
