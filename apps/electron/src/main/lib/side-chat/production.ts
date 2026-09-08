import { randomUUID } from 'node:crypto'
import { appendSDKMessages, createAgentSession, getAgentSessionMeta, getAgentSessionSDKMessages, listAgentSessions, updateAgentSessionMeta } from '../agent-session-manager'
import { bindProductionAgentSessionTargetForLaunch, resolveProductionAgentSessionTarget } from '../agent-session-target'
import { assertEnabledModelForChannel, listEnabledAgentModelsForChannel } from '../agent-model-selection'
import { isRegisteredAgentActive, runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import { SideChatService } from './service'

export const sideChatService = new SideChatService({
  getSession: getAgentSessionMeta, listSessions: listAgentSessions, messages: getAgentSessionSDKMessages,
  createChild(parent) {
    // 首次发送前不固化父模型：打开后主模型改变仍可跟随。
    const child = createAgentSession('侧聊', undefined, parent.workspaceId)
    return updateAgentSessionMeta(child.id, {
      parentSessionId: parent.id, rootSessionId: parent.rootSessionId ?? parent.id,
      sideChatParentSessionId: parent.id, workflow: 'read-only',
    })!
  },
  updateModel: (id, channelId, modelId) => { updateAgentSessionMeta(id, { channelId, modelId: modelId ?? listEnabledAgentModelsForChannel(channelId, '侧聊').models[0]?.id }) },
  async bindTarget(sessionId, parentSessionId) {
    const child = getAgentSessionMeta(sessionId)
    if (!child?.sessionTarget || child.sessionTarget.kind === 'unselected') {
      await bindProductionAgentSessionTargetForLaunch({ sessionId, choice: { kind: 'inherit', parentSessionId } })
    }
    const [parentTarget, childTarget] = await Promise.all([
      resolveProductionAgentSessionTarget({ sessionId: parentSessionId }),
      resolveProductionAgentSessionTarget({ sessionId }),
    ])
    if (parentTarget.cwd !== childTarget.cwd) throw new Error('主会话的工作目录已变化；当前侧聊仍保留原工作目录，不能将旧目录内容当作当前任务读取。')
  },
  validateModel(channelId, modelId) {
    const available = listEnabledAgentModelsForChannel(channelId, '侧聊')
    if (!available.models.length) throw new Error('所选渠道没有启用的模型')
    assertEnabledModelForChannel({ channelId, modelId, purpose: '侧聊' })
  },
  run: runRegisteredHeadlessAgent,
  stop: id => stopRegisteredAgent(id, 'renderer-stop-control'),
  isActive: isRegisteredAgentActive,
  recordError(id, message) {
    appendSDKMessages(id, [{ type: 'assistant', parent_tool_use_id: null, uuid: randomUUID(), message: { content: [{ type: 'text', text: `侧聊未能完成：${message}` }] } }])
  },
})
