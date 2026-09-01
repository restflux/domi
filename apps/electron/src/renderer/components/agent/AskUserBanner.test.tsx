import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY } from '@domi/shared'
import type { AskUserRequest } from '@domi/shared'
import { allPendingAskUserRequestsAtom, askUserDraftsAtom } from '@/atoms/agent-atoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AskUserBanner, buildAskUserAnswersRecord, hasValidAskUserAnswers } from './AskUserBanner'

function createDirectWorkflowRequest(): AskUserRequest {
  return {
    requestId: 'direct-adjustment-request',
    sessionId: 'session-direct-adjustment',
    toolInput: {
      presentation: {
        kind: 'direct-workflow',
        summary: '修复审批内容',
        details: '按当前方向修改 renderer。',
      },
    },
    questions: [{
      question: '是否批准并切换到 Direct？',
      header: '批准并实施',
      options: [
        { label: '批准并实施' },
        { label: '保持 Read Only' },
      ],
      multiSelect: false,
      allowCustom: true,
    }],
  }
}

describe('AskUser question Markdown rendering', () => {
  test('Given a question contains Markdown When rendering the banner Then it presents formatted text and fenced code', () => {
    const request: AskUserRequest = {
      requestId: 'markdown-question-request',
      sessionId: 'session-markdown-question',
      toolInput: {},
      questions: [{
        question: [
          '**场景层级**应保持清晰：',
          '',
          '```text',
          '场景',
          '└─ 项目',
          '   └─ 会话',
          '```',
        ].join('\n'),
        header: '层级选择',
        options: [{ label: '场景 → 项目 → 会话' }],
        multiSelect: false,
      }],
    }
    const store = createStore()
    store.set(allPendingAskUserRequestsAtom, new Map([[request.sessionId, [request]]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <AskUserBanner sessionId={request.sessionId} />
        </TooltipProvider>
      </Provider>,
    )

    expect(html).toContain('<strong>场景层级</strong>')
    expect(html).toContain('<pre>')
    expect(html).toContain('class="language-text"')
    expect(html).not.toContain('```text')
  })
})

describe('Direct workflow adjustment input', () => {
  test('Given adjustment text When building the response Then it uses the dedicated adjustment channel and preserves the text', () => {
    const request = createDirectWorkflowRequest()
    const answers = new Map([[0, {
      selected: [],
      customText: '  先缩小修改范围，再重新申请。  ',
      showCustom: true,
    }]])

    expect(hasValidAskUserAnswers(request.questions, answers)).toBe(true)
    expect(buildAskUserAnswersRecord(request.questions, answers, true)).toEqual({
      [DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY]: '先缩小修改范围，再重新申请。',
    })
  })

  test('Given the adjustment path is selected When rendering the approval card Then it shows a dedicated multiline editor and disables empty submission', () => {
    const request = createDirectWorkflowRequest()
    const store = createStore()
    store.set(allPendingAskUserRequestsAtom, new Map([[request.sessionId, [request]]]))
    store.set(askUserDraftsAtom, new Map([[
      request.requestId,
      {
        activeTab: 0,
        focusedOptIdx: 2,
        answers: new Map([[0, { selected: [], customText: '   ', showCustom: true }]]),
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <AskUserBanner sessionId={request.sessionId} />
        </TooltipProvider>
      </Provider>,
    )

    expect(html).toContain('调整后再确认')
    expect(html).toContain('写下希望调整的内容')
    expect(html).toContain('<textarea')
    expect(html).not.toContain('其他...')
    expect(html).toContain('disabled=""')
  })
})
