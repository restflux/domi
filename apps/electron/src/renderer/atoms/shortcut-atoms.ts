/**
 * Shortcut Atoms — 快捷键状态管理
 *
 * 管理用户自定义快捷键覆盖配置。
 * 通过 settings IPC 通道持久化到 settings.json。
 */

import { atom } from 'jotai'
import type { ShortcutOverrides } from '@/lib/shortcut-defaults'
import {
  DEFAULT_AGENT_QUEUE_DELIVERY_MODE,
  type AgentQueueDeliveryMode,
} from '@/lib/agent-queue-delivery-mode'

/** 用户自定义快捷键覆盖（从 settings.json 加载） */
export const shortcutOverridesAtom = atom<ShortcutOverrides>({})

/** 发送消息快捷键模式：true = Cmd/Ctrl+Enter 发送，false = Enter 发送 */
export const sendWithCmdEnterAtom = atom(false)

/** Pi steering 队列一次 turn 的消费模式。 */
export const agentSteeringModeAtom = atom<AgentQueueDeliveryMode>(DEFAULT_AGENT_QUEUE_DELIVERY_MODE)

/** Pi follow-up 队列一次 turn 的消费模式。 */
export const agentFollowUpModeAtom = atom<AgentQueueDeliveryMode>(DEFAULT_AGENT_QUEUE_DELIVERY_MODE)
