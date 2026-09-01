import { test, expect, describe } from 'bun:test'
import {
  readSessionMessagesFromString,
  groupIntoTurns,
  getGroupPreview,
  toTranscript,
  searchTurns,
  selectTurns,
  renderTranscriptMarkdown,
  collapseToolSummaries,
  summarizeToolInput,
} from './index'

/** 把对象数组序列化为 JSONL（每行一个 JSON）。 */
function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

describe('快照去重（格式 B）', () => {
  // 同一 assistant 回合的 3 行递增快照，共享 message.id='m1'
  const raw = jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: '读取文件' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hel' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] }, parent_tool_use_id: null },
    { type: 'result', subtype: 'success' },
  ])

  const turns = toTranscript(groupIntoTurns(readSessionMessagesFromString(raw)))

  test('合并为 user + assistant 两个 turn，下标稳定', () => {
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns.map((t) => t.index)).toEqual([0, 1])
  })

  test('assistant 只取最完整快照，无拼接重复', () => {
    const a = turns[1]!
    expect(a.text).toBe('Hello world')
    expect(a.text).not.toContain('Hel\n')
  })

  test('thinking 块被丢弃', () => {
    expect(turns[1]!.text).not.toContain('想一下')
  })

  test('tool_use 压缩为单行摘要；tool_result 不进正文', () => {
    expect(turns[1]!.toolSummaries).toEqual(['Read file_path=/a'])
    expect(turns[1]!.text).not.toContain('data')
  })

  test('纯 tool_result 的 user 行不产生用户 turn', () => {
    expect(turns.filter((t) => t.role === 'user')).toHaveLength(1)
  })
})

describe('工具折叠 ×N', () => {
  test('连续相同工具摘要折叠计数', () => {
    expect(collapseToolSummaries(['OCR p=1', 'OCR p=1', 'OCR p=1', 'Read f=a'])).toEqual(['OCR p=1 ×3', 'Read f=a'])
  })

  test('summarizeToolInput 跳过空值并截断长值', () => {
    expect(summarizeToolInput('Read', { file_path: '/a', limit: 0, empty: '' })).toBe('Read file_path=/a limit=0')
    const long = 'x'.repeat(200)
    expect(summarizeToolInput('Bash', { command: long }).length).toBeLessThan(100)
  })
})

describe('SDK 压缩状态分组', () => {
  test('Given 压缩从进行中变为失败 When 分组 Then 原位更新同一个状态组', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '压缩测试' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: '准备压缩' }] }, parent_tool_use_id: null },
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'token budget exhausted' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((g) => g.type)).toEqual(['user', 'assistant-turn', 'system'])
    expect(getGroupPreview(groups[2]!)).toBe('上下文压缩失败')
    expect(groups[2]).toMatchObject({
      type: 'system',
      identityMessage: { status: 'compacting' },
      message: { compact_result: 'failed' },
    })
  })

  test('Given 压缩无需执行 When 分组 Then 用 no-op 终态替换进行中状态', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '/compact' }] }, parent_tool_use_id: null },
      { type: 'system', subtype: 'compacting' },
      { type: 'system', subtype: 'status', compact_result: 'noop', message: '当前上下文较小，暂时无需压缩。' },
      { type: 'result', subtype: 'success' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((g) => g.type)).toEqual(['user', 'system'])
    expect(getGroupPreview(groups[1]!)).toBe('当前上下文较小，暂时无需压缩。')
    expect(groups[1]).toMatchObject({
      type: 'system',
      identityMessage: { subtype: 'compacting' },
      message: { compact_result: 'noop' },
    })
  })

  test('Given 压缩产生多个成功事件 When 分组 Then 只保留一条已完成分界线', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '/compact' }] }, parent_tool_use_id: null },
      { type: 'system', subtype: 'compacting' },
      { type: 'system', subtype: 'status', compact_result: 'success' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'result', subtype: 'success' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((g) => g.type)).toEqual(['user', 'system'])
    expect(getGroupPreview(groups[1]!)).toBe('上下文已压缩')
    expect(groups[1]).toMatchObject({
      type: 'system',
      identityMessage: { subtype: 'compacting' },
      message: { subtype: 'compact_boundary' },
    })
  })

  test('Given 上一次压缩已结束且下一次立即开始 When 分组 Then 保留两个压缩周期', () => {
    const raw = jsonl([
      { type: 'system', subtype: 'compacting' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'compacting' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups).toHaveLength(2)
    expect(getGroupPreview(groups[0]!)).toBe('上下文已压缩')
    expect(getGroupPreview(groups[1]!)).toBe('正在压缩上下文...')
  })
})

describe('可持久展示的系统消息分组', () => {
  test('Given Preview 调整确认在工具消息持久化前写入 When 分组 Then 确认卡仍生成独立 system group', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '继续调整布局' }] }, parent_tool_use_id: null },
      {
        type: 'system',
        subtype: 'worktree_preview_revision_requested',
        request_id: 'request-1',
        iteration: 1,
        task: '继续调整布局',
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'revision-1', name: 'RequestWorktreePreviewRevision', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'revision-1', content: 'requested' }] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((group) => group.type)).toEqual(['user', 'system', 'assistant-turn'])
    expect(groups[1]).toMatchObject({
      type: 'system',
      message: {
        subtype: 'worktree_preview_revision_requested',
        request_id: 'request-1',
      },
    })
  })

  test('Given ReadyForReview 卡在终止工具消息前持久化 When 分组 Then 完成卡排在执行过程后并提供导航摘要', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '完成这个功能' }] }, parent_tool_use_id: null },
      {
        type: 'system',
        subtype: 'worktree_ready_for_review',
        review_id: 'review-1',
        summary: '修复完成态显示，并补齐消息导航摘要',
        message: 'Worktree 已准备好同步到 Local 验收。',
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ready-1', name: 'ReadyForReview', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ready-1', content: 'ready' }] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn', 'system'])
    expect(getGroupPreview(groups[1]!)).toBe('执行过程：1 次工具调用')
    expect(getGroupPreview(groups[2]!)).toBe('已完成：修复完成态显示，并补齐消息导航摘要')
    expect(groups[2]).toMatchObject({
      type: 'system',
      message: {
        subtype: 'worktree_ready_for_review',
        review_id: 'review-1',
      },
    })
  })

  test('Given 后续迭代追加了自己的验收卡 When 分组 Then 每张卡都跟随各自的过程且不跨越用户输入', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '先完成第一版' }] }, parent_tool_use_id: null },
      {
        type: 'system',
        subtype: 'worktree_ready_for_review',
        review_id: 'review-1',
        summary: '第一版验收摘要',
        message: 'Worktree 已准备好同步到 Local 验收。',
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ready-1', name: 'ReadyForReview', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ready-1', content: 'ready' }] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success' },
      { type: 'user', message: { content: [{ type: 'text', text: '还要修复历史消息展开' }] }, parent_tool_use_id: null },
      {
        type: 'system',
        subtype: 'worktree_ready_for_review',
        review_id: 'review-2',
        summary: '包含后续调整的最新验收摘要',
        message: 'Worktree 已准备好同步到 Local 验收。',
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: '已继续修改并验证。' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ready-2', name: 'ReadyForReview', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ready-2', content: 'ready' }] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((group) => group.type)).toEqual([
      'user', 'assistant-turn', 'system', 'user', 'assistant-turn', 'system',
    ])
    expect(groups[2]).toMatchObject({
      type: 'system',
      message: { subtype: 'worktree_ready_for_review', review_id: 'review-1' },
    })
    expect(groups.at(-1)).toMatchObject({
      type: 'system',
      message: { subtype: 'worktree_ready_for_review', review_id: 'review-2' },
    })
  })

  test('Given 新一轮已落盘 ReadyForReview 工具调用但新卡尚未写入 When 分组 Then 上一轮旧卡不跨越用户输入跑到新一轮过程之后', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '先完成第一版' }] }, parent_tool_use_id: null },
      {
        type: 'system',
        subtype: 'worktree_ready_for_review',
        review_id: 'review-1',
        summary: '第一版验收摘要',
        message: 'Worktree 已准备好同步到 Local 验收。',
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ready-1', name: 'ReadyForReview', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ready-1', content: 'ready' }] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success' },
      { type: 'user', message: { content: [{ type: 'text', text: '继续' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'text', text: '新一轮正在输出的正文。' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ready-2', name: 'ReadyForReview', input: {} }] }, parent_tool_use_id: null },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    // 旧卡必须留在上一轮过程之后、新输入之前，不能被搬到新一轮 turn 尾部
    expect(groups.map((group) => group.type)).toEqual([
      'user', 'assistant-turn', 'system', 'user', 'assistant-turn',
    ])
    expect(groups[2]).toMatchObject({
      type: 'system',
      message: { subtype: 'worktree_ready_for_review', review_id: 'review-1' },
    })
    expect(getGroupPreview(groups[4]!)).toBe('新一轮正在输出的正文。')
  })

  test('Given Worktree handoff 成功提示跟在完成的 assistant turn 后 When 分组 Then 生成独立可渲染的 system group', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '换个 Worktree 继续' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fork-1', name: 'ForkToWorktree', input: {} }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fork-1', content: 'scheduled' }] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success' },
      {
        type: 'system',
        subtype: 'worktree_handoff_created',
        child_session_id: 'child-1',
        child_session_title: '继续任务 (worktree)',
        message: 'managed Worktree 子会话已创建，任务将在新会话中继续。',
      },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn', 'system'])
    expect(groups[2]).toMatchObject({
      type: 'system',
      message: {
        subtype: 'worktree_handoff_created',
        child_session_id: 'child-1',
      },
    })
  })
})

describe('旧扁平格式（格式 A）归一', () => {
  const raw = jsonl([
    { id: '1', role: 'user', content: '你好', createdAt: 1 },
    { id: '2', role: 'assistant', content: '旧版回复', createdAt: 2 },
    { id: '3', role: 'assistant', content: '', createdAt: 3 },
  ])
  const turns = toTranscript(groupIntoTurns(readSessionMessagesFromString(raw)))

  test('role 字段被识别并转换为 SDKMessage', () => {
    expect(turns[0]).toMatchObject({ role: 'user', text: '你好' })
    expect(turns[1]).toMatchObject({ role: 'assistant', text: '旧版回复' })
  })
})

describe('容错与渐进式读取原语', () => {
  const raw = jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: '问题甲' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: '答案含关键词 needle' }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'text', text: '问题乙' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: '无关回答' }] }, parent_tool_use_id: null },
  ])

  test('损坏行被静默跳过', () => {
    const withBad = raw + '\n{ 坏行不是 json\n'
    const msgs = readSessionMessagesFromString(withBad)
    expect(msgs.length).toBe(4)
  })

  const turns = toTranscript(groupIntoTurns(readSessionMessagesFromString(raw)))

  test('searchTurns 返回命中 turn 下标', () => {
    const hits = searchTurns(turns, 'needle')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.index).toBe(1)
    expect(hits[0]!.snippet).toContain('needle')
  })

  test('selectTurns 按 range 截取', () => {
    expect(selectTurns(turns, { range: [2, 3] }).map((t) => t.index)).toEqual([2, 3])
    expect(selectTurns(turns, { head: 1 }).map((t) => t.index)).toEqual([0])
    expect(selectTurns(turns, { tail: 1 }).map((t) => t.index)).toEqual([3])
  })

  test('renderTranscriptMarkdown 按角色分段', () => {
    const md = renderTranscriptMarkdown(turns, { sessionId: 'demo' })
    expect(md).toContain('# Session: demo')
    expect(md).toContain('## 用户')
    expect(md).toContain('## 助手')
    expect(md).toContain('答案含关键词 needle')
  })
})
