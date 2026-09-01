/**
 * 系统提示词管理服务
 *
 * 统一管理 Chat 提示词与 Work/Pi 附加提示词。
 * 存储在 ~/.domi/system-prompts.json，并兼容仅包含 Chat 提示词及单选 Work 提示词的旧配置。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSystemPromptsPath } from './config-paths'
import {
  BUILTIN_DEFAULT_ID,
  BUILTIN_DEFAULT_PROMPT,
  BUILTIN_WORK_PRODUCT_DELIVERY_ID,
  BUILTIN_WORK_PRODUCT_DELIVERY_PROMPT,
} from '@domi/shared'
import type {
  SystemPrompt,
  SystemPromptConfig,
  SystemPromptCreateInput,
  SystemPromptScope,
  SystemPromptUpdateInput,
} from '@domi/shared'

interface LegacySystemPromptConfig extends Partial<SystemPromptConfig> {
  defaultWorkPromptId?: string
  workPromptEnabled?: boolean
}

/** 默认配置 */
function getDefaultConfig(): SystemPromptConfig {
  return {
    prompts: [
      { ...BUILTIN_DEFAULT_PROMPT },
      { ...BUILTIN_WORK_PRODUCT_DELIVERY_PROMPT },
    ],
    defaultPromptId: BUILTIN_DEFAULT_ID,
    enabledWorkPromptIds: [BUILTIN_WORK_PRODUCT_DELIVERY_ID],
    appendDateTimeAndUserName: true,
  }
}

function promptScope(prompt: Pick<SystemPrompt, 'scope'> | { scope?: unknown }): SystemPromptScope {
  return prompt.scope === 'work' ? 'work' : 'chat'
}

function normalizeConfig(input: LegacySystemPromptConfig): SystemPromptConfig {
  const prompts = Array.isArray(input.prompts)
    ? input.prompts.map((prompt) => ({
        ...prompt,
        scope: promptScope(prompt),
      }))
    : []

  const builtinChatIndex = prompts.findIndex((prompt) => prompt.id === BUILTIN_DEFAULT_ID)
  if (builtinChatIndex === -1) prompts.unshift({ ...BUILTIN_DEFAULT_PROMPT })
  else prompts[builtinChatIndex] = { ...BUILTIN_DEFAULT_PROMPT }

  const builtinWorkIndex = prompts.findIndex((prompt) => prompt.id === BUILTIN_WORK_PRODUCT_DELIVERY_ID)
  if (builtinWorkIndex === -1) prompts.push({ ...BUILTIN_WORK_PRODUCT_DELIVERY_PROMPT })
  else prompts[builtinWorkIndex] = { ...BUILTIN_WORK_PRODUCT_DELIVERY_PROMPT }

  const chatPrompts = prompts.filter((prompt) => prompt.scope === 'chat')
  const workPrompts = prompts.filter((prompt) => prompt.scope === 'work')
  const defaultPromptId = chatPrompts.some((prompt) => prompt.id === input.defaultPromptId)
    ? input.defaultPromptId
    : BUILTIN_DEFAULT_ID

  let requestedWorkIds: string[]
  if (Array.isArray(input.enabledWorkPromptIds)) {
    requestedWorkIds = input.enabledWorkPromptIds.filter((id): id is string => typeof id === 'string')
  } else if (input.workPromptEnabled === false) {
    requestedWorkIds = []
  } else if (
    typeof input.defaultWorkPromptId === 'string'
    && workPrompts.some((prompt) => prompt.id === input.defaultWorkPromptId)
  ) {
    requestedWorkIds = [input.defaultWorkPromptId]
  } else {
    requestedWorkIds = [BUILTIN_WORK_PRODUCT_DELIVERY_ID]
  }

  const requestedIdSet = new Set(requestedWorkIds)
  const enabledWorkPromptIds = workPrompts
    .filter((prompt) => requestedIdSet.has(prompt.id))
    .map((prompt) => prompt.id)

  return {
    prompts,
    defaultPromptId,
    enabledWorkPromptIds,
    appendDateTimeAndUserName: input.appendDateTimeAndUserName ?? true,
  }
}

/** 读取配置文件 */
function readConfig(): SystemPromptConfig {
  const filePath = getSystemPromptsPath()

  if (!existsSync(filePath)) return getDefaultConfig()

  try {
    const raw = readFileSync(filePath, 'utf-8')
    return normalizeConfig(JSON.parse(raw) as LegacySystemPromptConfig)
  } catch (error) {
    console.error('[系统提示词] 读取配置失败:', error)
    return getDefaultConfig()
  }
}

/** 写入配置文件 */
function writeConfig(config: SystemPromptConfig): void {
  const filePath = getSystemPromptsPath()

  try {
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (error) {
    console.error('[系统提示词] 写入配置失败:', error)
    throw new Error('写入系统提示词配置失败')
  }
}

/** 获取完整系统提示词配置。 */
export function getSystemPromptConfig(): SystemPromptConfig {
  return readConfig()
}

/** 按列表顺序合并当前启用的 Work/Pi 附加提示词。 */
export function getEffectiveWorkSystemPrompt(): string | undefined {
  const config = readConfig()
  const enabledIdSet = new Set(config.enabledWorkPromptIds)
  const content = config.prompts
    .filter((prompt) => prompt.scope === 'work' && enabledIdSet.has(prompt.id))
    .map((prompt) => prompt.content.trim())
    .filter(Boolean)
    .join('\n\n')

  return content || undefined
}

/** 创建自定义提示词。新 Work 提示词保持停用，完成编辑后由用户明确启用。 */
export function createSystemPrompt(input: SystemPromptCreateInput): SystemPrompt {
  const config = readConfig()
  const now = Date.now()

  const prompt: SystemPrompt = {
    id: randomUUID(),
    name: input.name,
    content: input.content,
    scope: input.scope ?? 'chat',
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  }

  config.prompts.push(prompt)
  writeConfig(config)
  console.log(`[系统提示词] 已创建: ${prompt.name} (${prompt.id}, ${prompt.scope})`)
  return prompt
}

/** 更新自定义提示词；内置提示词保持只读。 */
export function updateSystemPrompt(id: string, input: SystemPromptUpdateInput): SystemPrompt {
  const config = readConfig()
  const index = config.prompts.findIndex((prompt) => prompt.id === id)

  if (index === -1) throw new Error(`提示词不存在: ${id}`)

  const prompt = config.prompts[index]!
  if (prompt.isBuiltin) throw new Error('内置提示词不可编辑')

  if (input.name !== undefined) prompt.name = input.name
  if (input.content !== undefined) prompt.content = input.content
  prompt.updatedAt = Date.now()

  writeConfig(config)
  console.log(`[系统提示词] 已更新: ${prompt.name} (${prompt.id})`)
  return prompt
}

/** 删除自定义提示词，并移除对应的 Work 启用状态。 */
export function deleteSystemPrompt(id: string): void {
  const config = readConfig()
  const prompt = config.prompts.find((candidate) => candidate.id === id)

  if (!prompt) throw new Error(`提示词不存在: ${id}`)
  if (prompt.isBuiltin) throw new Error('内置提示词不可删除')

  config.prompts = config.prompts.filter((candidate) => candidate.id !== id)
  config.enabledWorkPromptIds = config.enabledWorkPromptIds.filter((promptId) => promptId !== id)
  if (prompt.scope === 'chat' && config.defaultPromptId === id) {
    config.defaultPromptId = BUILTIN_DEFAULT_ID
  }

  writeConfig(config)
  console.log(`[系统提示词] 已删除: ${prompt.name} (${id})`)
}

/** 更新 Chat 的日期时间和用户名追加设置。 */
export function updateAppendSetting(enabled: boolean): void {
  const config = readConfig()
  config.appendDateTimeAndUserName = enabled
  writeConfig(config)
  console.log(`[系统提示词] Chat 附加信息设置已更新: ${enabled}`)
}

/** 启用或停用单条 Work/Pi 附加提示词。 */
export function updateWorkPromptActivation(id: string, enabled: boolean): void {
  const config = readConfig()
  const prompt = config.prompts.find((candidate) => candidate.id === id)

  if (!prompt) throw new Error(`提示词不存在: ${id}`)
  if (prompt.scope !== 'work') throw new Error(`提示词 ${id} 不属于 work 范围`)

  const enabledIdSet = new Set(config.enabledWorkPromptIds)
  if (enabled) enabledIdSet.add(id)
  else enabledIdSet.delete(id)
  config.enabledWorkPromptIds = config.prompts
    .filter((candidate) => candidate.scope === 'work' && enabledIdSet.has(candidate.id))
    .map((candidate) => candidate.id)

  writeConfig(config)
  console.log(`[系统提示词] Work 提示词状态已更新: ${id} (${enabled})`)
}

/** 设置 Chat 默认提示词。 */
export function setDefaultPrompt(id: string | null, scope: SystemPromptScope = 'chat'): void {
  if (scope !== 'chat') throw new Error('Work 提示词使用逐条启用，不设置默认项')

  const config = readConfig()
  const nextId = id ?? BUILTIN_DEFAULT_ID
  const prompt = config.prompts.find((candidate) => candidate.id === nextId)

  if (!prompt) throw new Error(`提示词不存在: ${nextId}`)
  if (prompt.scope !== 'chat') throw new Error(`提示词 ${nextId} 不属于 chat 范围`)

  config.defaultPromptId = nextId
  writeConfig(config)
  console.log(`[系统提示词] Chat 默认提示词已设置: ${nextId}`)
}
