/**
 * Slash 命令执行路由 — 把命令 id 解析为具体行为。
 *
 * execute 定义里不依赖 React：需要读取 atom 时通过 ctx.getState，需要写
 * atom / IPC / 导航时由 AgentView 注入的 handler 完成（见 builtin-session 的
 * execute 实现与 AgentView 的挂载）。insert 行为由菜单层处理 insertText，不进入这里。
 */
import { getSlashCommand } from './registry'
import type { SlashCommandContext } from './types'

/**
 * 执行命令。返回 true 表示命令存在并已路由（execute 可能实际未做任何事，
 * 例如 picker 类命令由菜单层处理）；false 表示命令未注册，调用方可告警。
 */
export function executeSlashCommand(
  commandId: string,
  args: string[],
  ctx: SlashCommandContext,
): boolean {
  const cmd = getSlashCommand(commandId)
  if (!cmd) return false
  if (!cmd.execute) return true
  cmd.execute(ctx, args)
  return true
}
