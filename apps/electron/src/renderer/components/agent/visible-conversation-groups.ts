import type { AssistantTurn, MessageGroup } from './SDKMessageRenderer'

/**
 * 隐藏控制记录后，重新合并因此变为相邻的同模型 assistant turn。
 * 真正可见的用户消息、系统卡片、模型切换和后台唤醒仍保持独立边界。
 */
export function filterAndMergeConversationGroups(
  groups: MessageGroup[],
  shouldHide: (group: MessageGroup) => boolean,
): MessageGroup[] {
  const visibleGroups: MessageGroup[] = []
  let removedControlSincePreviousVisibleGroup = false

  for (const group of groups) {
    if (shouldHide(group)) {
      removedControlSincePreviousVisibleGroup = true
      continue
    }

    const previous = visibleGroups.at(-1)
    if (
      removedControlSincePreviousVisibleGroup
      && group.type === 'assistant-turn'
      && previous?.type === 'assistant-turn'
      && !group.startsAfterWake
      && previous.model === group.model
    ) {
      const merged: AssistantTurn = {
        ...previous,
        assistantMessages: [...previous.assistantMessages, ...group.assistantMessages],
        turnMessages: [...previous.turnMessages, ...group.turnMessages],
      }
      visibleGroups[visibleGroups.length - 1] = merged
      removedControlSincePreviousVisibleGroup = false
      continue
    }

    visibleGroups.push(group)
    removedControlSincePreviousVisibleGroup = false
  }

  return visibleGroups
}
