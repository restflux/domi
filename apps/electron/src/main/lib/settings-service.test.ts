import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSettingsService } from './settings-service-core.ts'

const root = mkdtempSync(join(tmpdir(), 'domi-settings-service-'))
const settingsPath = join(root, 'settings.json')
let atomicWrite: (path: string, data: object) => void = () => undefined
const { getSettings, updateSettings } = createSettingsService({
  getSettingsPath: () => settingsPath,
  writeJsonFileAtomic: (path, data) => atomicWrite(path, data),
})

beforeEach(() => {
  atomicWrite = () => undefined
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Settings Pi-only 字段迁移', () => {
  test('Given 旧字段写回失败 When 读取设置 Then 保留已解析的用户配置而非回退默认值', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'dark',
      onboardingCompleted: true,
      agentChannelId: 'channel-a',
      agentRuntime: 'pi',
      agentChannelIds: ['channel-a'],
    }), 'utf-8')
    atomicWrite = () => { throw new Error('disk locked') }

    const settings = getSettings()

    expect(settings.themeMode).toBe('dark')
    expect(settings.onboardingCompleted).toBe(true)
    expect(settings.agentChannelId).toBe('channel-a')
    expect(settings).not.toHaveProperty('agentRuntime')
    expect(settings).not.toHaveProperty('agentChannelIds')
  })

  test('Given 旧设置没有 ContextCompactor flag When 读取 Then 默认保持关闭并拒绝未知模式', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark' }), 'utf-8')
    atomicWrite = () => undefined

    expect(getSettings().agentContextCompactorMode).toBe('off')

    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark', agentContextCompactorMode: 'unsafe' }), 'utf-8')
    expect(getSettings().agentContextCompactorMode).toBe('off')
  })

  test('Given 设置 UI 切换 ContextCompactor When 更新 Then enhance/off 通过统一设置服务持久化', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark', agentContextCompactorMode: 'off' }), 'utf-8')
    atomicWrite = (path, data) => writeFileSync(path, JSON.stringify(data), 'utf-8')

    expect(updateSettings({ agentContextCompactorMode: 'enhance' }).agentContextCompactorMode).toBe('enhance')
    expect(getSettings().agentContextCompactorMode).toBe('enhance')
    expect(updateSettings({ agentContextCompactorMode: 'off' }).agentContextCompactorMode).toBe('off')
    expect(getSettings().agentContextCompactorMode).toBe('off')
  })

  test('Given 旧设置只记录当前项目 When 首次读取 Then 固化为独立的机器人默认项目', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'dark',
      agentWorkspaceId: 'workspace-before-upgrade',
    }), 'utf-8')
    atomicWrite = (path, data) => writeFileSync(path, JSON.stringify(data), 'utf-8')

    const migrated = getSettings()
    updateSettings({ agentWorkspaceId: 'recent-session-workspace' })

    expect(migrated.agentRemoteDefaultWorkspaceId).toBe('workspace-before-upgrade')
    expect(getSettings().agentWorkspaceId).toBe('recent-session-workspace')
    expect(getSettings().agentRemoteDefaultWorkspaceId).toBe('workspace-before-upgrade')
  })

  test('Given 已保存机器人默认项目 When 桌面端切换最近会话 Then 默认项目不被覆盖', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'dark',
      agentWorkspaceId: 'desktop-current-workspace',
      agentRemoteDefaultWorkspaceId: 'remote-default-workspace',
    }), 'utf-8')
    atomicWrite = (path, data) => writeFileSync(path, JSON.stringify(data), 'utf-8')

    updateSettings({ agentWorkspaceId: 'recent-session-workspace' })

    const settings = getSettings()
    expect(settings.agentWorkspaceId).toBe('recent-session-workspace')
    expect(settings.agentRemoteDefaultWorkspaceId).toBe('remote-default-workspace')
  })

  test('Given 旧设置没有 Vision Relay When 读取 Then 默认保持关闭', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark' }), 'utf-8')
    atomicWrite = () => undefined

    expect(getSettings().visionRelay).toEqual({ enabled: false, qualityPreset: 'balanced' })
  })

  test('Given 旧 Vision Relay 缺少授权版本 When 读取 Then 保留路由但安全关闭', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'dark',
      visionRelay: { enabled: true, channelId: 'vision-channel', modelId: 'vision-model' },
    }), 'utf-8')
    atomicWrite = () => undefined

    expect(getSettings().visionRelay).toEqual({
      enabled: false,
      channelId: 'vision-channel',
      modelId: 'vision-model',
      qualityPreset: 'balanced',
    })

    writeFileSync(settingsPath, JSON.stringify({
      visionRelay: {
        enabled: false,
        qualityPreset: 'provider-specific-raw-value',
      },
    }), 'utf-8')
    expect(getSettings().visionRelay).toEqual({ enabled: false, qualityPreset: 'balanced' })
  })

  test('Given Vision Relay is enabled or route changes When updating Then main process rotates authorization version', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark', visionRelay: { enabled: false } }), 'utf-8')
    atomicWrite = (path, data) => writeFileSync(path, JSON.stringify(data), 'utf-8')

    const enabled = updateSettings({ visionRelay: { enabled: true, channelId: 'channel-a', modelId: 'vision-a', qualityPreset: 'balanced' } })
    expect(enabled.visionRelay?.enabled).toBe(true)
    expect(enabled.visionRelay?.qualityPreset).toBe('balanced')
    expect(enabled.visionRelay?.authorizationVersion).toBeTruthy()

    const qualityChanged = updateSettings({ visionRelay: { enabled: true, channelId: 'channel-a', modelId: 'vision-a', qualityPreset: 'accurate' } })
    expect(qualityChanged.visionRelay?.qualityPreset).toBe('accurate')
    expect(qualityChanged.visionRelay?.authorizationVersion).toBe(enabled.visionRelay?.authorizationVersion)

    const unchanged = updateSettings({ visionRelay: { enabled: true, channelId: 'channel-a', modelId: 'vision-a', qualityPreset: 'accurate' } })
    expect(unchanged.visionRelay?.authorizationVersion).toBe(enabled.visionRelay?.authorizationVersion)

    const switched = updateSettings({ visionRelay: { enabled: true, channelId: 'channel-b', modelId: 'vision-b', qualityPreset: 'accurate' } })
    expect(switched.visionRelay?.authorizationVersion).not.toBe(enabled.visionRelay?.authorizationVersion)
  })

  test('Given Vision Relay is disabled then enabled When updating Then previous session consent is invalidated', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark', visionRelay: { enabled: false } }), 'utf-8')
    atomicWrite = (path, data) => writeFileSync(path, JSON.stringify(data), 'utf-8')
    const first = updateSettings({ visionRelay: { enabled: true, channelId: 'channel-a', modelId: 'vision-a', qualityPreset: 'balanced' } })
    updateSettings({ visionRelay: { enabled: false, channelId: 'channel-a', modelId: 'vision-a', qualityPreset: 'balanced' } })
    const second = updateSettings({ visionRelay: { enabled: true, channelId: 'channel-a', modelId: 'vision-a', qualityPreset: 'balanced' } })

    expect(second.visionRelay?.authorizationVersion).not.toBe(first.visionRelay?.authorizationVersion)
  })

  test('Given 旧设置缺少 Work Activity 通知细分项 When 读取 Then 两项默认开启', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark', notificationsEnabled: true }), 'utf-8')
    atomicWrite = () => undefined

    const settings = getSettings()

    expect(settings.workActivityAttentionNotificationsEnabled).toBe(true)
    expect(settings.workActivityCompletionNotificationsEnabled).toBe(true)
  })

  test('Given 用户关闭 Work Activity 通知细分项 When 更新 Then 独立持久化且不改总开关', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark', notificationsEnabled: true }), 'utf-8')
    atomicWrite = (path, data) => writeFileSync(path, JSON.stringify(data), 'utf-8')

    const updated = updateSettings({
      workActivityAttentionNotificationsEnabled: false,
      workActivityCompletionNotificationsEnabled: false,
    })

    expect(updated.notificationsEnabled).toBe(true)
    expect(updated.workActivityAttentionNotificationsEnabled).toBe(false)
    expect(updated.workActivityCompletionNotificationsEnabled).toBe(false)
  })

  test('Given 旧设置缺少 Work 侧边栏偏好 When 读取 Then 补齐默认视图、排序与空分组', () => {
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark' }), 'utf-8')

    expect(getSettings().workSidebarPreferences).toEqual({
      sectionMode: 'projects',
      groupMode: 'project',
      sortMode: 'updated',
      customGroups: [],
    })
  })

  test('Given 旧 Work 偏好只保存 groupMode When 读取 Then 保留项目布局并补齐新的分组字段', () => {
    writeFileSync(settingsPath, JSON.stringify({
      workSidebarPreferences: { groupMode: 'timeline' },
    }), 'utf-8')

    expect(getSettings().workSidebarPreferences).toEqual({
      sectionMode: 'projects',
      groupMode: 'timeline',
      sortMode: 'updated',
      customGroups: [],
    })
  })

  test('Given Work 自定义分组包含重复归属与非法数据 When 读取 Then 保留首个有效归属并安全规范化', () => {
    writeFileSync(settingsPath, JSON.stringify({
      workSidebarPreferences: {
        sectionMode: 'groups',
        groupMode: 'unknown',
        sortMode: 'created',
        customGroups: [
          { id: 'group-a', name: '  设计  ', color: 'orange', collapsed: true, sessionIds: ['s1', 's1', 's2', 3] },
          { id: 'group-b', name: '实现', color: 'unknown', collapsed: 'yes', sessionIds: ['s2', 's3'] },
          { id: 'group-a', name: '重复 ID', color: 'red', collapsed: false, sessionIds: ['s4'] },
          { id: '', name: '无效', color: 'gray', collapsed: false, sessionIds: [] },
        ],
      },
    }), 'utf-8')

    expect(getSettings().workSidebarPreferences).toEqual({
      sectionMode: 'groups',
      groupMode: 'project',
      sortMode: 'created',
      customGroups: [
        { id: 'group-a', name: '设计', color: 'orange', collapsed: true, sessionIds: ['s1', 's2'] },
        { id: 'group-b', name: '实现', color: 'gray', collapsed: false, sessionIds: ['s3'] },
      ],
    })
  })

  test('Given Work 侧边栏偏好包含未知值 When 读取 Then 回退安全默认值', () => {
    writeFileSync(settingsPath, JSON.stringify({
      workSidebarPreferences: { sectionMode: 'unknown', groupMode: 'unknown', sortMode: 'unknown', customGroups: 'invalid' },
    }), 'utf-8')

    expect(getSettings().workSidebarPreferences).toEqual({
      sectionMode: 'projects',
      groupMode: 'project',
      sortMode: 'updated',
      customGroups: [],
    })
  })

  test('Given 正常设置更新 When 写盘 Then 使用原子 JSON writer', () => {
    let captured: { path: string; data: object } | undefined
    atomicWrite = (path, data) => { captured = { path, data } }

    const updated = updateSettings({ notificationsEnabled: false })

    expect(captured?.path).toBe(settingsPath)
    expect(captured?.data).toEqual(updated)
    expect(updated.notificationsEnabled).toBe(false)
  })
})
