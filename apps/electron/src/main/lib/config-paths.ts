/**
 * 配置路径工具
 *
 * 管理 Domi 应用的本地配置文件路径。
 * 所有用户配置存储在 ~/.domi/ 目录下。
 */

import { join } from 'node:path'
import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { CLI_EXECUTABLE_BASENAME } from '@domi/shared'
import { rmSyncWithRetry } from './fs-retry'
import { resolveDomiProductIdentity } from './product-identity.ts'
import {
  computeSkillDirectoryHash,
  copyManagedSkillDirectory,
  isUnmodifiedDefaultSkill,
  readDefaultSkillsManifest,
  recordDefaultSkillBaseline,
  replaceManagedSkillDirectory,
  writeDefaultSkillsManifest,
  type DefaultSkillsManifest,
} from './default-skill-lifecycle.ts'

/**
 * 获取配置目录名称
 *
 * 开发模式下返回 '.domi-dev'，正式版本返回 '.domi'。
 *
 * 检测优先级：
 * 1. DOMI_DEV=1 环境变量（显式覆盖）
 * 2. Electron app.isPackaged（未打包 = 开发模式）
 * 3. 兜底 '.domi'
 */
let _configDirName: string | undefined

export function getConfigDirName(): string {
  if (_configDirName === undefined) {
    let isPackaged = true
    try {
      const { app } = require('electron')
      isPackaged = app.isPackaged
    } catch {
      // 非 Electron 环境按正式版解析，仍保留 DOMI_DEV=1 兼容开关。
    }

    _configDirName = resolveDomiProductIdentity({
      isPackaged,
      appDataPath: '',
      environment: process.env,
    }).configDirName
    const mode = _configDirName === '.domi-dev' ? '开发模式' : '正式版本'
    console.log(`[配置] 配置目录: ~/${_configDirName}/（${mode}）`)
  }
  return _configDirName
}

/**
 * 获取配置目录路径
 *
 * 开发模式返回 ~/.domi-dev/，正式版本返回 ~/.domi/。
 * 如果目录不存在则自动创建。
 */
export function getConfigDir(): string {
  const configDir = join(homedir(), getConfigDirName())

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
    console.log(`[配置] 已创建配置目录: ${configDir}`)
  }

  return configDir
}


/**
 * 获取渠道配置文件路径
 *
 * @returns ~/.domi/channels.json
 */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/**
 * 获取对话索引文件路径
 *
 * @returns ~/.domi/conversations.json
 */
export function getConversationsIndexPath(): string {
  return join(getConfigDir(), 'conversations.json')
}

/**
 * 获取对话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.domi/conversations/
 */
export function getConversationsDir(): string {
  const dir = join(getConfigDir(), 'conversations')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建对话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的消息文件路径
 *
 * @param id 对话 ID
 * @returns ~/.domi/conversations/{id}.jsonl
 */
export function getConversationMessagesPath(id: string): string {
  return join(getConversationsDir(), `${id}.jsonl`)
}

/**
 * 获取附件存储根目录
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.domi/attachments/
 */
export function getAttachmentsDir(): string {
  const dir = join(getConfigDir(), 'attachments')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建附件目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的附件目录
 *
 * 如果目录不存在则自动创建。
 *
 * @param conversationId 对话 ID
 * @returns ~/.domi/attachments/{conversationId}/
 */
export function getConversationAttachmentsDir(conversationId: string): string {
  const dir = join(getAttachmentsDir(), conversationId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析附件相对路径为完整路径
 *
 * @param localPath 相对路径 {conversationId}/{uuid}.ext
 * @returns 完整路径 ~/.domi/attachments/{conversationId}/{uuid}.ext
 */
export function resolveAttachmentPath(localPath: string): string {
  return join(getAttachmentsDir(), localPath)
}

/**
 * 获取应用设置文件路径
 *
 * @returns ~/.domi/settings.json
 */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json')
}

/** Pi Extension 精确授权存储；始终复用 Domi 正式/开发 profile 路径。 */
export function getExtensionTrustPath(): string {
  return join(getConfigDir(), 'extension-trust.json')
}

/** Main-owned Pi run timing audit 文件；renderer 不得覆盖此路径。 */
export function getPiRunTimingAuditPath(): string {
  return join(getConfigDir(), 'audit', 'events.jsonl')
}

/** Snapshot-bound、可跨重启恢复的 Worktree/Local 维修待确认动作。 */
export function getPendingWorktreeApprovalsPath(): string {
  return join(getConfigDir(), 'pending-worktree-approvals.json')
}

/** Work Activity 通知转换去重与待合并完成事件。 */
export function getWorkActivityNotificationStatePath(): string {
  return join(getConfigDir(), 'work-activity-notifications.json')
}

/** Local 维修事务 registry。 */
export function getLocalMaintenanceTransactionsPath(): string {
  return join(getConfigDir(), 'local-maintenance-transactions.json')
}

/** Local 维修事务开始前的可恢复 snapshot artifacts。 */
export function getLocalMaintenanceDir(): string {
  const dir = join(getConfigDir(), 'local-maintenance')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 获取系统默认 App 探测缓存路径
 *
 * @returns ~/.domi/default-apps.json
 */
export function getDefaultAppsCachePath(): string {
  return join(getConfigDir(), 'default-apps.json')
}

/**
 * 获取用户档案文件路径
 *
 * @returns ~/.domi/user-profile.json
 */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/**
 * 获取代理配置文件路径
 *
 * @returns ~/.domi/proxy-settings.json
 */
export function getProxySettingsPath(): string {
  return join(getConfigDir(), 'proxy-settings.json')
}

/**
 * 获取系统提示词配置文件路径
 *
 * @returns ~/.domi/system-prompts.json
 */
export function getSystemPromptsPath(): string {
  return join(getConfigDir(), 'system-prompts.json')
}

/**
 * 获取 Chat 工具配置文件路径
 *
 * @returns ~/.domi/chat-tools.json
 */
export function getChatToolsConfigPath(): string {
  return join(getConfigDir(), 'chat-tools.json')
}

/**
 * 获取 Agent 会话索引文件路径
 *
 * @returns ~/.domi/agent-sessions.json
 */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/**
 * 获取 token 使用记录文件路径
 *
 * 追加式 JSONL（每行一条 UsageEntry），供统计面板聚合。
 *
 * @returns ~/.domi/usage-entries.jsonl
 */
export function getUsageEntriesPath(): string {
  return join(getConfigDir(), 'usage-entries.jsonl')
}

/**
 * 获取 Agent 会话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.domi/agent-sessions/
 */
export function getAgentSessionsDir(): string {
  const dir = join(getConfigDir(), 'agent-sessions')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 会话的消息文件路径
 *
 * @param id 会话 ID
 * @returns ~/.domi/agent-sessions/{id}.jsonl
 */
export function getAgentSessionMessagesPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.jsonl`)
}

/** Domi 宿主自有的逐轮文件检查点根目录；不复用 Pi session artifact。 */
export function getAgentFileCheckpointsDir(): string {
  return join(getAgentSessionsDir(), 'file-checkpoints')
}

/**
 * 获取指定 Agent 会话的 Skill 触发明细文件路径
 *
 * @param id 会话 ID
 * @returns ~/.domi/agent-sessions/{id}.skill-triggers.jsonl
 */
export function getAgentSessionSkillTriggersPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.skill-triggers.jsonl`)
}

/** 当前会话 Plan First 唯一可写的 sidecar 目录。 */
export function getAgentPlanSidecarDir(sessionId: string, workspaceSlug?: string): string {
  return workspaceSlug
    ? join(getAgentSessionWorkspacePath(workspaceSlug, sessionId), '.context', 'plan')
    : join(getAgentSessionsDir(), 'sidecars', sessionId, 'plan')
}

/**
 * 获取 Agent 工作区索引文件路径
 *
 * @returns ~/.domi/agent-workspaces.json
 */
export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), 'agent-workspaces.json')
}

/**
 * 获取 Agent 工作区根目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.domi/agent-workspaces/
 */
export function getAgentWorkspacesDir(): string {
  const dir = join(getConfigDir(), 'agent-workspaces')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 工作区的目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.domi/agent-workspaces/{slug}/
 */
export function getAgentWorkspacePath(slug: string): string {
  const dir = join(getAgentWorkspacesDir(), slug)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区: ${dir}`)
  }

  return dir
}

/**
 * 获取指定工作区的 MCP 配置文件路径
 *
 * @param slug 工作区 slug
 * @returns ~/.domi/agent-workspaces/{slug}/mcp.json
 */
export function getWorkspaceMcpPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'mcp.json')
}

/**
 * 获取指定工作区的 Skills 目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.domi/agent-workspaces/{slug}/skills/
 */
export function getWorkspaceSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取指定工作区的 Skill 使用统计聚合文件路径
 *
 * @param slug 工作区 slug
 * @returns ~/.domi/agent-workspaces/{slug}/skill-usage.json
 */
export function getWorkspaceSkillUsagePath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'skill-usage.json')
}

/**
 * 获取工作区文件目录路径
 *
 * 工作区内所有会话可访问的文件存放于此。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.domi/agent-workspaces/{slug}/workspace-files/
 */
export function getWorkspaceFilesDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'workspace-files')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析工作区文件目录路径（只读，不创建目录）
 *
 * 与 getWorkspaceFilesDir 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @returns ~/.domi/agent-workspaces/{slug}/workspace-files/
 */
export function resolveWorkspaceFilesDir(slug: string): string {
  return join(getConfigDir(), 'agent-workspaces', slug, 'workspace-files')
}

/**
 * 解析 Agent 会话工作目录路径（只读，不创建目录）
 *
 * 与 getAgentSessionWorkspacePath 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @param sessionId 会话 ID
 * @returns ~/.domi/agent-workspaces/{slug}/{sessionId}/
 */
export function resolveAgentSessionWorkspacePath(slug: string, sessionId: string): string {
  return join(getConfigDir(), 'agent-workspaces', slug, sessionId)
}

/**
 * 获取工作区不活跃 Skills 目录路径
 *
 * 禁用的 Skill 会被移动到此目录，Agent SDK 不会扫描该目录。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.domi/agent-workspaces/{slug}/skills-inactive/
 */
export function getInactiveSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills-inactive')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取默认 Skills 模板目录路径
 *
 * 新建工作区时自动复制此目录的内容到工作区 skills/ 下。
 *
 * @returns ~/.domi/default-skills/
 */
export function getDefaultSkillsDir(): string {
  const dir = join(getConfigDir(), 'default-skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/** Domi-owned pristine baselines；工作区分发永远从这里读取，避免用户定制缓存污染源。 */
export function getDefaultSkillsBaselineDir(defaultSkillsDir = getDefaultSkillsDir()): string {
  return join(defaultSkillsDir, '.domi-builtin-baselines')
}

/**
 * 获取打包进 App 的 Domi CLI 二进制路径。
 *
 * 打包模式下从 process.resourcesPath/bin 取（electron-builder extraResources 注入）。
 * 开发模式下没有编译二进制——返回 undefined，由调用方回退到源码运行
 * （bun apps/cli/src/index.ts）。
 *
 * @returns 二进制绝对路径；不存在时返回 undefined
 */
export function getBundledCliPath(): string | undefined {
  const { app } = require('electron')
  if (!app.isPackaged) return undefined
  const binName = process.platform === 'win32'
    ? `${CLI_EXECUTABLE_BASENAME}.exe`
    : CLI_EXECUTABLE_BASENAME
  const cliPath = join(process.resourcesPath, 'bin', binName)
  return existsSync(cliPath) ? cliPath : undefined
}

/**
 * 从 SKILL.md 的 YAML frontmatter 中解析 version 字段
 *
 * 无 version 字段时返回 '0.0.0'（确保旧 Skill 会被更新）。
 */
export function parseSkillVersion(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return '0.0.0'

  try {
    let content = readFileSync(skillMdPath, 'utf-8')
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch?.[1]) return '0.0.0'

    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'version' && value) return value
    }
  } catch {
    // 解析失败视为最低版本
  }

  return '0.0.0'
}

/** 比较两个 semver 版本字符串
 *
 * @returns 正数表示 a > b，0 表示相等，负数表示 a < b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 已从 App bundle 移除、但仍需在既有用户目录中清理的默认 Skills。
 *
 * 不根据 bundle 中缺失的目录自动删除，避免误删用户自行安装的 Skills；
 * 后续退役某个内置 Skill 时，显式把它的 slug 加到这里。
 */
export const RETIRED_DEFAULT_SKILL_SLUGS: readonly string[] = [
  'brainstorming',
  'proma-coach',
]

const RETIRED_DEFAULT_SKILL_SLUG_SET = new Set(RETIRED_DEFAULT_SKILL_SLUGS)

export function isRetiredDefaultSkill(slug: string): boolean {
  return RETIRED_DEFAULT_SKILL_SLUG_SET.has(slug)
}

/** 只清理可证明仍为未修改 Domi baseline 的退役默认 Skill 缓存。 */
export function removeRetiredDefaultSkills(
  dir = getDefaultSkillsDir(),
  manifest = readDefaultSkillsManifest(dir),
): void {
  for (const slug of RETIRED_DEFAULT_SKILL_SLUGS) {
    const target = join(dir, slug)
    if (!existsSync(target)) continue
    const knownHashes = manifest.skills[slug]?.knownBaselineHashes ?? []
    if (!isUnmodifiedDefaultSkill(target, knownHashes)) {
      console.warn(`[配置] 退役默认 Skill 已被修改或来源不明，保留: ${slug}`)
      continue
    }

    try {
      rmSyncWithRetry(target, { recursive: true, force: true })
      console.log(`[配置] 已移除退役默认 Skill: ${slug}`)
    } catch (err) {
      console.warn(`[配置] 移除退役默认 Skill 失败 (${slug}):`, err)
    }
  }
}

function mergeShippedDefaultSkillManifest(
  manifest: DefaultSkillsManifest,
  bundledDir: string,
): DefaultSkillsManifest {
  const shippedPath = join(bundledDir, 'default-skills-manifest.json')
  if (!existsSync(shippedPath)) return manifest
  try {
    const shipped = JSON.parse(readFileSync(shippedPath, 'utf-8')) as DefaultSkillsManifest
    if (shipped.schemaVersion !== 1 || !shipped.skills) return manifest
    for (const [slug, entry] of Object.entries(shipped.skills)) {
      const existing = manifest.skills[slug]
      manifest.skills[slug] = {
        version: existing?.version ?? entry.version,
        currentHash: existing?.currentHash ?? entry.currentHash,
        knownBaselineHashes: [...new Set([
          ...(entry.knownBaselineHashes ?? []),
          ...(existing?.knownBaselineHashes ?? []),
        ])].sort(),
      }
    }
  } catch (error) {
    console.warn('[配置] 读取内置默认 Skill baseline manifest 失败:', error)
  }
  return manifest
}

/**
 * 从 app bundle 同步默认 Skills 到 ~/.domi/default-skills/
 *
 * 打包模式下从 process.resourcesPath/default-skills 复制。
 * 开发模式下从源码 default-skills/ 目录复制。
 *
 * - 缺失的 Skill：直接复制
 * - 已存在的 Skill：比较 SKILL.md 中的 version，bundled 更新时才覆盖
 *   （避免每次启动同步 4MB+ 文件阻塞主进程）
 */
export function syncBundledDefaultSkills(bundledDir: string, userDir: string): void {
  if (!existsSync(bundledDir)) {
    console.log('[配置] 未找到内置 default-skills 目录，跳过')
    return
  }

  const manifest = mergeShippedDefaultSkillManifest(readDefaultSkillsManifest(userDir), bundledDir)
  const baselineDir = getDefaultSkillsBaselineDir(userDir)
  removeRetiredDefaultSkills(userDir, manifest)
  for (const slug of RETIRED_DEFAULT_SKILL_SLUGS) {
    rmSyncWithRetry(join(baselineDir, slug), { recursive: true, force: true })
  }

  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory() || isRetiredDefaultSkill(entry.name)) continue

      const source = join(bundledDir, entry.name)
      const target = join(userDir, entry.name)
      const baselineTarget = join(baselineDir, entry.name)
      const bundledVer = parseSkillVersion(source)
      const bundledHash = computeSkillDirectoryHash(source)
      const knownHashes = manifest.skills[entry.name]?.knownBaselineHashes ?? []

      try {
        if (!existsSync(baselineTarget)) {
          copyManagedSkillDirectory(source, baselineTarget, {
            slug: entry.name,
            version: bundledVer,
            baselineHash: bundledHash,
          })
        } else if (computeSkillDirectoryHash(baselineTarget) !== bundledHash) {
          replaceManagedSkillDirectory(source, baselineTarget, {
            slug: entry.name,
            version: bundledVer,
            baselineHash: bundledHash,
          })
        }

        if (!existsSync(target)) {
          copyManagedSkillDirectory(source, target, {
            slug: entry.name,
            version: bundledVer,
            baselineHash: bundledHash,
          })
          console.log(`[配置] 已同步默认 Skill: ${entry.name}`)
        } else {
          const existingVer = parseSkillVersion(target)
          const canReplace = isUnmodifiedDefaultSkill(target, knownHashes)
          if (compareSemver(bundledVer, existingVer) > 0 && canReplace) {
            const replaced = replaceManagedSkillDirectory(source, target, {
              slug: entry.name,
              version: bundledVer,
              baselineHash: bundledHash,
            })
            if (replaced) {
              console.log(`[配置] 已升级默认 Skill: ${entry.name} (${existingVer} → ${bundledVer})`)
            }
          } else if (!canReplace && compareSemver(bundledVer, existingVer) > 0) {
            console.warn(`[配置] 默认 Skill 已被修改或来源不明，跳过升级: ${entry.name}`)
          }
        }
        recordDefaultSkillBaseline(manifest, entry.name, bundledVer, bundledHash)
      } catch (err) {
        console.warn(`[配置] 同步默认 Skill 失败 (${entry.name})，跳过:`, err)
      }
    }
    writeDefaultSkillsManifest(userDir, manifest)
  } catch (err) {
    console.warn('[配置] 同步默认 Skills 失败:', err)
  }
}

export function seedDefaultSkills(): void {
  const { app } = require('electron')
  const bundledDir = app.isPackaged
    ? join(process.resourcesPath, 'default-skills')
    : join(__dirname, '../default-skills')
  syncBundledDefaultSkills(bundledDir, getDefaultSkillsDir())
}

/**
 * 获取微信配置文件路径
 *
 * @returns ~/.domi/wechat.json
 */
export function getWeChatConfigPath(): string {
  return join(getConfigDir(), 'wechat.json')
}

/**
 * 获取微信长轮询同步游标路径
 *
 * @returns ~/.domi/wechat-sync.json
 */
export function getWeChatSyncPath(): string {
  return join(getConfigDir(), 'wechat-sync.json')
}

/**
 * 获取微信聊天绑定持久化路径
 *
 * @returns ~/.domi/wechat-bindings.json
 */
export function getWeChatBindingsPath(): string {
  return join(getConfigDir(), 'wechat-bindings.json')
}

/**
 * 获取钉钉配置文件路径
 *
 * @returns ~/.domi/dingtalk.json
 */
export function getDingTalkConfigPath(): string {
  return join(getConfigDir(), 'dingtalk.json')
}

/**
 * 获取某个钉钉 Bot 的聊天绑定持久化路径
 *
 * @returns ~/.domi/dingtalk-bindings-{botId}.json
 */
export function getDingTalkBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `dingtalk-bindings-${botId}.json`)
}

/**
 * 获取飞书配置文件路径
 *
 * @returns ~/.domi/feishu.json
 */
export function getFeishuConfigPath(): string {
  return join(getConfigDir(), 'feishu.json')
}

/**
 * 获取飞书聊天绑定持久化路径
 *
 * @returns ~/.domi/feishu-bindings.json
 */
export function getFeishuBindingsPath(): string {
  return join(getConfigDir(), 'feishu-bindings.json')
}

/**
 * 获取某个飞书 Bot 的聊天绑定持久化路径
 *
 * @returns ~/.domi/feishu-bindings-{botId}.json
 */
export function getFeishuBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `feishu-bindings-${botId}.json`)
}

/**
 * 获取某个飞书 Bot 的运行时元数据持久化路径
 *
 * 用于保存最近交互用户 open_id 等需要跨进程重启恢复的状态。
 *
 * @returns ~/.domi/feishu-metadata-{botId}.json
 */
export function getFeishuBotMetadataPath(botId: string): string {
  return join(getConfigDir(), `feishu-metadata-${botId}.json`)
}

/**
 * 获取指定 Agent 会话的工作路径
 *
 * 在工作区目录下创建以 sessionId 命名的子文件夹，
 * 作为该会话的独立 Agent cwd。如果目录不存在则自动创建。
 *
 * @param workspaceSlug 工作区 slug
 * @param sessionId 会话 ID
 * @returns ~/.domi/agent-workspaces/{slug}/{sessionId}/
 */
export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  const dir = join(getAgentWorkspacePath(workspaceSlug), sessionId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话工作目录: ${dir}`)
  }

  return dir
}

/**
 * 获取 SDK 隔离配置目录路径
 *
 * 用于设置 CLAUDE_CONFIG_DIR 环境变量，让 SDK 读取独立的配置文件，
 * 而不是用户的 ~/.claude.json，实现 Domi 与 Claude Code CLI 的配置隔离。
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.domi/sdk-config/
 */
export function getSdkConfigDir(): string {
  const dir = join(getConfigDir(), 'sdk-config')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 SDK 配置目录: ${dir}`)
  }

  return dir
}

/**
 * 获取 Scratch Pad 文件路径
 *
 * @returns ~/.domi/scratch-pad.md
 */
export function getScratchPadPath(): string {
  return join(getConfigDir(), 'scratch-pad.md')
}

/**
 * 获取定时任务（Automation）配置文件路径
 *
 * @returns ~/.domi/automations.json
 */
export function getAutomationsPath(): string {
  return join(getConfigDir(), 'automations.json')
}

/** 获取任务/日程 SQLite 数据库路径。 */
export function getPlanningDatabasePath(): string {
  return join(getConfigDir(), 'planning.db')
}
