import { describe, expect, test } from 'bun:test'
import {
  allSlashCommands,
  getSlashCommand,
  registerSlashCommand,
  resolveSlashMenuItems,
  slashMenuGroupLabel,
} from './registry'
import type { SlashCommandContext, SlashCommandDefinition, SlashSkillEntry } from './types'

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    sessionId: 's1',
    getState: <T>() => undefined as T,
    workspaceSlug: 'ws',
    isStreaming: false,
    ...overrides,
  }
}

// 注册只影响全局注册表；本文件通过 commands 参数注入快照，避免测试间污染。
function makeCommands(): SlashCommandDefinition[] {
  return [
    {
      id: 'status',
      label: '查看会话状态',
      description: '显示当前会话运行状态',
      group: 'session',
      behavior: 'execute',
      execute: () => {},
    },
    {
      id: 'workflow',
      label: '切换工作方式',
      description: '研究 / 执行',
      group: 'session',
      behavior: 'picker',
      execute: () => {},
    },
    {
      id: 'memory',
      label: '管理项目知识',
      description: '打开 Memory 管理页',
      group: 'domi',
      behavior: 'execute',
      execute: () => {},
    },
    {
      id: 'compact',
      label: '压缩上下文',
      description: '手动压缩当前上下文',
      group: 'session',
      behavior: 'insert',
      insertText: '/compact ',
    },
    {
      id: 'plan',
      label: '本次先规划，批准后执行',
      description: '本次先规划，批准后执行',
      group: 'session',
      behavior: 'insert',
      insertText: '/plan ',
    },
    {
      id: 'review',
      label: '审查当前改动',
      description: '调用 Review Skill',
      group: 'session',
      behavior: 'execute',
      isAvailable: (ctx) => !ctx.isStreaming,
      execute: () => {},
    },
  ]
}

const skills: SlashSkillEntry[] = [
  { id: 'coach', name: 'Domi 使用顾问', description: '诊断使用摩擦' },
  { id: 'review', name: '代码审查', description: '审查当前改动', sourceLabel: 'Agent 全局' },
  { id: 'pdf', name: 'PDF 处理', description: '读写 PDF' },
]

describe('registerSlashCommand / getSlashCommand', () => {
  registerSlashCommand({ id: 'status', label: '状态', description: '', group: 'session', behavior: 'execute' })
  registerSlashCommand({
    id: 'workflow',
    aliases: ['flow', 'direct', 'read-only'],
    label: '切换工作方式',
    description: '',
    group: 'session',
    behavior: 'picker',
    execute: () => {},
  })

  test('注册后可通过 id 取回', () => {
    expect(getSlashCommand('status')?.id).toBe('status')
  })

  test('别名解析到同一命令，独立 /plan 命令不被 workflow 别名覆盖', () => {
    expect(getSlashCommand('flow')?.id).toBe('workflow')
    expect(getSlashCommand('plan')?.id).toBe('plan')
  })

  test('未注册返回 undefined', () => {
    expect(getSlashCommand('nope')).toBeUndefined()
  })

  test('allSlashCommands 返回已注册命令', () => {
    expect(allSlashCommands().length).toBeGreaterThanOrEqual(2)
  })
})

describe('resolveSlashMenuItems', () => {
  const commands = makeCommands()
  const ctx = makeCtx()

  test('空查询返回分组排序：session → domi → skill', () => {
    const items = resolveSlashMenuItems('', { skills, ctx, commands })
    expect(items.map((i) => i.label)).toEqual([
      '/status',
      '/workflow',
      '/compact',
      '/plan',
      '/review',
      '/memory',
      '/coach',
      '/review',
      '/pdf',
    ])
  })

  test('系统命令排在匹配 Skill 前（/review 冲突）', () => {
    const items = resolveSlashMenuItems('review', { skills, ctx, commands })
    const commandFirst = items.findIndex((i) => i.kind === 'command' && i.id === 'review')
    const skillIndex = items.findIndex((i) => i.kind === 'skill' && i.id === 'review')
    expect(commandFirst).toBeGreaterThanOrEqual(0)
    expect(skillIndex).toBeGreaterThan(commandFirst)
    expect(items[skillIndex]?.sourceLabel).toBe('Agent 全局')
  })

  test('命令匹配 id / label / alias', () => {
    expect(resolveSlashMenuItems('plan', { skills: [], ctx, commands }).map((i) => i.id)).toEqual(['plan'])
    expect(resolveSlashMenuItems('压缩', { skills: [], ctx, commands }).map((i) => i.id)).toEqual(['compact'])
    expect(resolveSlashMenuItems('当前上下文', { skills: [], ctx, commands }).map((i) => i.id)).toEqual(['compact'])
    expect(resolveSlashMenuItems('status', { skills: [], ctx, commands }).map((i) => i.id)).toEqual(['status'])
  })

  test('Skill 按 name / id 过滤', () => {
    const items = resolveSlashMenuItems('pdf', { skills, ctx, commands })
    expect(items.map((i) => i.id)).toEqual(['pdf'])
  })

  test('isAvailable 为 false 的命令不出现', () => {
    const streamingCtx = makeCtx({ isStreaming: true })
    const items = resolveSlashMenuItems('', { skills: [], ctx: streamingCtx, commands })
    expect(items.map((i) => i.id)).not.toContain('review')
  })

  test('insert 命令带 insertText，skill 行带 sourceLabel', () => {
    const compactItems = resolveSlashMenuItems('compact', { skills, ctx, commands })
    expect(compactItems[0]).toMatchObject({ kind: 'command', behavior: 'insert', id: 'compact' })
    expect(compactItems[0]?.label).toBe('/compact')

    const planItems = resolveSlashMenuItems('plan', { skills: [], ctx, commands })
    expect(planItems[0]).toMatchObject({
      kind: 'command',
      behavior: 'insert',
      id: 'plan',
      insertText: '/plan ',
      description: '本次先规划，批准后执行',
    })
  })

  test('行为字段正确映射', () => {
    const items = resolveSlashMenuItems('', { skills: [], ctx, commands })
    expect(items.find((i) => i.id === 'workflow')?.behavior).toBe('picker')
    expect(items.find((i) => i.id === 'memory')?.group).toBe('domi')
  })

  test('命令与 Skill 使用独立分组标题', () => {
    const items = resolveSlashMenuItems('', { skills, ctx, commands })
    expect(slashMenuGroupLabel(items.find((item) => item.kind === 'command')!)).toBe('命令')
    expect(slashMenuGroupLabel(items.find((item) => item.kind === 'skill')!)).toBe('Skills')
  })

  test('hidden compatibility commands stay out of the menu while visible /plan remains selectable', () => {
    const items = resolveSlashMenuItems('', { skills: [], ctx, commands })
    expect(items.map((i) => i.id)).toContain('plan')
    registerSlashCommand({ id: 'legacy-hidden', label: '兼容命令', description: '', group: 'session', behavior: 'execute', hidden: true, execute: () => {} })
    expect(resolveSlashMenuItems('', { skills: [], ctx }).map((i) => i.id)).not.toContain('legacy-hidden')
    expect(getSlashCommand('legacy-hidden')?.id).toBe('legacy-hidden')
  })
})
