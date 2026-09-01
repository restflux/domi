import { describe, expect, test } from 'bun:test'
import { DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY } from '@domi/shared'
import type { AskUserRequest, SDKMessage } from '@domi/shared'
import { extractUserText, groupIntoTurns } from '@domi/session-core'
import { AgentAskUserService } from './agent-ask-user-service.ts'
import {
  createDirectWorkflowAdjustmentUserMessage,
  extractDirectWorkflowAdjustment,
} from './agent-ask-user-response.ts'

function directToolInput(): Record<string, unknown> {
  return {
    presentation: {
      kind: 'direct-workflow',
      details: '准备修改 renderer。',
    },
    questions: [{
      question: '是否批准并切换到 Direct？',
      options: [{ label: '批准并实施' }, { label: '保持 Read Only' }],
      allowCustom: true,
    }],
  }
}

function directAssistantMessage(): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'direct-assistant-message',
    parent_tool_use_id: null,
    message: {
      content: [{
        type: 'tool_use',
        id: 'request-direct-tool',
        name: 'RequestDirectWorkflow',
        input: { details: '准备修改 renderer。' },
      }],
    },
  } as unknown as SDKMessage
}

describe('Direct workflow adjustment response persistence', () => {
  test('Given a submitted adjustment When the blocked AskUser resolves Then the original text is persisted after the Direct request and emitted before Agent continuation', async () => {
    const service = new AgentAskUserService()
    const accumulated = [directAssistantMessage()]
    const persisted: SDKMessage[] = []
    const emitted: SDKMessage[] = []
    const order: string[] = []
    let request: AskUserRequest | undefined

    const resultPromise = service.handleAskUserQuestion(
      'session-direct-adjustment',
      directToolInput(),
      new AbortController().signal,
      (nextRequest) => { request = nextRequest },
      (answeredRequest, answers) => {
        order.push('answered')
        const adjustment = extractDirectWorkflowAdjustment(answeredRequest, answers)
        if (!adjustment) return
        const message = createDirectWorkflowAdjustmentUserMessage(adjustment, {
          uuid: 'adjustment-user-message',
          createdAt: 1_786_677_000_000,
        })
        accumulated.push(message)
        persisted.push(...accumulated)
        accumulated.length = 0
        order.push('persist')
        emitted.push(message)
        order.push('emit')
      },
    )
    void resultPromise.then(() => order.push('continued'))

    expect(service.respondToAskUser(request!.requestId, {
      [DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY]: '  项目版本号，不是文档版本号。  ',
    })).toBe('session-direct-adjustment')
    expect(order).toEqual(['answered', 'persist', 'emit'])

    await resultPromise
    await Promise.resolve()
    expect(order).toEqual(['answered', 'persist', 'emit', 'continued'])
    expect(persisted).toHaveLength(2)
    expect(persisted[0]).toMatchObject({ type: 'assistant', uuid: 'direct-assistant-message' })
    expect(persisted[1]).toMatchObject({
      type: 'user',
      uuid: 'adjustment-user-message',
      parent_tool_use_id: null,
      _createdAt: 1_786_677_000_000,
      _interactionKind: 'direct-workflow-adjustment',
      message: { content: [{ type: 'text', text: '项目版本号，不是文档版本号。' }] },
    })
    expect(emitted).toEqual([persisted[1]!])

    const groups = groupIntoTurns(persisted)
    expect(groups.map((group) => group.type)).toEqual(['assistant-turn', 'user'])
    expect(groups[1]?.type === 'user' ? extractUserText(groups[1].message) : null)
      .toBe('项目版本号，不是文档版本号。')
  })

  test('Given approval, Read Only, empty adjustment, or a non-Direct request When responding Then no user message is created', () => {
    const directRequest: AskUserRequest = {
      requestId: 'direct',
      sessionId: 'session',
      questions: [],
      toolInput: directToolInput(),
    }
    const nonDirectRequest: AskUserRequest = {
      ...directRequest,
      requestId: 'ordinary',
      toolInput: { questions: [] },
    }

    expect(extractDirectWorkflowAdjustment(directRequest, { decision: '批准并实施' })).toBeNull()
    expect(extractDirectWorkflowAdjustment(directRequest, { decision: '保持 Read Only' })).toBeNull()
    expect(extractDirectWorkflowAdjustment(directRequest, {
      [DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY]: '   ',
    })).toBeNull()
    expect(extractDirectWorkflowAdjustment(nonDirectRequest, {
      [DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY]: '不应伪装成 Direct 调整。',
    })).toBeNull()
  })
})
