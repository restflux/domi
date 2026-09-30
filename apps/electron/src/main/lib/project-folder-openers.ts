/**
 * project-folder-openers — 项目文件夹「打开方式」服务
 *
 * 主进程负责两件事：
 * 1. 按平台检测本机可用的打开方式（文件管理器 / 编辑器 / 终端）；
 * 2. 用本文件固定注册表中的命令启动外部应用打开项目文件夹。
 *
 * Renderer 只提交不透明 openerId 与 workspaceId；物理路径解析沿用
 * resolveAgentWorkspaceProjectFolder，命令与应用名全部来自固定白名单，
 * 不接受 renderer 提供的任意路径、命令或参数。
 */
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { FILE_MANAGER_OPENER_ID, type ProjectFolderOpener } from '@domi/shared'

/** 主进程侧导出，便于 ipc 与测试引用 */
export { FILE_MANAGER_OPENER_ID }

/** 平台可用性探测；测试可注入假实现 */
export interface FolderOpenerRuntime {
  platform: string
  /** macOS .app bundle 是否存在（/Applications、~/Applications 与系统工具目录） */
  appBundleExists: (appName: string) => boolean
  /** CLI 命令是否可解析（win32 用 where.exe，其余平台用 which） */
  cliExists: (command: string) => boolean
}

/** 启动执行器；测试可注入假实现 */
export interface FolderOpenerRunner {
  /** 后台启动外部命令并立即返回（detached + unref，不等待应用退出） */
  spawnDetached: (command: string, args: string[], options?: SpawnOptions) => void
  /** 交给系统默认方式打开（electron shell.openPath，返回错误信息或空串） */
  openPath: (target: string) => Promise<string>
}

/** 一次打开动作的执行描述 */
export type FolderOpenerLaunch =
  | { type: 'openPath' }
  | { type: 'spawn'; command: string; args: string[]; options?: SpawnOptions }

interface FolderOpenerSpec extends ProjectFolderOpener {
  /** 允许的平台；不支持的平台既不出现在列表中也不可执行 */
  platforms: readonly string[]
  /**
   * 根据探测结果构造启动描述；应用不可用时返回 null。
   * folderPath 只由主进程解析后传入，不参与可用性判断。
   */
  createLaunch: (runtime: FolderOpenerRuntime, folderPath: string) => FolderOpenerLaunch | null
}

/** macOS 常见 .app 安装位置（含系统自带 Terminal.app 所在目录） */
const MAC_APP_BUNDLE_DIRS = [
  '/Applications',
  () => join(homedir(), 'Applications'),
  '/Applications/Utilities',
  '/System/Applications/Utilities',
]

function macAppBundleExists(appName: string): boolean {
  return MAC_APP_BUNDLE_DIRS.some((entry) => {
    const dir = typeof entry === 'function' ? entry() : entry
    return existsSync(join(dir, `${appName}.app`))
  })
}

function cliCommandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    return spawnSync(probe, [command], { timeout: 5000, windowsHide: true }).status === 0
  } catch {
    return false
  }
}

/** 真实运行环境（fs + where/which 探测） */
export function createDefaultRuntime(): FolderOpenerRuntime {
  return {
    platform: process.platform,
    appBundleExists: macAppBundleExists,
    cliExists: cliCommandExists,
  }
}

/** 真实执行器（spawn detached + electron shell.openPath） */
export function createDefaultRunner(): FolderOpenerRunner {
  return {
    spawnDetached: (command, args, options) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options })
      child.on('error', () => {
        // detached 启动失败只记录；调用方菜单里已有错误提示兜底。
        console.warn(`[打开方式] 启动外部命令失败: ${command}`)
      })
      child.unref()
    },
    openPath: (target) => shell.openPath(target),
  }
}

/** macOS 编辑器 / 终端的 `open -a` 启动描述 */
function macOpenApp(appName: string, folderPath: string): FolderOpenerLaunch {
  return { type: 'spawn', command: 'open', args: ['-a', appName, folderPath] }
}

/** Windows 下经 cmd `start` 后台启动 GUI 程序；目标目录带空格时由 Node 自动加引号 */
function windowsStart(args: string[]): FolderOpenerLaunch {
  return { type: 'spawn', command: 'cmd.exe', args: ['/d', '/c', 'start', '', ...args] }
}

/** Linux 终端候选：按顺序探测第一个可用的命令 */
const LINUX_TERMINAL_CANDIDATES: readonly { command: string; args: (dir: string) => string[] }[] = [
  { command: 'gnome-terminal', args: (dir) => [`--working-directory=${dir}`] },
  { command: 'konsole', args: (dir) => ['--workdir', dir] },
  { command: 'xfce4-terminal', args: (dir) => ['--working-directory', dir] },
  // Debian 系别名；无目录参数，通过 spawn cwd 打开
  { command: 'x-terminal-emulator', args: () => [] },
]

/**
 * 固定打开方式注册表。顺序即菜单展示顺序：
 * 文件管理器在前，随后编辑器，最后终端。
 */
const FOLDER_OPENER_SPECS: readonly FolderOpenerSpec[] = [
  // ===== macOS =====
  {
    id: FILE_MANAGER_OPENER_ID,
    label: '访达',
    kind: 'file-manager',
    platforms: ['darwin'],
    createLaunch: () => ({ type: 'openPath' }),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundleExists('Visual Studio Code') ? macOpenApp('Visual Studio Code', dir) : null),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundleExists('Cursor') ? macOpenApp('Cursor', dir) : null),
  },
  {
    id: 'zed',
    label: 'Zed',
    kind: 'editor',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundleExists('Zed') ? macOpenApp('Zed', dir) : null),
  },
  {
    id: 'terminal',
    label: '终端',
    kind: 'terminal',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundleExists('Terminal') ? macOpenApp('Terminal', dir) : null),
  },
  {
    id: 'iterm2',
    label: 'iTerm2',
    kind: 'terminal',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundleExists('iTerm') ? macOpenApp('iTerm', dir) : null),
  },

  // ===== Windows =====
  {
    id: FILE_MANAGER_OPENER_ID,
    label: '资源管理器',
    kind: 'file-manager',
    platforms: ['win32'],
    createLaunch: () => ({ type: 'openPath' }),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    platforms: ['win32'],
    createLaunch: (runtime, dir) => (runtime.cliExists('code') ? windowsStart(['code', dir]) : null),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    platforms: ['win32'],
    createLaunch: (runtime, dir) => (runtime.cliExists('cursor') ? windowsStart(['cursor', dir]) : null),
  },
  {
    id: 'windows-terminal',
    label: 'Windows 终端',
    kind: 'terminal',
    platforms: ['win32'],
    createLaunch: (runtime, dir) => (runtime.cliExists('wt') ? windowsStart(['wt', '-d', dir]) : null),
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    kind: 'terminal',
    platforms: ['win32'],
    // 以项目文件夹为工作目录启动交互式 PowerShell
    createLaunch: (runtime, dir) => (runtime.cliExists('powershell')
      ? { type: 'spawn', command: 'powershell.exe', args: ['-NoExit'], options: { cwd: dir } }
      : null),
  },

  // ===== Linux =====
  {
    id: FILE_MANAGER_OPENER_ID,
    label: '文件管理器',
    kind: 'file-manager',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => (runtime.cliExists('xdg-open')
      ? { type: 'spawn', command: 'xdg-open', args: [dir] }
      : null),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => (runtime.cliExists('code')
      ? { type: 'spawn', command: 'code', args: [dir] }
      : null),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => (runtime.cliExists('cursor')
      ? { type: 'spawn', command: 'cursor', args: [dir] }
      : null),
  },
  {
    id: 'terminal',
    label: '系统终端',
    kind: 'terminal',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => {
      const candidate = LINUX_TERMINAL_CANDIDATES.find(({ command }) => runtime.cliExists(command))
      if (!candidate) return null
      const args = candidate.args(dir)
      return {
        type: 'spawn' as const,
        command: candidate.command,
        args,
        options: args.length === 0 ? { cwd: dir } : undefined,
      }
    },
  },
]

/** 列出当前平台可用的打开方式（探测结果供菜单渲染）。默认运行环境带短 TTL 缓存，避免每次打开菜单都同步探测 CLI。 */
export function listProjectFolderOpeners(runtime?: FolderOpenerRuntime): ProjectFolderOpener[] {
  if (!runtime) {
    const now = Date.now()
    if (cachedDefaultOpeners && now - cachedDefaultOpeners.at < OPENER_PROBE_CACHE_TTL_MS) {
      return cachedDefaultOpeners.openers
    }
    const openers = collectFolderOpeners(createDefaultRuntime())
    cachedDefaultOpeners = { at: now, openers }
    return openers
  }
  return collectFolderOpeners(runtime)
}

/** 探测结果缓存（仅默认运行环境）：安装新应用后至多 1 分钟内自动刷新菜单。 */
const OPENER_PROBE_CACHE_TTL_MS = 60_000
let cachedDefaultOpeners: { at: number; openers: ProjectFolderOpener[] } | null = null

function collectFolderOpeners(runtime: FolderOpenerRuntime): ProjectFolderOpener[] {
  return FOLDER_OPENER_SPECS
    .filter((spec) => spec.platforms.includes(runtime.platform))
    .filter((spec) => spec.createLaunch(runtime, '') !== null)
    .map(({ id, label, kind }) => ({ id, label, kind }))
}

/**
 * 使用指定应用打开项目文件夹。
 * openerId 必须命中当前平台注册表中可用的一项，否则抛错。
 */
export async function openProjectFolderWith(
  openerId: string,
  folderPath: string,
  deps: { runtime?: FolderOpenerRuntime; runner?: FolderOpenerRunner } = {},
): Promise<void> {
  const runtime = deps.runtime ?? createDefaultRuntime()
  const runner = deps.runner ?? createDefaultRunner()
  const spec = FOLDER_OPENER_SPECS.find(
    (candidate) => candidate.id === openerId && candidate.platforms.includes(runtime.platform),
  )
  if (!spec) throw new Error(`未知的打开方式: ${openerId}`)

  const launch = spec.createLaunch(runtime, folderPath)
  if (!launch) throw new Error(`${spec.label} 未安装或不可用`)

  if (launch.type === 'openPath') {
    const errorMessage = await runner.openPath(folderPath)
    if (errorMessage) throw new Error(`无法打开项目文件夹：${errorMessage}`)
    return
  }

  runner.spawnDetached(launch.command, launch.args, launch.options)
}
