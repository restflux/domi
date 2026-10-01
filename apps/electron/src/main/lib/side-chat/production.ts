import { randomUUID } from 'node:crypto'
import { appendSDKMessages, createAgentSession, deleteAgentSession, getAgentSessionMeta, getAgentSessionSDKMessages, listAgentSessions, pruneSideChatInheritedDisplayHistory, seedSideChatChildFromParent, updateAgentSessionMeta } from '../agent-session-manager'
import { bindProductionAgentSessionTargetForLaunch, resolveProductionAgentSessionTarget } from '../agent-session-target'
import { assertEnabledModelForChannel, listEnabledAgentModelsForChannel } from '../agent-model-selection'
import { isRegisteredAgentActive, runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import { SideChatService } from './service'
import { SIDE_CHAT_BOUNDARY_MESSAGE } from './policy'
import { getChannelById } from '../channel-manager'
import { resolvePiImageInputCapability } from '../adapters/pi-model-registry'
import { getAgentWorkspace } from '../agent-workspace-manager'
import { resolveAgentSessionWorkspacePath } from '../config-paths'
import { saveSideChatImages } from './image-storage'

/** 旧子会话显示历史清洗每进程只跑一次；失败时退出 memo 供下次重试。 */
const prunedDisplayChildren = new Set<string>()

export const sideChatService = new SideChatService({
  getSession: getAgentSessionMeta, listSessions: listAgentSessions,
  messages: (id) => {
    const child = getAgentSessionMeta(id)
    if (child?.sideChatParentSessionId && !prunedDisplayChildren.has(id)) {
      prunedDisplayChildren.add(id)
      try {
        const removed = pruneSideChatInheritedDisplayHistory(id, child.sideChatParentSessionId)
        if (removed > 0) console.log(`[侧聊] 已清除旧子会话 ${id} 继承的 ${removed} 条显示历史（Pi 上下文保留）`)
      } catch (error) {
        prunedDisplayChildren.delete(id)
        console.warn(`[侧聊] 清理旧子会话显示历史失败 (${id}):`, error)
      }
    }
    return getAgentSessionSDKMessages(id)
  },
  createChild(parent) {
    // 创建即继承父会话当前渠道与模型，选择器免手选；后续侧聊内可单独换模型固定。
    const child = createAgentSession('侧聊', parent.channelId, parent.workspaceId, parent.modelId)
    return updateAgentSessionMeta(child.id, {
      parentSessionId: parent.id, rootSessionId: parent.rootSessionId ?? parent.id,
      sideChatParentSessionId: parent.id,
    })!
  },
  async seedChild(childId) {
    const outcome = await seedSideChatChildFromParent(childId, SIDE_CHAT_BOUNDARY_MESSAGE)
    return outcome.forked
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
  async deleteChild(childId) {
    await deleteAgentSession(childId)
  },
  run: runRegisteredHeadlessAgent,
  stop: id => stopRegisteredAgent(id, 'renderer-stop-control'),
  isActive: isRegisteredAgentActive,
  recordError(id, message) {
    appendSDKMessages(id, [{ type: 'assistant', parent_tool_use_id: null, uuid: randomUUID(), message: { content: [{ type: 'text', text: `侧聊未能完成：${message}` }] } }])
  },
})
