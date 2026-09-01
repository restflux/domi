/**
 * useAgentSkillsData — Agent 技能视图的数据层
 *
 * 封装当前工作区 Skills / MCP 的加载与增删改逻辑（IPC 调用），
 * 供「Agent 技能」全屏视图复用。所有写操作后会 bump
 * workspaceCapabilitiesVersionAtom，通知侧边栏等订阅方刷新。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
  workspaceCapabilitiesVersionAtom,
} from '@/atoms/agent-atoms'
import { chatToolsAtom } from '@/atoms/chat-tool-atoms'
import { refreshChatToolsForLinkedBuiltinMcp } from '@/lib/linked-image-tool-ui-sync'
import type { BuiltinMcpServerSummary, GlobalAgentCapabilities, SkillMeta, SkillUsageStats, WorkspaceCapabilities, WorkspaceMcpConfig } from '@domi/shared'

export interface AgentSkillsData {
  /** 当前工作区（未选中时为 null） */
  workspaceSlug: string
  workspaceName: string
  hasWorkspace: boolean
  loading: boolean
  skills: SkillMeta[]
  defaultSkillSlugs: Set<string>
  skillsDir: string
  mcpConfig: WorkspaceMcpConfig
  capabilities: WorkspaceCapabilities | null
  globalCapabilities: GlobalAgentCapabilities | null
  /** 工作区级 Skill 使用统计（触发次数/最近触发） */
  skillUsage: SkillUsageStats[]
  builtinMcpServers: BuiltinMcpServerSummary[]
  updatingSkill: string | null
  toggleSkill: (slug: string, enabled: boolean) => Promise<void>
  deleteSkill: (slug: string, name: string) => Promise<boolean>
  updateSkill: (slug: string) => Promise<void>
  toggleMcp: (name: string, enabled: boolean) => Promise<void>
  toggleBuiltinMcp: (id: string, enabled: boolean) => Promise<void>
  setGlobalSkillsEnabled: (enabled: boolean) => Promise<void>
  setPiGlobalMcpEnabled: (enabled: boolean) => Promise<void>
  deleteMcp: (name: string) => Promise<void>
}

export function useAgentSkillsData(): AgentSkillsData {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const bumpCapabilitiesVersion = useSetAtom(workspaceCapabilitiesVersionAtom)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)
  const setChatTools = useSetAtom(chatToolsAtom)

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId)
  const workspaceSlug = currentWorkspace?.slug ?? ''

  const [loading, setLoading] = React.useState(true)
  const [skills, setSkills] = React.useState<SkillMeta[]>([])
  const [defaultSkillSlugs, setDefaultSkillSlugs] = React.useState<Set<string>>(new Set())
  const [skillsDir, setSkillsDir] = React.useState('')
  const [mcpConfig, setMcpConfig] = React.useState<WorkspaceMcpConfig>({ servers: {} })
  const [capabilities, setCapabilities] = React.useState<WorkspaceCapabilities | null>(null)
  const [globalCapabilities, setGlobalCapabilities] = React.useState<GlobalAgentCapabilities | null>(null)
  const [skillUsage, setSkillUsage] = React.useState<SkillUsageStats[]>([])
  const [builtinMcpServers, setBuiltinMcpServers] = React.useState<BuiltinMcpServerSummary[]>([])
  const [updatingSkill, setUpdatingSkill] = React.useState<string | null>(null)

  const loadData = React.useCallback(async () => {
    if (!workspaceSlug) {
      setSkills([])
      setMcpConfig({ servers: {} })
      setCapabilities(null)
      setGlobalCapabilities(null)
      setSkillUsage([])
      setBuiltinMcpServers([])
      setLoading(false)
      return
    }
    try {
      const [config, skillList, dir, defaultSlugs, capabilities, globalCapabilities, usage] = await Promise.all([
        window.electronAPI.getWorkspaceMcpConfig(workspaceSlug),
        window.electronAPI.getWorkspaceSkills(workspaceSlug),
        window.electronAPI.getWorkspaceSkillsDir(workspaceSlug),
        window.electronAPI.getDefaultSkillSlugs(),
        window.electronAPI.getWorkspaceCapabilities(workspaceSlug),
        window.electronAPI.getGlobalAgentCapabilities(),
        window.electronAPI.getWorkspaceSkillUsage(workspaceSlug),
      ])
      setMcpConfig(config)
      setSkills([
        ...skillList,
        ...capabilities.skills.filter((skill) => skill.origin),
      ])
      setSkillsDir(dir)
      setDefaultSkillSlugs(new Set(defaultSlugs))
      setCapabilities(capabilities)
      setGlobalCapabilities(globalCapabilities)
      setSkillUsage(usage)
      setBuiltinMcpServers(capabilities.builtinMcpServers)
    } catch (error) {
      console.error('[Agent 技能] 加载工作区配置失败:', error)
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  // workspaceSlug 或外部能力版本变化时重新拉取
  React.useEffect(() => {
    setLoading(true)
    void loadData()
  }, [loadData, capabilitiesVersion])

  const toggleSkill = React.useCallback(async (slug: string, enabled: boolean) => {
    try {
      await window.electronAPI.toggleWorkspaceSkill(workspaceSlug, slug, enabled)
      setSkills((prev) => prev.map((s) => (s.slug === slug ? { ...s, enabled } : s)))
      bumpCapabilitiesVersion((v) => v + 1)
    } catch (error) {
      console.error('[Agent 技能] 切换 Skill 状态失败:', error)
      toast.error('切换 Skill 状态失败')
    }
  }, [workspaceSlug, bumpCapabilitiesVersion])

  const deleteSkill = React.useCallback(async (slug: string, name: string): Promise<boolean> => {
    try {
      await window.electronAPI.deleteWorkspaceSkill(workspaceSlug, slug)
      setSkills((prev) => prev.filter((s) => s.slug !== slug))
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(`已删除 Skill：${name}`)
      return true
    } catch (error) {
      console.error('[Agent 技能] 删除 Skill 失败:', error)
      toast.error('删除 Skill 失败')
      return false
    }
  }, [workspaceSlug, bumpCapabilitiesVersion])

  const updateSkill = React.useCallback(async (slug: string) => {
    if (!workspaceSlug || updatingSkill) return
    setUpdatingSkill(slug)
    try {
      const updated = await window.electronAPI.updateSkillFromSource(workspaceSlug, slug)
      setSkills((prev) => prev.map((s) => (s.slug === slug ? updated : s)))
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(`已同步更新 Skill：${updated.name}`)
    } catch (error) {
      console.error('[Agent 技能] 更新 Skill 失败:', error)
      const message = error instanceof Error ? error.message : '未知错误'
      toast.error('更新 Skill 失败', { description: message })
    } finally {
      setUpdatingSkill(null)
    }
  }, [workspaceSlug, updatingSkill, bumpCapabilitiesVersion])

  const toggleMcp = React.useCallback(async (name: string, enabled: boolean) => {
    try {
      const entry = mcpConfig.servers[name]
      if (!entry) return
      const newConfig: WorkspaceMcpConfig = {
        servers: { ...mcpConfig.servers, [name]: { ...entry, enabled } },
      }
      await window.electronAPI.saveWorkspaceMcpConfig(workspaceSlug, newConfig)
      setMcpConfig(newConfig)
      bumpCapabilitiesVersion((v) => v + 1)
    } catch (error) {
      console.error('[Agent 技能] 切换 MCP 服务器状态失败:', error)
      toast.error('切换 MCP 状态失败')
    }
  }, [workspaceSlug, mcpConfig, bumpCapabilitiesVersion])

  const toggleBuiltinMcp = React.useCallback(async (id: string, enabled: boolean) => {
    try {
      const capabilities = await window.electronAPI.setBuiltinMcpEnabled(workspaceSlug, id, enabled)
      setCapabilities(capabilities)
      setBuiltinMcpServers(capabilities.builtinMcpServers)
      try {
        await refreshChatToolsForLinkedBuiltinMcp({
          toolId: id,
          loadChatTools: window.electronAPI.getChatTools,
          setChatTools,
        })
      } catch (error) {
        // 后端开关已写入成功；工具列表刷新失败不应把本次切换误报为失败。
        console.error('[Agent 技能] 刷新生图工具状态失败:', error)
      }
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(enabled ? '已启用内置 MCP' : '已关闭内置 MCP')
    } catch (error) {
      console.error('[Agent 技能] 切换内置 MCP 状态失败:', error)
      toast.error('切换内置 MCP 状态失败')
    }
  }, [workspaceSlug, setChatTools, bumpCapabilitiesVersion])

  const setGlobalSkillsEnabled = React.useCallback(async (enabled: boolean) => {
    try {
      const updated = await window.electronAPI.setGlobalSkillsEnabled(enabled)
      setGlobalCapabilities(updated)
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(enabled ? '已启用外部全局 Skills' : '已关闭外部全局 Skills')
    } catch (error) {
      console.error('[Agent 技能] 切换外部全局 Skills 失败:', error)
      toast.error('切换外部全局 Skills 失败')
    }
  }, [bumpCapabilitiesVersion])

  const setPiGlobalMcpEnabled = React.useCallback(async (enabled: boolean) => {
    try {
      const updated = await window.electronAPI.setPiGlobalMcpEnabled(enabled)
      setGlobalCapabilities(updated)
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(enabled ? '已启用 Pi 全局 MCP' : '已关闭 Pi 全局 MCP')
    } catch (error) {
      console.error('[Agent 技能] 切换 Pi 全局 MCP 失败:', error)
      toast.error('切换 Pi 全局 MCP 失败')
    }
  }, [bumpCapabilitiesVersion])

  const deleteMcp = React.useCallback(async (name: string) => {
    const entry = mcpConfig.servers[name]
    if (entry?.isBuiltin) return
    try {
      const newServers = { ...mcpConfig.servers }
      delete newServers[name]
      const newConfig: WorkspaceMcpConfig = { servers: newServers }
      await window.electronAPI.saveWorkspaceMcpConfig(workspaceSlug, newConfig)
      setMcpConfig(newConfig)
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(`已删除 MCP 服务器：${name}`)
    } catch (error) {
      console.error('[Agent 技能] 删除 MCP 服务器失败:', error)
      toast.error('删除 MCP 服务器失败')
    }
  }, [workspaceSlug, mcpConfig, bumpCapabilitiesVersion])

  return {
    workspaceSlug,
    workspaceName: currentWorkspace?.name ?? '',
    hasWorkspace: !!currentWorkspace,
    loading,
    skills,
    defaultSkillSlugs,
    skillsDir,
    mcpConfig,
    capabilities,
    globalCapabilities,
    skillUsage,
    builtinMcpServers,
    updatingSkill,
    toggleSkill,
    deleteSkill,
    updateSkill,
    toggleMcp,
    toggleBuiltinMcp,
    setGlobalSkillsEnabled,
    setPiGlobalMcpEnabled,
    deleteMcp,
  }
}
