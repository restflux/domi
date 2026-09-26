import type { SDKContentBlock } from '@domi/shared'

/** 没有耗时的历史消息保留过程入口；Worktree 交接保留专属完成状态。 */
export function getWorkProcessFallbackLabel(blocks: readonly SDKContentBlock[]): string {
  return blocks.some((block) => block.type === 'tool_use' && block.name === 'ForkToWorktree')
    ? '已安排 managed Worktree 子会话，启动后将自动切换'
    : '工作过程'
}
