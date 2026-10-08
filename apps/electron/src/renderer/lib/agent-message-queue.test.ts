import { describe, expect, test } from 'bun:test'
import {
  buildQueuedMessageSendPayload,
  changeQueuedMessageKind,
  createAgentQueuedMessage,
  getAsideQueuedMessages,
  getMostRecentQueuedMessage,
  getNativeQueuedMessages,
  getVisibleQueuedMessages,
  hasActiveNativeMessageQueue,
  mergeRestoredQueuedMessagesIntoDraft,
  moveQueuedMessage,
  orderQueuedMessagesForDelivery,
  removeQueuedMessage,
  reconcileSubmittedQueuedMessage,
  resolveClearedQueuedMessages,
  restoreFailedAsideMessages,
} from './agent-message-queue'
import type { AgentAsideQueuedMessage, AgentNativeQueuedMessage, AgentQueuedMessage, AgentQueuedMessageKind } from './agent-message-queue'

function queued(id: string, kind: AgentQueuedMessageKind, createdAt: number): AgentQueuedMessage {
  return createAgentQueuedMessage(id, id, createdAt, null, { kind })
}

function aside(id: string, createdAt: number): AgentAsideQueuedMessage {
  return queued(id, 'aside', createdAt) as AgentAsideQueuedMessage
}

describe('Agent message queue kinds', () => {
  test('steering → follow-up → aside，且各组内部保持稳定顺序', () => {
    const ordered = orderQueuedMessagesForDelivery([
      queued('a1', 'aside', 1),
      queued('f1', 'followUp', 2),
      queued('s1', 'steering', 3),
      queued('a2', 'aside', 4),
      queued('f2', 'followUp', 5),
      queued('s2', 'steering', 6),
    ])
    expect(ordered.map((message) => message.id)).toEqual(['s1', 's2', 'f1', 'f2', 'a1', 'a2'])
  })

  test('native/asides 过滤不会把 aside 当作 SDK 原生消息', () => {
    const queue = [queued('s1', 'steering', 1), aside('a1', 2), queued('f1', 'followUp', 3)]
    expect(getNativeQueuedMessages(queue).map((message) => message.id)).toEqual(['s1', 'f1'])
    expect(getAsideQueuedMessages(queue).map((message) => message.id)).toEqual(['a1'])
  })

  test('Steering 与 Follow-up 在 Pi 真正消费前都保留为队列卡片', () => {
    const queue = [
      queued('s1', 'steering', 1),
      queued('f1', 'followUp', 2),
      { ...queued('d1', 'followUp', 3), delivery: 'deferred' as const },
    ]

    expect(getVisibleQueuedMessages(queue).map((message) => message.id)).toEqual(['s1', 'f1'])
  })

  test('点击“调整方向”只原位升级 Follow-up，保留相同 UUID 与完整 payload', () => {
    const followUp = createAgentQueuedMessage(
      '继续处理附件',
      'f1',
      2,
      { text: '引用', filePath: 'src/a.ts', capturedAt: 1 },
      {
        kind: 'followUp',
        attachments: [{ filename: 'a.png', mediaType: 'image/png', size: 10, targetPath: 'attachments/a.png' }],
        additionalDirectories: ['D:/references'],
        nextTurnAsides: [{ id: 'aside-1', content: '额外说明' }],
      },
    )
    const changed = changeQueuedMessageKind([
      queued('s1', 'steering', 1),
      followUp,
      queued('f2', 'followUp', 3),
    ], 'f1', 'steering')

    expect(changed.map((message) => message.id)).toEqual(['s1', 'f1', 'f2'])
    expect(changed[1]).toEqual({ ...followUp, kind: 'steering' })
  })

  test('拖拽后仍按 SDK 双队列顺序展示', () => {
    const moved = moveQueuedMessage([
      queued('s1', 'steering', 1),
      queued('s2', 'steering', 2),
      queued('f1', 'followUp', 3),
    ], 's2', 's1', 'before')
    expect(moved.map((message) => message.id)).toEqual(['s2', 's1', 'f1'])
  })

  test('加入队列消息可立即改为调整方向，并按 steering 优先级重排', () => {
    const changed = changeQueuedMessageKind([
      queued('f1', 'followUp', 1),
      aside('a1', 2),
      queued('f2', 'followUp', 3),
    ], 'f2', 'steering')

    expect(changed.map((message) => `${message.kind}:${message.id}`))
      .toEqual(['steering:f2', 'followUp:f1', 'aside:a1'])
  })

  test('Escape 恢复按 steering → follow-up 原序无损合并到已有草稿', () => {
    const restored = mergeRestoredQueuedMessagesIntoDraft('已有草稿', [
      queued('s1', 'steering', 1),
      queued('s2', 'steering', 2),
      queued('f1', 'followUp', 3),
    ])
    expect(restored).toBe('已有草稿\n\ns1\n\ns2\n\nf1')
  })

  test('submit-or-enqueue 的 waiting/started 响应不会与启动事件竞态重建队列卡片', () => {
    const message = queued('message', 'steering', 1)
    expect(reconcileSubmittedQueuedMessage([message], message, {
      disposition: 'queued',
      queueState: 'waiting',
    })).toEqual([{ ...message, delivery: 'deferred' }])
    expect(reconcileSubmittedQueuedMessage([], message, {
      disposition: 'queued',
      queueState: 'started',
    })).toEqual([])
    expect(reconcileSubmittedQueuedMessage([message], message, {
      disposition: 'injected',
    })).toEqual([message])
  })

  test('main deferred queue 接管的消息不参与 Pi native clear+replay', () => {
    const native = queued('native', 'steering', 1)
    const deferred = { ...queued('deferred', 'followUp', 2), delivery: 'deferred' as const }

    expect(getNativeQueuedMessages([native, deferred]).map((message) => message.id)).toEqual(['native'])
  })

  test('Escape 使用最新 store 快照保留快速入队消息的附件与附加目录元数据', () => {
    const latest = createAgentQueuedMessage('latest', 'latest', 10, null, {
      kind: 'steering',
      attachments: [{ filename: 'a.txt', mediaType: 'text/plain', size: 3, targetPath: '/tmp/a.txt' }],
      additionalDirectories: ['/workspace/extra'],
    })
    const restored = resolveClearedQueuedMessages([latest], [
      { uuid: 'latest', kind: 'steering', rawUserMessage: 'latest' },
    ])
    expect(restored[0]).toBe(latest as AgentNativeQueuedMessage)
    expect(restored[0]?.attachments?.[0]?.targetPath).toBe('/tmp/a.txt')
    expect(restored[0]?.additionalDirectories).toEqual(['/workspace/extra'])
  })

  test('清理 SDK 队列时不会把同 ID 的 aside 当作 native clear 结果', () => {
    const restored = resolveClearedQueuedMessages([aside('same-id', 1)], [
      { uuid: 'same-id', kind: 'followUp', rawUserMessage: 'native fallback' },
    ], 2)
    expect(restored).toHaveLength(1)
    expect(restored[0]?.kind).toBe('followUp')
    expect(restored[0]?.text).toBe('native fallback')
  })

  test('Alt+Up 取回按创建时间最近的一条，而非分组后的最后一条', () => {
    const recent = getMostRecentQueuedMessage([
      queued('s-new', 'steering', 30),
      queued('f-old', 'followUp', 10),
    ])
    expect(recent?.id).toBe('s-new')
  })

  test('撤回到输入框时保留原消息的引用、附件和附加目录元数据', () => {
    const message = createAgentQueuedMessage('修正错字', 'f1', 1, {
      text: '引用内容',
      filePath: 'src/a.ts',
      capturedAt: 1,
    }, {
      kind: 'followUp',
      attachments: [{ filename: 'a.txt', mediaType: 'text/plain', size: 3, targetPath: '/tmp/a.txt' }],
      additionalDirectories: ['/workspace/extra'],
    })
    const queue = [message, queued('f2', 'followUp', 2)]
    const recalled = queue.find((item) => item.id === message.id)
    const remaining = removeQueuedMessage(queue, message.id)

    expect(recalled).toBe(message)
    expect(recalled?.quotedSelection?.filePath).toBe('src/a.ts')
    expect(recalled?.attachments?.[0]?.targetPath).toBe('/tmp/a.txt')
    expect(recalled?.additionalDirectories).toEqual(['/workspace/extra'])
    expect(remaining.map((item) => item.id)).toEqual(['f2'])
  })

  test('发送失败的 asides 按 ID 去重，并恢复到 aside 分组末尾', () => {
    const existing = [queued('s1', 'steering', 1), queued('a-existing', 'aside', 2), queued('f1', 'followUp', 3)]
    const restored = restoreFailedAsideMessages(existing, [
      aside('a-new', 4),
      aside('a-existing', 5),
      aside('a-new', 6),
    ])
    expect(restored.map((message) => message.id)).toEqual(['s1', 'f1', 'a-existing', 'a-new'])
  })

  test('run 终态不会猜测未消费消息已送达，卡片继续保留供撤回或删除', () => {
    const queue = [
      queued('s1', 'steering', 1),
      queued('f1', 'followUp', 2),
      { ...queued('deferred', 'steering', 3), delivery: 'deferred' as const },
      aside('a1', 4),
    ]

    expect(queue.map((message) => message.id)).toEqual(['s1', 'f1', 'deferred', 'a1'])
  })

  test('空闲后的残留卡片只做本地操作，不再调用已销毁的原生队列', () => {
    expect(hasActiveNativeMessageQueue(false, false)).toBe(false)
    expect(hasActiveNativeMessageQueue(true, false)).toBe(true)
    expect(hasActiveNativeMessageQueue(false, true)).toBe(true)
  })

})

describe('/image 生图命令的原文回传（主进程授权事实源）', () => {
  test('Given 队列消息带 rawUserMessage When 构建发送 payload Then rawText 保留原文、sdkText 保持剥离', () => {
    const message = createAgentQueuedMessage('一只戴宇航头盔的橘猫，电影海报风格', 'm1', 1, null, {
      imageGeneration: { channelId: 'images', modelId: 'gpt-image-2.5-flare' },
      imageGenerationRequested: true,
      rawUserMessage: '/image 一只戴宇航头盔的橘猫，电影海报风格',
    })
    expect(message.rawUserMessage).toBe('/image 一只戴宇航头盔的橘猫，电影海报风格')
    const payload = buildQueuedMessageSendPayload(message)
    expect(payload.rawText).toBe('/image 一只戴宇航头盔的橘猫，电影海报风格')
    expect(payload.sdkText).toBe('一只戴宇航头盔的橘猫，电影海报风格')
  })

  test('Given 普通消息没有 rawUserMessage When 构建 payload Then rawText 回退到 text', () => {
    const message = createAgentQueuedMessage('普通问题', 'm2', 1)
    const payload = buildQueuedMessageSendPayload(message)
    expect(payload.rawText).toBe('普通问题')
    expect(payload.sdkText).toBe('普通问题')
  })

  test('Given 附件上下文块加 rawUserMessage When 构建 payload Then rawText 前置上下文块且命令仍位于正文开头', () => {
    const fileBlock = '<attached_files>\n- a.jpg: /tmp/a.jpg\n</attached_files>'
    const message = createAgentQueuedMessage('按原图二创植物形状', 'm3', 1, null, {
      imageGenerationRequested: true,
      rawUserMessage: '/image 按原图二创植物形状',
      fileReferenceBlock: fileBlock,
    })
    const payload = buildQueuedMessageSendPayload(message, '')
    expect(payload.rawText).toBe(`${fileBlock}\n\n/image 按原图二创植物形状`)
    expect(payload.sdkText).toBe(`${fileBlock}\n\n按原图二创植物形状`)
  })

  test('Given 重建 deferred 队列记录 When 无 options Then 不会误带 rawUserMessage 字段', () => {
    const message = createAgentQueuedMessage('普通消息', 'm4', 1, null, { kind: 'steering' })
    expect(message.rawUserMessage).toBeUndefined()
    expect(message.imageGenerationRequested).toBeUndefined()
  })
})
