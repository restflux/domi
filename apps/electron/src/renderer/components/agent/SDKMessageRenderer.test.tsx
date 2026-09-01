import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKAssistantMessage, SDKMessage } from '@domi/shared'
import type { AssistantTurn } from '@domi/session-core'
import { AssistantTurnRenderer, SDKMessageRenderer } from './SDKMessageRenderer.tsx'

describe('Worktree handoff notice', () => {
  test('Given 已创建 Worktree 子会话 When 渲染父会话系统提示 Then 显示可点击的目标会话', () => {
    const message = {
      type: 'system',
      subtype: 'worktree_handoff_created',
      child_session_id: 'child-session',
      child_session_title: '实现 Git 面板 (worktree)',
    } as unknown as SDKMessage

    const html = renderToStaticMarkup(
      <SDKMessageRenderer message={message} allMessages={[message]} />,
    )

    expect(html).toContain('已创建 managed Worktree 子会话')
    expect(html).toContain('实现 Git 面板 (worktree)')
    expect(html).toContain('查看')
    expect(html).toContain('<button')
  })
})

describe('Task progress output deduplication', () => {
  test('Given 当前 turn 只有任务进度工具 When 渲染消息区 Then 不生成空执行过程记录', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-task-only',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'task-update-1',
          name: 'TaskUpdate',
          input: { taskId: '3', status: 'in_progress', subject: '验证执行过程降噪' },
        }],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    expect(renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} />,
    )).toBe('')
  })

  test('Given 任务进度工具与读取操作交错 When 构建摘要 Then 只统计聊天区可见操作', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-task-and-read',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'task-update-1', name: 'TaskUpdate', input: { taskId: '3' } },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/a.ts' } },
          { type: 'text', text: '已完成检查。' },
        ],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} />,
    )

    expect(html).toContain('执行过程 · 读取 1 个文件')
    expect(html).not.toContain('更新任务')
    expect(html).not.toContain('项操作')
  })
})

describe('独立工具执行状态流光', () => {
  test('Given 独立工具仍在执行 When 渲染流式消息 Then 用文字流光替代 spinner', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-running-tool',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'collaboration-running',
          name: 'mcp__collaboration__continue_delegation',
          input: { delegationId: 'active-delegation' },
        }],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} isStreaming />,
    )

    expect(html).toContain('正在COLLABORATION / continue_delegation active-delegation...')
    // 执行过程概览与当前工具行各一处流光。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(2)
    expect(html).not.toContain('animate-spin')
  })

  test('Given 多个独立工具并行执行 When 后面已有更新的可见行 Then 非尾部 pending 工具仍保持流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-parallel-running-tools',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'collaboration-parallel-a',
            name: 'mcp__collaboration__delegate_agent',
            input: { title: '并行任务 A' },
          },
          {
            type: 'tool_use',
            id: 'collaboration-parallel-b',
            name: 'mcp__collaboration__delegate_agent',
            input: { title: '并行任务 B' },
          },
        ],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} isStreaming />,
    )

    expect(html).toContain('正在COLLABORATION / delegate_agent 并行任务 A...')
    expect(html).toContain('正在COLLABORATION / delegate_agent 并行任务 B...')
    // 整体概览和两个真实 pending 的并行工具行均显示流光。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(3)
  })

  test('Given 最新工具结果已返回 When 下一条可见内容尚未出现 Then 完成态行继续承接流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-completed-tail-tool',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'collaboration-completed-tail',
          name: 'mcp__collaboration__continue_delegation',
          input: { delegationId: 'completed-tail-delegation' },
        }],
        model: 'test-model',
      },
    }
    const completedResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'collaboration-completed-tail',
          content: '完成',
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, completedResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, completedResult]} isStreaming />,
    )

    expect(html).toContain('COLLABORATION / continue_delegation completed-tail-delegation')
    expect(html).not.toContain('正在COLLABORATION / continue_delegation completed-tail-delegation...')
    // 整体概览与正在承接活动游标的完成态工具行各一处流光。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(2)
  })

  test('Given 已完成工具后出现新的 thinking When 渲染流式消息 Then 旧工具行停止流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-tool-followed-by-thinking',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'collaboration-before-thinking',
            name: 'mcp__collaboration__continue_delegation',
            input: { delegationId: 'completed-before-thinking' },
          },
          { type: 'thinking', thinking: '正在基于协作结果规划下一步' },
        ],
        model: 'test-model',
      },
    }
    const completedResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'collaboration-before-thinking',
          content: '完成',
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, completedResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, completedResult]} isStreaming />,
    )

    expect(html).toContain('COLLABORATION / continue_delegation completed-before-thinking')
    expect(html).toContain('正在基于协作结果规划下一步')
    // 新 thinking 已成为可见活动尾部，旧工具不再持有流光；仅过程概览保留流光。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(1)
  })

  test('Given 最新工具已经完成 When 整轮结束 Then 不再保留活动流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-completed-run',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'collaboration-completed-run',
          name: 'mcp__collaboration__continue_delegation',
          input: { delegationId: 'completed-run-delegation' },
        }],
        model: 'test-model',
      },
    }
    const completedResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'collaboration-completed-run',
          content: '完成',
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, completedResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, completedResult]} />,
    )

    expect(html).toContain('执行过程 · 1 项操作')
    expect(html).not.toContain('data-process-summary=')
  })

  test('Given 同一流式消息内已有工具完成 When 后续工具执行 Then 只有后续工具行显示流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-mixed-tool-state',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'collaboration-completed',
            name: 'mcp__collaboration__continue_delegation',
            input: { delegationId: 'completed-delegation' },
          },
          {
            type: 'tool_use',
            id: 'collaboration-running',
            name: 'mcp__collaboration__continue_delegation',
            input: { delegationId: 'active-delegation' },
          },
        ],
        model: 'test-model',
      },
    }
    const completedResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'collaboration-completed',
          content: '完成',
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, completedResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, completedResult]} isStreaming />,
    )

    expect(html).toContain('COLLABORATION / continue_delegation completed-delegation')
    expect(html).not.toContain('正在COLLABORATION / continue_delegation completed-delegation...')
    expect(html).toContain('正在COLLABORATION / continue_delegation active-delegation...')
    // 执行过程概览与唯一未完成的工具行各一处流光。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(2)
    expect(html).not.toContain('animate-spin')
  })

  test('Given 独立工具已失败 When 整轮仍在流式 Then 保留失败图标且工具文字不显示流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-failed-tool',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'collaboration-failed',
          name: 'mcp__collaboration__continue_delegation',
          input: { delegationId: 'failed-delegation' },
        }],
        model: 'test-model',
      },
    }
    const failedResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'collaboration-failed',
          content: '失败',
          is_error: true,
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, failedResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, failedResult]} isStreaming />,
    )

    expect(html).toContain('aria-label="工具执行失败"')
    expect(html).toContain('COLLABORATION / continue_delegation failed-delegation')
    expect(html).not.toContain('正在COLLABORATION / continue_delegation failed-delegation...')
    // 仅整轮执行过程概览保留流光，失败工具行本身不显示。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(1)
    expect(html).not.toContain('animate-spin')
  })
})

describe('Segmented process presentation', () => {
  test('Given 流式过程包含多段思考与探索 When 渲染消息区 Then 按原顺序展开叙事并聚合每段探索', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-segmented-process',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '先理解入口与状态模型' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/a.ts' } },
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'process' } },
          { type: 'text', text: '接下来检查恢复逻辑。' },
          { type: 'tool_use', id: 'read-2', name: 'Read', input: { path: '/w/b.ts' } },
          { type: 'tool_use', id: 'read-3', name: 'Read', input: { path: '/w/c.ts' } },
          { type: 'thinking', thinking: '最后确认命令执行边界' },
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'git status' } },
        ],
        model: 'test-model',
      },
    }
    const completedExplorationResults = {
      type: 'user',
      message: {
        content: ['read-1', 'grep-1', 'read-2', 'read-3'].map((toolUseId) => ({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: '完成',
        })),
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, completedExplorationResults],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer
        turn={turn}
        allMessages={[assistant, completedExplorationResults]}
        isStreaming
      />,
    )

    expect(html).toContain('data-process-compact="false"')
    // 整体概览与唯一仍在执行的探索摘要显示流光；已经返回结果的探索组保持静态。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(2)
    expect(html).toContain('探索 · 1 个文件 · 1 次搜索')
    expect(html).toContain('探索 · 2 个文件')
    expect(html).toContain('探索 · 1 条只读命令')
    expect(html).toContain('1 项探索进行中')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('正在执行 git status')
    expect(html).not.toContain('并行 4 项')
    expect(html.indexOf('先理解入口与状态模型')).toBeLessThan(html.indexOf('探索 · 1 个文件 · 1 次搜索'))
    expect(html.indexOf('探索 · 1 个文件 · 1 次搜索')).toBeLessThan(html.indexOf('接下来检查恢复逻辑。'))
    expect(html.indexOf('接下来检查恢复逻辑。')).toBeLessThan(html.indexOf('探索 · 2 个文件'))
    expect(html.indexOf('探索 · 2 个文件')).toBeLessThan(html.indexOf('最后确认命令执行边界'))
    expect(html.indexOf('最后确认命令执行边界')).toBeLessThan(html.indexOf('探索 · 1 条只读命令'))
    expect(html).not.toContain('>收起<')
  })

  test('Given 非尾部探索组仍有 pending 工具 When 后面已出现新行 Then 探索摘要继续显示流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-pending-exploration-before-thinking',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'read-pending-before-thinking', name: 'Read', input: { path: '/w/pending.ts' } },
          { type: 'thinking', thinking: '同时规划另一个执行方向' },
        ],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} isStreaming />,
    )

    expect(html).toContain('探索 · 1 个文件')
    expect(html).toContain('1 项探索进行中')
    expect(html).toContain('同时规划另一个执行方向')
    // 整体概览与仍在运行的非尾部探索摘要各一处流光。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(2)
  })

  test('Given 最新探索组结果全部返回 When 下一条过程内容尚未出现 Then 摘要继续承接流光', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-completed-exploration-tail',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'read-tail', name: 'Read', input: { path: '/w/tail.ts' } },
          { type: 'tool_use', id: 'grep-tail', name: 'Grep', input: { pattern: 'tail' } },
        ],
        model: 'test-model',
      },
    }
    const completedResults = {
      type: 'user',
      message: {
        content: ['read-tail', 'grep-tail'].map((toolUseId) => ({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: '完成',
        })),
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, completedResults],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, completedResults]} isStreaming />,
    )

    expect(html).toContain('探索 · 1 个文件 · 1 次搜索')
    expect(html).toContain('正在处理探索结果')
    // 整体概览与等待下一条可见内容的探索摘要各一处流光。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(2)
  })

  test('Given 最新探索工具失败 When 整轮仍在推进 Then 失败摘要保持静态', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-failed-exploration-tail',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_use', id: 'grep-failed-tail', name: 'Grep', input: { pattern: 'tail' } }],
        model: 'test-model',
      },
    }
    const failedResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'grep-failed-tail',
          content: '失败',
          is_error: true,
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, failedResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, failedResult]} isStreaming />,
    )

    expect(html).toContain('探索 · 1 次搜索')
    expect(html).toContain('1 项失败')
    expect(html).not.toContain('正在处理探索结果')
    // 失败探索摘要不承接活动游标，仅整体过程概览继续表达运行状态。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(1)
  })

  test('Given 同一过程执行完成 When 渲染历史消息 Then 整体默认折叠且保留稳定摘要', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-completed-process',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '这段过程完成后应被折叠' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/a.ts' } },
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'process' } },
          { type: 'text', text: '最终回答。' },
        ],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} />,
    )

    expect(html).toContain('data-process-compact="true"')
    expect(html).not.toContain('data-process-summary=')
    expect(html).toContain('执行过程 · 读取 1 个文件 · 搜索 1 次')
    expect(html).not.toContain('这段过程完成后应被折叠')
    expect(html).toContain('最终回答。')
  })

  test('Given 过程被用户中断 When 渲染历史消息 Then 保持展开而不是折叠收起', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-interrupted-process',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '中断前仍在分析' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/a.ts' } },
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'process' } },
          { type: 'text', text: '被中断前的正文。' },
        ],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} stoppedByUser />,
    )

    expect(html).toContain('data-process-compact="false"')
    expect(html).toContain('已被用户中断')
    expect(html).toContain('中断前仍在分析')
    expect(html).toContain('被中断前的正文。')
  })

  test('Given 探索后进入用户决策节点 When 渲染消息区 Then 问题说明和 AskUserQuestion 保持独立可见', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-question-process',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '先确认现有配置。' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/config.ts' } },
          { type: 'text', text: '需要你确认接下来的处理方式。' },
          {
            type: 'tool_use',
            id: 'ask-1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: '选择保守方案还是完整方案？' }] },
          },
        ],
        model: 'test-model',
      },
    }
    const completedReadResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: '完成',
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, completedReadResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, completedReadResult]} isStreaming />,
    )

    expect(html).toContain('探索 · 1 个文件')
    expect(html).toContain('需要你确认接下来的处理方式。')
    expect(html).toContain('询问 选择保守方案还是完整方案？')
    expect(html).not.toContain('正在询问 选择保守方案还是完整方案？...')
    // 用户等待工具不承接活动流光；仅前序过程概览仍保留流式状态。
    expect(html.match(/data-process-summary="shimmer"/g)?.length ?? 0).toBe(1)
    expect(html.indexOf('探索 · 1 个文件')).toBeLessThan(html.indexOf('需要你确认接下来的处理方式。'))
    expect(html.indexOf('需要你确认接下来的处理方式。')).toBeLessThan(html.indexOf('询问 选择保守方案还是完整方案？'))
  })

  test('Given 完成过程存在失败结果 When 整体已折叠 Then 错误计数仍保持可见', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-failed-process',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/a.ts' } },
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'process' } },
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'git status' } },
          { type: 'text', text: '已完成检查。' },
        ],
        model: 'test-model',
      },
    }
    const failedResult = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'grep-1',
          content: '搜索失败',
          is_error: true,
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, failedResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, failedResult]} />,
    )

    expect(html).toContain('1 项失败')
    expect(html).toContain('执行过程 · 读取 1 个文件 · 搜索 1 次 · 执行 1 条命令')
  })

  test('Given Agent 在过程后以 provider 错误收尾 When 渲染完成消息 Then 错误尾栏保持独立可见', () => {
    const assistant = {
      type: 'assistant',
      uuid: 'assistant-error-tail',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '正在检查连接状态。' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/a.ts' } },
          { type: 'text', text: '已保留错误前生成的正文。' },
        ],
        model: 'test-model',
      },
      error: { message: 'provider disconnected' },
    } as unknown as SDKAssistantMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} />,
    )

    expect(html).toContain('执行过程 · 读取 1 个文件')
    expect(html).toContain('已保留错误前生成的正文。')
    expect(html).toContain('provider disconnected')
    expect(html.indexOf('已保留错误前生成的正文。')).toBeLessThan(html.indexOf('provider disconnected'))
  })
})

describe('Assistant turn fork actions', () => {
  test('Given Local target 提供两种分叉动作 When 渲染已完成回复 Then 合并为单个分叉菜单按钮', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-1',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '完成' }],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer
        turn={turn}
        allMessages={[assistant]}
        onFork={() => undefined}
        onForkToWorktree={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="分叉选项"')
    expect(html).not.toContain('按当前模型从此处分叉')
    expect(html).not.toContain('从此处分叉到新 Worktree')
  })
})

describe('Assistant turn generated image thumbnails', () => {
  test('Given 当前 turn 只是读取图片 When 过程组已折叠 Then 不显示本轮生成图片缩略图', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-read-image-turn',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'tool-read-image', name: 'Read', input: { path: 'image.png' } },
          { type: 'text', text: '已读取图片。' },
        ],
        model: 'test-model',
      },
    }
    const readResult = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-read-image',
          content: [
            { type: 'text', text: 'Read image file [image/png]' },
            { type: 'image', data: 'read-image-base64', mimeType: 'image/png' },
          ],
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, readResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, readResult]} />,
    )

    expect(html).not.toContain('data-generated-image-strip="compact"')
    expect(html).not.toContain('本轮生成图片')
  })

  test('Given 当前 turn 的生图结果和其他 turn 图片 When 过程组已折叠 Then 只在操作栏后显示当前 turn 紧凑缩略图', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-image-turn',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'tool-current-image', name: 'mcp__gpt_image__imagegen', input: { prompt: 'logo' } },
          { type: 'text', text: '图片已生成。' },
        ],
        model: 'test-model',
      },
    }
    const currentMarker = JSON.stringify({
      localPath: 'session/current.png',
      filename: 'current.png',
      mediaType: 'image/png',
    })
    const otherMarker = JSON.stringify({
      localPath: 'session/other.png',
      filename: 'other.png',
      mediaType: 'image/png',
    })
    const currentResult = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-current-image',
          content: `[DOMI_IMAGE_ATTACHMENT:${currentMarker}]`,
        }],
      },
    } as unknown as SDKMessage
    const otherResult = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-other-image',
          content: `[DOMI_IMAGE_ATTACHMENT:${otherMarker}]`,
        }],
      },
    } as unknown as SDKMessage
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, currentResult],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant, currentResult, otherResult]} />,
    )

    expect(html).toContain('data-generated-image-strip="compact"')
    expect(html).toContain('本轮生成图片')
    expect(html).toContain('current.png')
    expect(html).not.toContain('other.png')
  })
})

describe('Plan persistence during execution', () => {
  test('Given the approved plan exists only in ExitPlanMode input When development continues Then the plan remains visible', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-exit-plan',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '已完成计划调研' },
          {
            type: 'tool_use',
            id: 'exit-plan-tool',
            name: 'ExitPlanMode',
            input: {
              plan: '# 实施计划\n\n1. 修改计划展示\n2. 补回归测试',
              allowedPrompts: [],
            },
          },
        ],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} sessionId="session-plan" />,
    )

    expect(html).toContain('data-plan-preview="true"')
    expect(html).toContain('实施计划')
    expect(html).toContain('修改计划展示')
    expect(html).toContain('补回归测试')
    expect(html).not.toContain('提交计划审批')
  })
})

describe('Direct workflow feedback persistence', () => {
  test('Given feedback exists only in RequestDirectWorkflow input When the approval is no longer pending Then the feedback remains visible', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-direct-workflow',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '已完成必要探索' },
          {
            type: 'tool_use',
            id: 'direct-workflow-tool',
            name: 'RequestDirectWorkflow',
            input: {
              summary: '修复审批后内容消失',
              details: '实施反馈应随持久化工具调用保留，而不是跟 pending 弹窗一起消失。',
            },
          },
          { type: 'text', text: '已保持 Read Only，未执行修改。' },
        ],
        model: 'test-model',
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant],
      model: 'test-model',
    }

    const html = renderToStaticMarkup(
      <AssistantTurnRenderer turn={turn} allMessages={[assistant]} />,
    )

    expect(html).toContain('修复审批后内容消失')
    expect(html).toContain('实施反馈应随持久化工具调用保留，而不是跟 pending 弹窗一起消失。')
  })
})
