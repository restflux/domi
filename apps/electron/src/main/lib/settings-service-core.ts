/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 通过依赖注入读写设置文件，生产路径由 settings-service.ts 绑定。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import {
  DEFAULT_INTERFACE_VARIANT,
  DEFAULT_THEME_MODE,
  DEFAULT_WORK_SIDEBAR_PREFERENCES,
} from '../../types'
import type {
  AppSettings,
  VisionRelayQualityPreset,
  WorkSidebarCustomGroup,
  WorkSidebarCustomGroupColor,
  WorkSidebarPreferences,
  VisionRelaySettings,
} from '../../types'

type PersistedSettings = Partial<AppSettings> & {
  experimentalAgentRuntimeSwitchEnabled?: boolean
  agentRuntime?: unknown
  agentChannelIds?: unknown
}

export interface SettingsServiceDependencies {
  getSettingsPath(): string
  writeJsonFileAtomic(path: string, data: object): void
}

export interface SettingsService {
  getSettings(): AppSettings
  updateSettings(updates: Partial<AppSettings>): AppSettings
}

/**
 * 解析机器人平台的新会话默认项目。
 *
 * agentWorkspaceId 只作为旧版本兼容回退；一旦迁移/保存出独立字段，桌面端打开
 * 最近会话就不会再改变机器人默认项目。
 */
export function resolveAgentRemoteDefaultWorkspaceId(
  settings: Pick<AppSettings, 'agentRemoteDefaultWorkspaceId' | 'agentWorkspaceId'>,
): string | undefined {
  return settings.agentRemoteDefaultWorkspaceId ?? settings.agentWorkspaceId
}

function normalizeVisionRelayQualityPreset(value: unknown): VisionRelayQualityPreset {
  return value === 'fast' || value === 'balanced' || value === 'accurate' ? value : 'balanced'
}

function normalizeVisionRelaySettings(value: VisionRelaySettings | undefined): VisionRelaySettings {
  const channelId = value?.channelId?.trim() || undefined
  const modelId = value?.modelId?.trim() || undefined
  const authorizationVersion = value?.authorizationVersion?.trim() || undefined
  const enabled = value?.enabled === true && !!channelId && !!modelId && !!authorizationVersion
  return {
    enabled,
    ...(channelId ? { channelId } : {}),
    ...(modelId ? { modelId } : {}),
    qualityPreset: normalizeVisionRelayQualityPreset(value?.qualityPreset),
    ...(authorizationVersion ? { authorizationVersion } : {}),
  }
}

function resolveVisionRelayUpdate(
  current: VisionRelaySettings | undefined,
  requested: VisionRelaySettings,
): VisionRelaySettings {
  const previous = normalizeVisionRelaySettings(current)
  const channelId = requested.channelId?.trim() || undefined
  const modelId = requested.modelId?.trim() || undefined
  const enabled = requested.enabled === true && !!channelId && !!modelId
  const qualityPreset = normalizeVisionRelayQualityPreset(requested.qualityPreset)
  const routeChanged = channelId !== previous.channelId || modelId !== previous.modelId
  const newlyEnabled = enabled && !previous.enabled
  const authorizationVersion = enabled
    ? (routeChanged || newlyEnabled || !previous.authorizationVersion ? randomUUID() : previous.authorizationVersion)
    : previous.authorizationVersion
  return {
    enabled,
    ...(channelId ? { channelId } : {}),
    ...(modelId ? { modelId } : {}),
    qualityPreset,
    ...(authorizationVersion ? { authorizationVersion } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeWorkSidebarGroupColor(value: unknown): WorkSidebarCustomGroupColor {
  return value === 'red'
    || value === 'orange'
    || value === 'yellow'
    || value === 'green'
    || value === 'blue'
    || value === 'purple'
    ? value
    : 'gray'
}

function normalizeWorkSidebarCustomGroups(value: unknown): WorkSidebarCustomGroup[] {
  if (!Array.isArray(value)) return []

  const usedGroupIds = new Set<string>()
  const assignedSessionIds = new Set<string>()
  const groups: WorkSidebarCustomGroup[] = []

  for (const candidate of value.slice(0, 100)) {
    if (!isRecord(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 80) : ''
    if (!id || !name || usedGroupIds.has(id)) continue

    const sessionIds: string[] = []
    if (Array.isArray(candidate.sessionIds)) {
      for (const sessionIdValue of candidate.sessionIds) {
        const sessionId = typeof sessionIdValue === 'string' ? sessionIdValue.trim() : ''
        if (!sessionId || assignedSessionIds.has(sessionId)) continue
        assignedSessionIds.add(sessionId)
        sessionIds.push(sessionId)
      }
    }

    usedGroupIds.add(id)
    groups.push({
      id,
      name,
      color: normalizeWorkSidebarGroupColor(candidate.color),
      collapsed: candidate.collapsed === true,
      sessionIds,
    })
  }

  return groups
}

function normalizeWorkSidebarPreferences(
  preferences: AppSettings['workSidebarPreferences'],
): WorkSidebarPreferences {
  const raw: Record<string, unknown> = isRecord(preferences) ? preferences : {}
  return {
    sectionMode: raw.sectionMode === 'groups' ? 'groups' : 'projects',
    groupMode: raw.groupMode === 'timeline' ? 'timeline' : 'project',
    sortMode: raw.sortMode === 'created' ? 'created' : 'updated',
    customGroups: normalizeWorkSidebarCustomGroups(raw.customGroups),
  }
}

function defaultSettings(): AppSettings {
  return {
    themeMode: DEFAULT_THEME_MODE,
    interfaceVariant: DEFAULT_INTERFACE_VARIANT,
    workSidebarPreferences: DEFAULT_WORK_SIDEBAR_PREFERENCES,
    onboardingCompleted: false,
    environmentCheckSkipped: false,
    notificationsEnabled: true,
    workActivityAttentionNotificationsEnabled: true,
    workActivityCompletionNotificationsEnabled: true,
    visionRelay: { enabled: false, qualityPreset: 'balanced' },
    longTextPasteAsAttachmentEnabled: false,
    richTextRenderingEnabled: false,
    feishuSessionMirror: { mode: 'off' },
    builtinMcpDisabledIds: [],
    externalGlobalSkillsEnabled: false,
    piGlobalMcpEnabled: false,
    windowsShellPreference: 'auto',
    agentThinking: { type: 'adaptive' },
    agentContextCompactorMode: 'off',
    gitAttributionEnabled: false,
  }
}

function normalizeSettings(data: PersistedSettings): {
  settings: AppSettings
  needsMigrationWriteback: boolean
} {
  const {
    experimentalAgentRuntimeSwitchEnabled: legacyRuntimeSwitch,
    agentRuntime: legacyAgentRuntime,
    agentChannelIds: legacyAgentChannelIds,
    ...settings
  } = data

  return {
    settings: {
      ...settings,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      interfaceVariant: data.interfaceVariant || DEFAULT_INTERFACE_VARIANT,
      workSidebarPreferences: normalizeWorkSidebarPreferences(data.workSidebarPreferences),
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      workActivityAttentionNotificationsEnabled: data.workActivityAttentionNotificationsEnabled ?? true,
      workActivityCompletionNotificationsEnabled: data.workActivityCompletionNotificationsEnabled ?? true,
      visionRelay: normalizeVisionRelaySettings(data.visionRelay),
      longTextPasteAsAttachmentEnabled: data.longTextPasteAsAttachmentEnabled ?? false,
      richTextRenderingEnabled: data.richTextRenderingEnabled ?? false,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      builtinMcpDisabledIds: settings.builtinMcpDisabledIds ?? [],
      externalGlobalSkillsEnabled: settings.externalGlobalSkillsEnabled ?? false,
      piGlobalMcpEnabled: settings.piGlobalMcpEnabled ?? false,
      windowsShellPreference: settings.windowsShellPreference ?? 'auto',
      agentThinking: settings.agentThinking ?? { type: 'adaptive' },
      // 旧版把“桌面端当前项目”和“机器人默认项目”共用 agentWorkspaceId。
      // 首次读取时复制为独立字段；后续桌面会话切换只更新 agentWorkspaceId。
      agentRemoteDefaultWorkspaceId: settings.agentRemoteDefaultWorkspaceId ?? settings.agentWorkspaceId,
      agentContextCompactorMode: settings.agentContextCompactorMode === 'observe' || settings.agentContextCompactorMode === 'enhance'
        ? settings.agentContextCompactorMode
        : 'off',
      // Domi 不注入上游产品推广标识；保留字段仅用于兼容旧配置结构。
      gitAttributionEnabled: false,
    },
    needsMigrationWriteback: legacyRuntimeSwitch !== undefined ||
      legacyAgentRuntime !== undefined ||
      legacyAgentChannelIds !== undefined ||
      (settings.agentRemoteDefaultWorkspaceId === undefined && settings.agentWorkspaceId !== undefined),
  }
}

/**
 * 获取应用设置。
 *
 * Pi 是唯一 Agent runtime；读取时幂等清理旧版 runtime 开关和 Claude Agent
 * 渠道白名单，避免废弃字段继续随更新写回。
 */
export function createSettingsService(dependencies: SettingsServiceDependencies): SettingsService {
  function getSettings(): AppSettings {
    const filePath = dependencies.getSettingsPath()
    if (!existsSync(filePath)) return defaultSettings()

    let data: PersistedSettings
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedSettings
    } catch (error) {
      console.error('[设置] 读取失败:', error)
      return defaultSettings()
    }

    const { settings, needsMigrationWriteback } = normalizeSettings(data)
    if (needsMigrationWriteback) {
      try {
        dependencies.writeJsonFileAtomic(filePath, settings)
        console.log('[设置] 已迁移旧版设置字段')
      } catch (error) {
        // 迁移写回失败不能抹掉已经成功解析的用户设置；下次读取会再次尝试清理。
        console.error('[设置] 迁移旧版设置失败，将保留已读取设置:', error)
      }
    }
    return settings
  }

  function updateSettings(updates: Partial<AppSettings>): AppSettings {
    const current = getSettings()
    const updated: AppSettings = {
      ...current,
      ...updates,
      ...(updates.visionRelay ? { visionRelay: resolveVisionRelayUpdate(current.visionRelay, updates.visionRelay) } : {}),
      ...(updates.workSidebarPreferences
        ? { workSidebarPreferences: normalizeWorkSidebarPreferences(updates.workSidebarPreferences) }
        : {}),
      gitAttributionEnabled: false,
    }

    try {
      dependencies.writeJsonFileAtomic(dependencies.getSettingsPath(), updated)
      console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
    } catch (error) {
      console.error('[设置] 写入失败:', error)
      throw new Error('写入应用设置失败')
    }

    return updated
  }

  return { getSettings, updateSettings }
}
