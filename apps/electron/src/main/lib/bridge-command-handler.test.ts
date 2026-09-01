import { beforeEach, describe, expect, mock, test } from 'bun:test'

interface SessionFixture {
  id: string
  title: string
  workspaceId?: string
  channelId?: string
}

const sessions: SessionFixture[] = []
const sentMessages: string[] = []
let createdSessionIndex = 0

interface CapturedHeadlessCallbacks {
  onError(error: string): void
  onComplete(opts?: { backgroundTasksPending?: boolean; stoppedByUser?: boolean }): void
}

interface CapturedAgentPayload {
  kind: string
  message?: unknown
}

let headlessCallbacks: CapturedHeadlessCallbacks | undefined
const headlessCallbackRuns: CapturedHeadlessCallbacks[] = []
let agentEventHandler: ((sessionId: string, payload: CapturedAgentPayload) => void) | undefined

mock.module('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}))

mock.module('@domi/shared', () => ({
  AGENT_IPC_CHANNELS: {
    TITLE_UPDATED: 'agent:title-updated',
  },
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (title: string, channelId: string, workspaceId?: string) => {
    const session = {
      id: `created-session-${++createdSessionIndex}`,
      title,
      channelId,
      workspaceId,
    }
    sessions.unshift(session)
    return session
  },
  listAgentSessions: () => sessions,
  getAgentSessionMeta: (sessionId: string) => sessions.find((session) => session.id === sessionId),
}))

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => [{ id: 'workspace-1', name: '项目一', slug: 'workspace-1' }],
  getAgentWorkspace: (workspaceId: string) => workspaceId === 'workspace-1'
    ? { id: 'workspace-1', name: '项目一', slug: 'workspace-1' }
    : undefined,
  getProjectFilesPath: () => '/tmp/workspace-1',
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
}))

mock.module('./agent-service', () => ({
  runAgentHeadless: async (_input: unknown, callbacks: CapturedHeadlessCallbacks) => {
    headlessCallbacks = callbacks
    headlessCallbackRuns.push(callbacks)
  },
  agentEventBus: {
    on: (handler: (sessionId: string, payload: CapturedAgentPayload) => void) => {
      agentEventHandler = handler
      return () => {
        if (agentEventHandler === handler) agentEventHandler = undefined
      }
    },
  },
  stopAgent: () => undefined,
  isAgentSessionActive: () => false,
  respondAgentAskUser: async () => false,
  respondAgentExitPlan: async () => false,
}))

mock.module('./settings-service', () => ({
  getSettings: () => ({
    agentChannelId: 'channel-1',
    agentModelId: 'model-1',
    agentRemoteDefaultWorkspaceId: 'workspace-1',
  }),
  resolveAgentRemoteDefaultWorkspaceId: () => 'workspace-1',
}))

mock.module('./bridge-session-target.ts', () => ({
  bindProductionBridgeSessionTargetForLaunch: async () => undefined,
}))

mock.module('./bridge-run-metadata-service', () => ({
  resolveBridgeRunMetadata: async () => ({
    channelName: '测试渠道',
    modelName: '测试模型',
    reasoningLevel: 'high',
    reasoningLabel: 'High',
  }),
}))

mock.module('./bridge-attachment-utils', () => ({
  buildAttachedFilesBlock: () => '',
  buildSessionFileTree: () => [],
  buildFileTree: () => [],
}))

mock.module('./bridge-model-utils', () => ({
  listSwitchableChannels: () => [],
  getEnabledModels: () => [],
  resolveChannelByIndex: () => undefined,
  resolveModelByIndex: () => undefined,
  describeBindingModel: () => ({
    channelName: '测试渠道',
    modelName: '测试模型',
    valid: true,
  }),
}))

const { BridgeCommandHandler } = await import('./bridge-command-handler')

describe('BridgeCommandHandler 最终交付与会话边界', () => {
  beforeEach(() => {
    sessions.splice(0, sessions.length, {
      id: 'existing-session-1',
      title: '已有会话',
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
    })
    sentMessages.length = 0
    createdSessionIndex = 0
    headlessCallbacks = undefined
    headlessCallbackRuns.length = 0
    agentEventHandler = undefined
  })

  interface HandlerHarnessOptions {
    sendText?: (text: string, deliveryId?: string) => Promise<void>
    sendImage?: (filename: string, deliveryId?: string) => Promise<void>
    isRetryableDeliveryError?: (error: unknown) => boolean
    deliveryRetryDelaysMs?: readonly number[]
    deliveryRecoveryDelayMs?: number
    pendingDeliveryTtlMs?: number
  }

  function createHandler(changedChatIds: string[], options: HandlerHarnessOptions = {}) {
    return new BridgeCommandHandler({
      platformName: '测试',
      adapter: {
        sendText: async (_chatId, text, _meta, delivery) => {
          sentMessages.push(text)
          await options.sendText?.(text, delivery?.deliveryId)
        },
        ...(options.sendImage
          ? {
              sendImage: async (_chatId, image, _meta, delivery) => {
                await options.sendImage!(image.filename, delivery?.deliveryId)
              },
            }
          : {}),
        ...(options.isRetryableDeliveryError
          ? { isRetryableDeliveryError: options.isRetryableDeliveryError }
          : {}),
      },
      onSessionContextChanged: (chatId) => {
        changedChatIds.push(chatId)
      },
      deliveryRetryDelaysMs: options.deliveryRetryDelaysMs ?? [],
      deliveryRecoveryDelayMs: options.deliveryRecoveryDelayMs ?? 1,
      pendingDeliveryTtlMs: options.pendingDeliveryTtlMs ?? 100,
    })
  }

  async function flushDelivery(): Promise<void> {
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  function emitAssistant(sessionId: string, text: string, imageToolIds: string[] = []): void {
    agentEventHandler?.(sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        message: {
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...imageToolIds.map((id) => ({ type: 'tool_use', id, name: 'mcp__gpt_image__imagegen', input: {} })),
          ],
        },
        parent_tool_use_id: null,
      },
    })
  }

  function emitImageResult(sessionId: string, toolUseId: string, filename: string): void {
    agentEventHandler?.(sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{ type: 'image', data: `base64-${filename}`, mimeType: 'image/png' }],
          }],
        },
        parent_tool_use_id: null,
      },
    })
  }

  test('Given SDK result 事件漏发, When runAgentHeadless 完成回调到达, Then 仍发送最终回复', async () => {
    const handler = createHandler([])
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请完成任务')
    const sessionId = sessions[0]!.id
    agentEventHandler?.(sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '任务完成' }] },
        parent_tool_use_id: null,
      },
    })
    headlessCallbacks?.onComplete()
    await Promise.resolve()
    await Promise.resolve()

    expect(sentMessages.filter((message) => message.includes('任务完成'))).toHaveLength(1)
  })

  test('Given 只有 SDK result 到达, When 本轮结束, Then 仍发送最终回复', async () => {
    const handler = createHandler([])
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请完成任务')
    const sessionId = sessions[0]!.id
    emitAssistant(sessionId, 'result 路径完成')
    agentEventHandler?.(sessionId, {
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success' },
    })
    await flushDelivery()

    expect(sentMessages.filter((message) => message.includes('result 路径完成'))).toHaveLength(1)
  })

  test('Given 后台任务仍在运行, When 收到轻量完成回调, Then 不提前交付未完成结果', async () => {
    const handler = createHandler([])
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请启动后台任务')
    const sessionId = sessions[0]!.id
    emitAssistant(sessionId, '阶段性内容')
    headlessCallbacks?.onComplete({ backgroundTasksPending: true })
    await flushDelivery()

    expect(sentMessages.some((message) => message.includes('阶段性内容'))).toBe(false)

    emitAssistant(sessionId, '最终内容')
    headlessCallbacks?.onComplete()
    await flushDelivery()
    expect(sentMessages.filter((message) => message.includes('最终内容'))).toHaveLength(1)
  })

  test('Given result 与完成回调都到达, When 两者竞争终态, Then 最终回复只发送一次', async () => {
    const handler = createHandler([])
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请完成任务')
    const sessionId = sessions[0]!.id
    agentEventHandler?.(sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '唯一结果' }] },
        parent_tool_use_id: null,
      },
    })
    agentEventHandler?.(sessionId, {
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success' },
    })
    headlessCallbacks?.onComplete()
    await Promise.resolve()
    await Promise.resolve()

    expect(sentMessages.filter((message) => message.includes('唯一结果'))).toHaveLength(1)
  })

  test('Given 最终文本首次网络失败, When 有界重试成功, Then 复用稳定消息 ID 且不丢回复', async () => {
    const deliveryIds: string[] = []
    let finalAttempts = 0
    const handler = createHandler([], {
      deliveryRetryDelaysMs: [0],
      sendText: async (text, deliveryId) => {
        if (!deliveryId || !text.includes('重试后完成')) return
        deliveryIds.push(deliveryId)
        finalAttempts += 1
        if (finalAttempts === 1) throw new Error('network reset')
      },
    })
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请完成任务')
    const sessionId = sessions[0]!.id
    emitAssistant(sessionId, '重试后完成')
    headlessCallbacks?.onComplete()
    await new Promise<void>((resolve) => setTimeout(resolve, 5))

    expect(finalAttempts).toBe(2)
    expect(new Set(deliveryIds).size).toBe(1)
  })

  test('Given 两张图中一张确定性失败, When 最终交付, Then 继续发送其余图片并报告数量', async () => {
    const imageAttempts: string[] = []
    const handler = createHandler([], {
      sendImage: async (filename) => {
        imageAttempts.push(filename)
        if (filename === 'generated-image.png' && imageAttempts.length === 2) {
          throw new Error('invalid image')
        }
      },
      isRetryableDeliveryError: (error) => !(error instanceof Error && error.message === 'invalid image'),
    })
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '生成两张图')
    const sessionId = sessions[0]!.id
    emitAssistant(sessionId, '', ['img-1', 'img-2'])
    emitImageResult(sessionId, 'img-1', 'first.png')
    emitImageResult(sessionId, 'img-2', 'second.png')
    headlessCallbacks?.onComplete()
    await flushDelivery()

    expect(imageAttempts).toHaveLength(2)
    expect(sentMessages.some((message) => message.includes('图片成功 1 张、失败 1 张'))).toBe(true)
    expect(sentMessages.some((message) => message.includes('Agent 已完成（无文本输出）'))).toBe(true)
  })

  test('Given Bridge 短暂断开后本轮完成, When 重新订阅, Then 补发一次最终结果', async () => {
    let connected = true
    let delivered = 0
    const handler = createHandler([], {
      deliveryRecoveryDelayMs: 1_000,
      sendText: async (text, deliveryId) => {
        if (!deliveryId || !text.includes('断线期间完成')) return
        if (!connected) throw new Error('disconnected')
        delivered += 1
      },
    })
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请完成任务')
    const sessionId = sessions[0]!.id
    connected = false
    handler.unsubscribe()
    emitAssistant(sessionId, '断线期间完成')
    headlessCallbacks?.onComplete()
    await flushDelivery()
    expect(delivered).toBe(0)

    connected = true
    handler.subscribe()
    await flushDelivery()

    expect(delivered).toBe(1)
  })

  test('Given 第一轮停止并开始第二轮, When 第一轮迟到完成回调到达, Then 不会结束或发送第二轮结果', async () => {
    const handler = createHandler([])
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '第一轮')
    const firstCallbacks = headlessCallbackRuns[0]!
    await handler.handleIncomingMessage('chat-1', '/stop')
    await handler.handleIncomingMessage('chat-1', '第二轮')
    const secondCallbacks = headlessCallbackRuns[1]!
    const sessionId = sessions[0]!.id

    firstCallbacks.onComplete()
    emitAssistant(sessionId, '第二轮完成')
    await flushDelivery()
    expect(sentMessages.some((message) => message.includes('第二轮完成'))).toBe(false)

    secondCallbacks.onComplete()
    await flushDelivery()
    expect(sentMessages.filter((message) => message.includes('第二轮完成'))).toHaveLength(1)
  })

  test('Given 最终交付进入补发等待, When 用户停止会话, Then 清理待交付且不会被定时器复活', async () => {
    let finalAttempts = 0
    const handler = createHandler([], {
      deliveryRecoveryDelayMs: 5,
      pendingDeliveryTtlMs: 100,
      sendText: async (text, deliveryId) => {
        if (deliveryId && text.includes('不应复活')) {
          finalAttempts += 1
          throw new Error('offline')
        }
      },
    })
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请完成任务')
    const sessionId = sessions[0]!.id
    emitAssistant(sessionId, '不应复活')
    headlessCallbacks?.onComplete()
    await flushDelivery()
    expect(finalAttempts).toBe(1)

    await handler.handleIncomingMessage('chat-1', '/stop')
    await new Promise<void>((resolve) => setTimeout(resolve, 15))
    expect(finalAttempts).toBe(1)
  })

  test('Given Bridge 永久登出清理瞬态, When 之后重新订阅, Then 不补发旧结果', async () => {
    let delivered = 0
    let connected = false
    const handler = createHandler([], {
      deliveryRecoveryDelayMs: 1_000,
      sendText: async (text, deliveryId) => {
        if (!deliveryId || !text.includes('旧账号结果')) return
        if (!connected) throw new Error('offline')
        delivered += 1
      },
    })
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '请完成任务')
    const sessionId = sessions[0]!.id
    emitAssistant(sessionId, '旧账号结果')
    headlessCallbacks?.onComplete()
    await flushDelivery()

    handler.unsubscribe()
    handler.discardTransientState()
    connected = true
    handler.subscribe()
    await flushDelivery()

    expect(delivered).toBe(0)
  })

  test('Given 连续两轮都完成, When 分别交付, Then 文本和幂等 ID 严格隔离', async () => {
    const finalDeliveryIds: string[] = []
    const handler = createHandler([], {
      sendText: async (text, deliveryId) => {
        if (deliveryId && (text.includes('第一轮完成') || text.includes('第二轮完成'))) {
          finalDeliveryIds.push(deliveryId)
        }
      },
    })
    handler.subscribe()

    await handler.handleIncomingMessage('chat-1', '第一轮')
    const sessionId = sessions[0]!.id
    emitAssistant(sessionId, '第一轮完成')
    headlessCallbacks?.onComplete()
    await flushDelivery()

    await handler.handleIncomingMessage('chat-1', '第二轮')
    emitAssistant(sessionId, '第二轮完成')
    headlessCallbacks?.onComplete()
    await flushDelivery()

    expect(sentMessages.filter((message) => message.includes('第一轮完成'))).toHaveLength(1)
    expect(sentMessages.filter((message) => message.includes('第二轮完成'))).toHaveLength(1)
    expect(finalDeliveryIds).toHaveLength(2)
    expect(new Set(finalDeliveryIds).size).toBe(2)
  })

  test('Given 暂存附件属于旧会话, When /new 成功, Then 通知 Bridge 清理附件', async () => {
    const changedChatIds: string[] = []
    const handler = createHandler(changedChatIds)

    await handler.handleIncomingMessage('chat-1', '/new 新会话')

    expect(changedChatIds).toEqual(['chat-1'])
    expect(sentMessages.at(-1)).toContain('已创建 Agent 会话')
  })

  test('Given 切换目标有效, When /switch 成功, Then 通知 Bridge 清理附件', async () => {
    const changedChatIds: string[] = []
    const handler = createHandler(changedChatIds)

    await handler.handleIncomingMessage('chat-1', '/switch 1')

    expect(changedChatIds).toEqual(['chat-1'])
    expect(sentMessages.at(-1)).toContain('已切换到会话')
  })

  test('Given 项目目标有效, When /workspace 成功, Then 通知 Bridge 清理附件', async () => {
    const changedChatIds: string[] = []
    const handler = createHandler(changedChatIds)

    await handler.handleIncomingMessage('chat-1', '/workspace 1')

    expect(changedChatIds).toEqual(['chat-1'])
    expect(sentMessages.at(-1)).toContain('已切换到项目')
  })

  test('Given 切换目标无效, When /switch 失败, Then 保留暂存附件等待后续处理', async () => {
    const changedChatIds: string[] = []
    const handler = createHandler(changedChatIds)

    await handler.handleIncomingMessage('chat-1', '/switch 99')

    expect(changedChatIds).toEqual([])
    expect(sentMessages.at(-1)).toContain('未找到会话')
  })
})
