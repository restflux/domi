import { randomUUID } from 'node:crypto'
import { appendSDKMessages, createAgentSession, getAgentSessionMeta, getAgentSessionSDKMessages, listAgentSessions, updateAgentSessionMeta } from '../agent-session-manager'
import { bindProductionAgentSessionTargetForLaunch, resolveProductionAgentSessionTarget } from '../agent-session-target'
import { assertEnabledModelForChannel, listEnabledAgentModelsForChannel } from '../agent-model-selection'
import { isRegisteredAgentActive, runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import { SideChatService } from './service'
import { getChannelById } from '../channel-manager'
import { resolvePiImageInputCapability } from '../adapters/pi-model-registry'
import { getAgentWorkspace } from '../agent-workspace-manager'
import { resolveAgentSessionWorkspacePath } from '../config-paths'
import { saveSideChatImages } from './image-storage'

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
    const selected = modelId ?? available.models[0]!.id
    assertEnabledModelForChannel({ channelId, modelId: selected, purpose: '侧聊' })
    return selected
  },
  async validateImageModel(channelId, modelId) {
    const channel = getChannelById(channelId)
    if (!channel?.enabled) throw new Error('所选渠道不存在或未启用')
    const model = channel.models.find(item => item.id === modelId && item.enabled)
    if (!model) throw new Error('所选模型不存在或未启用')
    const capability = await resolvePiImageInputCapability(channel.provider, model.id, model)
    if (capability === 'unsupported') throw new Error('当前侧聊模型不支持图片，请选择支持图片的模型后重试')
    if (capability === 'unknown') throw new Error('无法确认当前侧聊模型支持图片，请在渠道设置中配置图片输入能力或选择已支持图片的模型')
  },
  saveImages(childId, images) {
    const child = getAgentSessionMeta(childId)
    const parent = child?.sideChatParentSessionId ? getAgentSessionMeta(child.sideChatParentSessionId) : undefined
    const workspace = child?.workspaceId ? getAgentWorkspace(child.workspaceId) : undefined
    if (!child || !parent || !workspace || child.parentSessionId !== parent.id || parent.workspaceId !== child.workspaceId
      || child.independentReviewId || parent.sideChatParentSessionId || parent.sourceDelegationId || parent.independentReviewId) throw new Error('侧聊图片归属无效')
    return saveSideChatImages(resolveAgentSessionWorkspacePath(workspace.slug, child.id), images)
  },
  run: runRegisteredHeadlessAgent,
  stop: id => stopRegisteredAgent(id, 'renderer-stop-control'),
  isActive: isRegisteredAgentActive,
  recordError(id, message) {
    appendSDKMessages(id, [{ type: 'assistant', parent_tool_use_id: null, uuid: randomUUID(), message: { content: [{ type: 'text', text: `侧聊未能完成：${message}` }] } }])
  },
})
