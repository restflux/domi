import { describe, expect, test } from 'bun:test'
import type { AskUserRequest } from '@domi/shared'
import { AgentAskUserService } from './agent-ask-user-service.ts'

describe('AgentAskUserService', () => {
  test('Given a host-managed fixed approval When parsed for the renderer Then the custom answer option remains disabled', async () => {
    const service = new AgentAskUserService()
    let request: AskUserRequest | undefined
    const question = '是否切换为 Direct？'

    const resultPromise = service.handleAskUserQuestion(
      'session-read-only',
      {
        questions: [{
          question,
          header: '切换工作方式',
          options: [
            { label: '切换为 Direct 并继续' },
            { label: '保持 Read Only' },
          ],
          allowCustom: false,
        }],
      },
      new AbortController().signal,
      (nextRequest) => { request = nextRequest },
    )

    expect(request?.questions[0]).toMatchObject({
      header: '切换工作方式',
      allowCustom: false,
    })
    expect(service.respondToAskUser(request!.requestId, {
      [question]: '切换为 Direct 并继续',
    })).toBe('session-read-only')
    expect(await resultPromise).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: { [question]: '切换为 Direct 并继续' },
      },
    })
  })
})
