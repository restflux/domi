/**
 * Slash 命令注册表 — 注册 / 解析 / 菜单合并。
 *
 * 设计目标：扩命令只加文件。`registerSlashCommand` 在模块加载时注册，
 * 与 CLI 的 `registry.ts` 同构；菜单层通过 `resolveSlashMenuItems` 拿到
 * 「系统命令（分组排序）→ Skills」的合并列表，系统命令始终排在匹配 Skill 前。
 */
import type {
  SlashCommandContext,
  SlashCommandDefinition,
  SlashMenuItem,
  SlashSkillEntry,
} from './types'
export type { SlashMenuItem, SlashSkillEntry } from './types'

const commands = new Map<string, SlashCommandDefinition>()
const aliases = new Map<string, string>()

export function registerSlashCommand(cmd: SlashCommandDefinition): void {
  commands.set(cmd.id, cmd)
  for (const alias of cmd.aliases ?? []) aliases.set(alias, cmd.id)
}

export function getSlashCommand(idOrAlias: string): SlashCommandDefinition | undefined {
  // id 优先，别名次之：独立命令（如 /plan）应命中自身而非其他命令的兼容别名。
  return commands.get(idOrAlias) ?? commands.get(aliases.get(idOrAlias) ?? '')
}

export function allSlashCommands(): SlashCommandDefinition[] {
  return [...commands.values()]
}

function commandMatches(cmd: SlashCommandDefinition, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (cmd.id.toLowerCase().includes(q)) return true
  if (cmd.label.toLowerCase().includes(q)) return true
  if (cmd.description.toLowerCase().includes(q)) return true
  return (cmd.aliases ?? []).some((alias) => alias.toLowerCase().includes(q))
}

const GROUP_ORDER: readonly SlashCommandDefinition['group'][] = ['session', 'domi']

export function slashMenuGroupLabel(item: SlashMenuItem): string {
  return item.kind === 'command' ? '命令' : 'Skills'
}

export interface ResolveSlashMenuOptions {
  skills: SlashSkillEntry[]
  ctx: SlashCommandContext
  /** 测试可注入命令快照；缺省使用全局注册表。 */
  commands?: SlashCommandDefinition[]
}

export function resolveSlashMenuItems(
  query: string,
  options: ResolveSlashMenuOptions,
): SlashMenuItem[] {
  const { skills, ctx } = options
  const source = options.commands ?? [...commands.values()]
  const items: SlashMenuItem[] = []

  // 系统命令：按分组顺序（会话控制 → Domi），命令名/别名过滤。
  for (const group of GROUP_ORDER) {
    for (const cmd of source) {
      if (cmd.group !== group) continue
      if (cmd.hidden) continue
      if (cmd.isAvailable && !cmd.isAvailable(ctx)) continue
      if (!commandMatches(cmd, query)) continue
      items.push({
        kind: 'command',
        id: cmd.id,
        label: `/${cmd.id}`,
        name: cmd.label,
        description: cmd.description,
        group: cmd.group,
        behavior: cmd.behavior,
        insertText: cmd.insertText,
      })
    }
  }

  // Skills：与命令重名时命令已排在前面，Skill 行仍展示并标注来源。
  const q = query.trim().toLowerCase()
  for (const skill of skills) {
    if (q && !skill.name.toLowerCase().includes(q) && !skill.id.toLowerCase().includes(q)) {
      continue
    }
    items.push({
      kind: 'skill',
      id: skill.id,
      label: `/${skill.id}`,
      name: skill.name,
      description: skill.description ?? '',
      group: 'skill',
      behavior: 'skill',
      sourceLabel: skill.sourceLabel,
    })
  }

  return items
}
