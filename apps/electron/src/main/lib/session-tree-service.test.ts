import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@domi/shared'
import {
  buildSessionTree,
  filterMessagesToActivePiBranch,
  prependHistoricalTranscript,
  readPiSessionEntries,
  resolveNavigationTarget,
  type PiSessionEntry,
} from './session-tree-service'

function user(id: string, parentId: string | null, text: string): PiSessionEntry {
  return { type: 'message', id, parentId, message: { role: 'user', content: [{ type: 'text', text }] } }
}

function assistant(id: string, parentId: string, text: string): PiSessionEntry {
  return { type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function sdkUser(text: string): SDKMessage {
  return { type: 'user', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null } as SDKMessage
}

function sdkAssistant(uuid: string, text: string): SDKMessage {
  return { type: 'assistant', uuid, message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null } as SDKMessage
}

function sdkToolResult(): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    parent_tool_use_id: null,
  } as SDKMessage
}

describe('session-tree-service', () => {
  const entries: PiSessionEntry[] = [
    user('u1', null, '第一问'),
    assistant('a1', 'u1', '第一答'),
    user('u2', 'a1', '原分支'),
    assistant('a2', 'u2', '原回答'),
    user('u3', 'a1', '新分支'),
    assistant('a3', 'u3', '新回答'),
  ]

  test('构建完整树并按可见叶统计分支', () => {
    const tree = buildSessionTree(entries)
    expect(tree.branchCount).toBe(2)
    expect(tree.activeLeafId).toBe('a3')
    expect(tree.nodes.find((node) => node.id === 'u3')).toMatchObject({
      parentId: 'a1',
      branchMessageIndex: 2,
      isOnActiveBranch: true,
    })
    expect(tree.nodes.find((node) => node.id === 'a2')?.isOnActiveBranch).toBe(false)
  })

  test('同一 turn 的工具 assistant/tool result 折叠进最终 assistant 节点', () => {
    const toolEntries: PiSessionEntry[] = [
      user('tool-u', null, '查文件'),
      {
        type: 'message',
        id: 'tool-a1',
        parentId: 'tool-u',
        message: { role: 'assistant', content: [{ type: 'toolCall' }] },
      },
      {
        type: 'message',
        id: 'tool-r1',
        parentId: 'tool-a1',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] },
      },
      assistant('tool-a2', 'tool-r1', '完成'),
    ]
    const tree = buildSessionTree(toolEntries)
    expect(tree.nodes.map((node) => node.id)).toEqual(['tool-u', 'tool-a2'])
    expect(tree.nodes[1]).toMatchObject({ parentId: 'tool-u', toolCount: 1, branchMessageIndex: 1 })
    expect(buildSessionTree(toolEntries.slice(0, 3)).activeLeafId).toBe('tool-a1')
  })

  test('旧会话内部压缩续跑 entry 不生成树节点且不能回填编辑器', () => {
    const internalEntries: PiSessionEntry[] = [
      user('internal-u1', null, '第一问'),
      assistant('internal-a1', 'internal-u1', '第一答'),
      user('internal-cont', 'internal-a1', '<domi_compaction_continuation>\n继续原任务\n</domi_compaction_continuation>'),
      assistant('internal-a2', 'internal-cont', '第二答'),
    ]

    const tree = buildSessionTree(internalEntries)
    expect(tree.nodes.map((node) => node.id)).toEqual(['internal-u1', 'internal-a1', 'internal-a2'])
    expect(tree.nodes.find((node) => node.id === 'internal-a2')?.parentId).toBe('internal-a1')
    expect(resolveNavigationTarget(internalEntries, 'internal-cont')).toEqual({ activeLeafId: 'internal-a1' })
  })

  test.each([
    ['domi_auto_compaction_continuation', '<domi_compaction_continuation>继续</domi_compaction_continuation>'],
    ['domi_incomplete_turn_continuation', '<domi_incomplete_turn_continuation>继续</domi_incomplete_turn_continuation>'],
  ])('新的 display=false custom continuation %s 在重载和树导航中保持隐藏', (customType, text) => {
    const hiddenCustomEntries: PiSessionEntry[] = [
      user('custom-u1', null, '第一问'),
      assistant('custom-a1', 'custom-u1', '第一答'),
      {
        type: 'custom_message',
        id: 'custom-cont',
        parentId: 'custom-a1',
        customType,
        display: false,
        content: [{ type: 'text', text }],
      },
      assistant('custom-a2', 'custom-cont', '第二答'),
    ]

    const tree = buildSessionTree(hiddenCustomEntries)
    expect(tree.nodes.map((node) => node.id)).toEqual(['custom-u1', 'custom-a1', 'custom-a2'])
    expect(tree.nodes.find((node) => node.id === 'custom-a2')?.parentId).toBe('custom-a1')
    expect(resolveNavigationTarget(hiddenCustomEntries, 'custom-cont')).toEqual({ activeLeafId: 'custom-a1' })
  })

  test('user 节点导航回到父节点并返回编辑文本', () => {
    expect(resolveNavigationTarget(entries, 'u3')).toEqual({
      editorText: '新分支',
      activeLeafId: 'a1',
    })
    expect(resolveNavigationTarget(entries, 'a2')).toEqual({ activeLeafId: 'a2' })
  })

  test('单分支会话仍可编辑 user 或从 assistant 继续', () => {
    const singleBranchEntries = entries.slice(0, 2)
    const tree = buildSessionTree(singleBranchEntries)
    expect(tree.branchCount).toBe(1)
    expect(tree.nodes.map((node) => node.id)).toEqual(['u1', 'a1'])
    expect(resolveNavigationTarget(singleBranchEntries, 'u1')).toEqual({
      editorText: '第一问',
      activeLeafId: null,
    })
    expect(resolveNavigationTarget(singleBranchEntries, 'a1')).toEqual({ activeLeafId: 'a1' })
  })

  test('即使缺少 Pi bindings，旧 transcript 中的内部续跑气泡也会被过滤', () => {
    const messages = [
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
      sdkUser('<domi_compaction_continuation>\n继续原任务\n</domi_compaction_continuation>'),
      sdkAssistant('ui-a2', '第二答'),
    ]

    const result = filterMessagesToActivePiBranch(messages, [], undefined)
    expect(result.map((message) => message.type === 'user'
      ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
      : (message as { uuid?: string }).uuid)).toEqual(['第一问', 'ui-a1', 'ui-a2'])
  })

  test('线性 transcript 仅保留当前 Pi 活跃分支', () => {
    const messages = [
      sdkUser('第一问'), sdkAssistant('ui-a1', '第一答'),
      sdkUser('原分支'), sdkAssistant('ui-a2', '原回答'),
      sdkUser('新分支'), sdkAssistant('ui-a3', '新回答'),
    ]
    const result = filterMessagesToActivePiBranch(messages, entries, {
      'ui-a1': 'a1',
      'ui-a2': 'a2',
      'ui-a3': 'a3',
    })
    expect(result.map((message) => message.type === 'user'
      ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
      : (message as { uuid?: string }).uuid,
    )).toEqual(['第一问', 'ui-a1', '新分支', 'ui-a3'])
  })

  test('Pi transcript 存在排队用户消息时，补回 Domi transcript 遗漏的 turn 边界', () => {
    const queuedEntries: PiSessionEntry[] = [
      user('u1', null, '第一问'),
      assistant('a1', 'u1', '第一答'),
      user('queued-u', 'a1', '风险6怎么会是风险？'),
      assistant('a2', 'queued-u', '第二答'),
    ]
    queuedEntries[2]!.timestamp = '2026-08-14T08:05:33.642Z'
    const messages = [
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
      sdkAssistant('ui-a2', '第二答'),
    ]

    const result = filterMessagesToActivePiBranch(messages, queuedEntries, {
      'ui-a1': 'a1',
      'ui-a2': 'a2',
    })

    expect(result.map((message) => message.type === 'user'
      ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
      : (message as { uuid?: string }).uuid,
    )).toEqual(['第一问', 'ui-a1', '风险6怎么会是风险？', 'ui-a2'])
    expect((result[2] as SDKMessage & { uuid?: string; _createdAt?: number }).uuid)
      .toBe('pi-recovered-user:queued-u')
    expect((result[2] as SDKMessage & { _createdAt?: number })._createdAt)
      .toBe(Date.parse('2026-08-14T08:05:33.642Z'))
  })

  test('多分支执行中保留活跃路径上尚未绑定 assistant 的最新用户 turn', () => {
    const runningEntries: PiSessionEntry[] = [
      user('u1', null, '第一问'),
      assistant('a1', 'u1', '第一答'),
      user('old-u', 'a1', '旧分支问题'),
      assistant('old-a', 'old-u', '旧分支回答'),
      user('active-running-u', 'a1', '活跃分支正在执行'),
      user('inactive-later-u', 'a1', 'JSONL 后追加的非活跃分支'),
    ]
    const messages = [
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
      sdkUser('旧分支问题'),
      sdkAssistant('ui-old-a', '旧分支回答'),
    ]

    const result = filterMessagesToActivePiBranch(
      messages,
      runningEntries,
      { 'ui-a1': 'a1', 'ui-old-a': 'old-a' },
      'active-running-u',
    )

    expect(result.map((message) => message.type === 'user'
      ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
      : (message as { uuid?: string }).uuid,
    )).toEqual(['第一问', 'ui-a1', '活跃分支正在执行'])
    expect(result[2]).toMatchObject({
      uuid: 'pi-recovered-user:active-running-u',
      _recoveredPiEntryId: 'active-running-u',
    })
  })

  test('多分支 transcript 已有未绑定用户边界时，过滤后仍以活跃 Pi entry 恢复且不重复', () => {
    const runningEntries: PiSessionEntry[] = [
      user('u1', null, '重复问题'),
      assistant('a1', 'u1', '第一答'),
      user('old-u', 'a1', '旧分支'),
      assistant('old-a', 'old-u', '旧回答'),
      user('active-u', 'a1', '重复问题'),
    ]
    const messages = [
      sdkUser('重复问题'),
      sdkAssistant('ui-a1', '第一答'),
      sdkUser('旧分支'),
      sdkAssistant('ui-old-a', '旧回答'),
      sdkUser('重复问题'),
    ]

    const result = filterMessagesToActivePiBranch(
      messages,
      runningEntries,
      { 'ui-a1': 'a1', 'ui-old-a': 'old-a' },
      'active-u',
    )

    expect(result.map((message) => message.type === 'user'
      ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
      : (message as { uuid?: string }).uuid,
    )).toEqual(['重复问题', 'ui-a1', '重复问题'])
    expect(result.filter((message) => (message as { _recoveredPiEntryId?: string })._recoveredPiEntryId === 'active-u')).toHaveLength(1)
  })

  test('单分支会话从此继续到历史中间时，截掉活跃点之后的 transcript', () => {
    const singleBranchEntries = entries.slice(0, 4)
    const messages = [
      sdkUser('第一问'), sdkAssistant('ui-a1', '第一答'),
      sdkUser('第二问'), sdkAssistant('ui-a2', '第二答'),
    ]
    const result = filterMessagesToActivePiBranch(
      messages,
      singleBranchEntries,
      { 'ui-a1': 'a1', 'ui-a2': 'a2' },
      'a1',
    )
    expect(result.map((message) => message.type === 'user'
      ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
      : (message as { uuid?: string }).uuid,
    )).toEqual(['第一问', 'ui-a1'])
  })

  test('编辑第一条 user 消息时活跃路径为空', () => {
    const result = filterMessagesToActivePiBranch(
      [sdkUser('第一问'), sdkAssistant('ui-a1', '第一答')],
      entries,
      { 'ui-a1': 'a1' },
      null,
    )
    expect(result).toEqual([])
  })

  test('纯图片消息保留空文本占位，后续用户消息摘要不错位', () => {
    const imageEntries: PiSessionEntry[] = [
      user('img-u1', null, '第一问'),
      assistant('img-a1', 'img-u1', '第一答'),
      {
        type: 'message',
        id: 'img-u2',
        parentId: 'img-a1',
        message: { role: 'user', content: [{ type: 'image' }] },
      },
      assistant('img-a2', 'img-u2', '看图回答'),
      user('img-u3', 'img-a2', '第三问'),
    ]
    // rawUserTexts 与 Pi 用户条目严格按序对齐：纯图片消息对应空字符串占位
    const tree = buildSessionTree(imageEntries, undefined, ['第一问', '', '第三问'])
    expect(tree.nodes.find((node) => node.id === 'img-u2')?.summary).toBe('[图片]')
    expect(tree.nodes.find((node) => node.id === 'img-u3')?.summary).toBe('第三问')
  })

  test('摘要剥离 attached_files 引用块并以前缀标识附件，正文不被路径挤占', () => {
    const attachEntries: PiSessionEntry[] = [
      user('att-u1', null, '<attached_files>\n- image.png: C:\\tmp\\session\\image.png\n</attached_files>\n\n帮我看看这张图'),
      assistant('att-a1', 'att-u1', '看到了'),
      user('att-u2', 'att-a1', '<attached_files>\n- notes.txt: C:\\tmp\\session\\notes.txt\n</attached_files>\n\n总结这个文件'),
      user('att-u3', 'att-a1', '<attached_files>\n- photo.webp: C:\\tmp\\session\\photo.webp\n</attached_files>'),
    ]
    const tree = buildSessionTree(attachEntries)
    expect(tree.nodes.find((node) => node.id === 'att-u1')?.summary).toBe('[图片] 帮我看看这张图')
    expect(tree.nodes.find((node) => node.id === 'att-u2')?.summary).toBe('[附件] 总结这个文件')
    expect(tree.nodes.find((node) => node.id === 'att-u3')?.summary).toBe('[图片]')
  })

  test('用户摘要以 Pi entry 为真源并剥离 runtime 动态上下文', () => {
    const currentEntries: PiSessionEntry[] = [
      user('current-u', null, [
        '<conversation_history>旧历史</conversation_history>',
        '**当前时间: Wednesday, August 5, 2026 at 11:00 PM GMT+8**',
        '<workspace_state>项目: domi</workspace_state>',
        '<working_directory>D:\\workspace\\domi</working_directory>',
        '当前问题',
      ].join('\n\n')),
      assistant('current-a', 'current-u', '当前回答'),
    ]
    expect(buildSessionTree(currentEntries).nodes.find((node) => node.id === 'current-u')?.summary).toBe('当前问题')
    expect(resolveNavigationTarget(currentEntries, 'current-u').editorText).toBe('当前问题')
  })

  test('Pi runtime 重启后把较早 transcript 补成不可导航的线性历史前缀', () => {
    const currentEntries: PiSessionEntry[] = [
      user('current-u', null, '当前问题'),
      assistant('current-a', 'current-u', '当前回答'),
      // 模拟已送达 Pi、但没有写入 Domi transcript 的中间用户消息。
      user('pi-only-u', 'current-a', '仅 Pi 中存在的问题'),
      assistant('pi-only-a', 'pi-only-u', '仅 Pi 中存在的回答'),
    ]
    const messages = [
      sdkUser('较早问题'),
      sdkAssistant('old-a', '较早回答'),
      sdkToolResult(),
      sdkUser('当前问题'),
      sdkAssistant('current-ui-a', '当前回答'),
    ]
    // Pi 首条 user 比对应的 persisted user 晚数百毫秒，历史边界按时间戳识别。
    currentEntries[0]!.timestamp = '2026-08-05T10:00:00.500Z'
    ;(messages[0] as SDKMessage & { _createdAt: number })._createdAt = Date.parse('2026-08-05T09:00:00Z')
    ;(messages[1] as SDKMessage & { _createdAt: number })._createdAt = Date.parse('2026-08-05T09:00:01Z')
    ;(messages[3] as SDKMessage & { _createdAt: number })._createdAt = Date.parse('2026-08-05T10:00:00Z')
    ;(messages[4] as SDKMessage & { _createdAt: number })._createdAt = Date.parse('2026-08-05T10:00:01Z')
    const tree = buildSessionTree(currentEntries)
    const merged = prependHistoricalTranscript(tree, messages)

    expect(merged.nodes.map((node) => node.summary)).toEqual([
      '较早问题',
      '较早回答',
      '当前问题',
      '当前回答',
      '仅 Pi 中存在的问题',
      '仅 Pi 中存在的回答',
    ])
    expect(merged.nodes.slice(0, 2).every((node) => node.canNavigate === false)).toBe(true)
    expect(merged.nodes.slice(2).every((node) => node.canNavigate === true)).toBe(true)
    expect(merged.nodes.map((node) => node.branchMessageIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(merged.nodes[2]?.parentId).toBe(merged.nodes[1]?.id)
  })

  test('没有 transcript override 时也会剥离 Pi 注入的恢复历史与工作区上下文', () => {
    const wrapped = [
      '<conversation_history>旧摘要</conversation_history>',
      '**当前时间: Wednesday, August 5, 2026 at 11:00 PM GMT+8**',
      '<workspace_state>项目: domi</workspace_state>',
      '<working_directory>D:\\workspace\\domi</working_directory>',
      '真实问题',
    ].join('\n\n')
    expect(buildSessionTree([user('wrapped-u', null, wrapped)]).nodes[0]?.summary).toBe('真实问题')
  })

  test('新 Pi artifact 分支过滤保留不在当前 artifact 中的共享历史', () => {
    const currentEntries: PiSessionEntry[] = [
      user('current-u1', null, '当前第一问'),
      assistant('current-a1', 'current-u1', '当前第一答'),
      user('current-u2', 'current-a1', '旧分支'),
      assistant('current-a2', 'current-u2', '旧回答'),
      user('current-u3', 'current-a1', '活跃分支'),
      assistant('current-a3', 'current-u3', '活跃回答'),
    ]
    const messages = [
      sdkUser('较早问题'), sdkAssistant('old-ui-a', '较早回答'),
      sdkUser('当前第一问'), sdkAssistant('current-ui-a1', '当前第一答'),
      sdkUser('旧分支'), sdkAssistant('current-ui-a2', '旧回答'),
      sdkUser('活跃分支'), sdkAssistant('current-ui-a3', '活跃回答'),
    ]
    const filtered = filterMessagesToActivePiBranch(messages, currentEntries, {
      'old-ui-a': 'old-artifact-entry',
      'current-ui-a1': 'current-a1',
      'current-ui-a2': 'current-a2',
      'current-ui-a3': 'current-a3',
    })
    expect(filtered.map((message) => message.type === 'user'
      ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
      : (message as { uuid?: string }).uuid,
    )).toEqual(['较早问题', 'old-ui-a', '当前第一问', 'current-ui-a1', '活跃分支', 'current-ui-a3'])
  })

  test('未变化的 Pi JSONL 复用解析缓存，追加后自动失效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'domi-session-tree-'))
    const sessionFile = join(dir, 'session.jsonl')
    try {
      writeFileSync(sessionFile, `${JSON.stringify(user('cache-u', null, '缓存测试'))}\n`)
      const first = readPiSessionEntries(sessionFile)
      const cached = readPiSessionEntries(sessionFile)
      expect(cached).toBe(first)

      appendFileSync(sessionFile, `${JSON.stringify(assistant('cache-a', 'cache-u', '已更新'))}\n`)
      const updated = readPiSessionEntries(sessionFile)
      expect(updated).not.toBe(first)
      expect(updated.map((entry) => entry.id)).toEqual(['cache-u', 'cache-a'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
