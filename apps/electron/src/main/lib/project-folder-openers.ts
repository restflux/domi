/**
 * project-folder-openers — 项目文件夹「打开方式」服务
 *
 * 主进程负责三件事：
 * 1. 按平台检测本机可用的打开方式（文件管理器 / 编辑器 / 终端）；
 * 2. 用 Electron app.getFileIcon 读取应用真实图标（PNG data URL）；
 * 3. 用本文件固定注册表中的命令启动外部应用打开项目文件夹。
 *
 * Renderer 只提交不透明 openerId 与 workspaceId；物理路径解析沿用
 * resolveAgentWorkspaceProjectFolder，命令与应用名全部来自固定白名单，
 * 不接受 renderer 提供的任意路径、命令或参数。
 */
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import { app as electronApp, shell } from 'electron'
import { FILE_MANAGER_OPENER_ID, type ProjectFolderOpener } from '@domi/shared'

/** 主进程侧导出，便于 ipc 与测试引用 */
export { FILE_MANAGER_OPENER_ID }

/** 平台可用性探测与图标读取；测试可注入假实现 */
export interface FolderOpenerRuntime {
  platform: string
  /** macOS .app bundle 完整路径；不存在返回 null（/Applications、~/Applications 与系统目录） */
  appBundlePath: (appName: string) => string | null
  /** CLI 命令解析出的完整路径（win32 用 where.exe，其余平台用 which）；不可解析返回 null */
  cliPath: (command: string) => string | null
  /** 物理路径是否存在（用于 Windows 从 .cmd 垫片定位实际 exe） */
  pathExists: (target: string) => boolean
  /** 读取应用真实图标为 PNG data URL；失败返回 null（渲染层回退通用图标） */
  getFileIcon: (target: string) => Promise<string | null>
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
  /** 图标读取目标（.app / exe 实体路径）；无目标或探测失败返回 null */
  iconTarget?: (runtime: FolderOpenerRuntime) => string | null
}

/** macOS 常见 .app 安装位置（含系统自带 Terminal 与 Finder 所在目录） */
const MAC_APP_BUNDLE_DIRS = [
  '/Applications',
  () => join(homedir(), 'Applications'),
  '/Applications/Utilities',
  '/System/Applications/Utilities',
  '/System/Library/CoreServices',
]

function macAppBundlePath(appName: string): string | null {
  for (const entry of MAC_APP_BUNDLE_DIRS) {
    const dir = typeof entry === 'function' ? entry() : entry
    const candidate = join(dir, `${appName}.app`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function resolveCliPath(command: string): string | null {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const result = spawnSync(probe, [command], { timeout: 5000, windowsHide: true })
    if (result.status !== 0) return null
    const firstLine = result.stdout.toString().split('\n').map((line) => line.trim()).find(Boolean)
    return firstLine ?? null
  } catch {
    return null
  }
}

async function electronFileIcon(target: string): Promise<string | null> {
  try {
    const image = await electronApp.getFileIcon(target, { size: 'normal' })
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    // Linux 平台或不支持的目标会失败；渲染层回退通用图标。
    return null
  }
}

/** 真实运行环境（fs + where/which 探测 + Electron 图标读取） */
export function createDefaultRuntime(): FolderOpenerRuntime {
  return {
    platform: process.platform,
    appBundlePath: macAppBundlePath,
    cliPath: resolveCliPath,
    pathExists: (target) => existsSync(target),
    getFileIcon: electronFileIcon,
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

/** Windows：CLI 垫片（code.cmd 等）通常位于 <安装根>/bin/，实际 exe 在安装根下。
 *  使用 win32 路径语义，保证非 Windows 宿主上的单元测试也能正确拼接。 */
function windowsSiblingExe(runtime: FolderOpenerRuntime, command: string, exeName: string): string | null {
  const shim = runtime.cliPath(command)
  if (!shim) return null
  const siblingExe = path.win32.join(path.win32.dirname(shim), '..', exeName)
  if (runtime.pathExists(siblingExe)) return siblingExe
  // 找不到 exe 时退回垫片本身；getFileIcon 会给出通用图标或失败回退。
  return shim
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
    iconTarget: (runtime) => runtime.appBundlePath('Finder'),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundlePath('Visual Studio Code') ? macOpenApp('Visual Studio Code', dir) : null),
    iconTarget: (runtime) => runtime.appBundlePath('Visual Studio Code'),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundlePath('Cursor') ? macOpenApp('Cursor', dir) : null),
    iconTarget: (runtime) => runtime.appBundlePath('Cursor'),
  },
  {
    id: 'zed',
    label: 'Zed',
    kind: 'editor',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundlePath('Zed') ? macOpenApp('Zed', dir) : null),
    iconTarget: (runtime) => runtime.appBundlePath('Zed'),
  },
  {
    id: 'terminal',
    label: '终端',
    kind: 'terminal',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundlePath('Terminal') ? macOpenApp('Terminal', dir) : null),
    iconTarget: (runtime) => runtime.appBundlePath('Terminal'),
  },
  {
    id: 'iterm2',
    label: 'iTerm2',
    kind: 'terminal',
    platforms: ['darwin'],
    createLaunch: (runtime, dir) => (runtime.appBundlePath('iTerm') ? macOpenApp('iTerm', dir) : null),
    iconTarget: (runtime) => runtime.appBundlePath('iTerm'),
  },

  // ===== Windows =====
  {
    id: FILE_MANAGER_OPENER_ID,
    label: '资源管理器',
    kind: 'file-manager',
    platforms: ['win32'],
    createLaunch: () => ({ type: 'openPath' }),
    iconTarget: (runtime) => runtime.cliPath('explorer'),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    platforms: ['win32'],
    createLaunch: (runtime, dir) => (runtime.cliPath('code') ? windowsStart(['code', dir]) : null),
    iconTarget: (runtime) => windowsSiblingExe(runtime, 'code', 'Code.exe'),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    platforms: ['win32'],
    createLaunch: (runtime, dir) => (runtime.cliPath('cursor') ? windowsStart(['cursor', dir]) : null),
    iconTarget: (runtime) => windowsSiblingExe(runtime, 'cursor', 'Cursor.exe'),
  },
  {
    id: 'windows-terminal',
    label: 'Windows 终端',
    kind: 'terminal',
    platforms: ['win32'],
    createLaunch: (runtime, dir) => (runtime.cliPath('wt') ? windowsStart(['wt', '-d', dir]) : null),
    iconTarget: (runtime) => runtime.cliPath('wt'),
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    kind: 'terminal',
    platforms: ['win32'],
    // 以项目文件夹为工作目录启动交互式 PowerShell
    createLaunch: (runtime, dir) => (runtime.cliPath('powershell')
      ? { type: 'spawn', command: 'powershell.exe', args: ['-NoExit'], options: { cwd: dir } }
      : null),
    iconTarget: (runtime) => runtime.cliPath('powershell'),
  },

  // ===== Linux =====
  {
    id: FILE_MANAGER_OPENER_ID,
    label: '文件管理器',
    kind: 'file-manager',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => (runtime.cliPath('xdg-open')
      ? { type: 'spawn', command: 'xdg-open', args: [dir] }
      : null),
    // Linux 无统一的应用实体路径可读图标；渲染层回退通用图标。
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => (runtime.cliPath('code')
      ? { type: 'spawn', command: 'code', args: [dir] }
      : null),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => (runtime.cliPath('cursor')
      ? { type: 'spawn', command: 'cursor', args: [dir] }
      : null),
  },
  {
    id: 'terminal',
    label: '系统终端',
    kind: 'terminal',
    platforms: ['linux'],
    createLaunch: (runtime, dir) => {
      const candidate = LINUX_TERMINAL_CANDIDATES.find(({ command }) => runtime.cliPath(command))
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

/** 列出当前平台可用的打开方式（含系统读取的真实应用图标）。默认运行环境带短 TTL 缓存，避免每次打开菜单都同步探测 CLI。 */
export async function listProjectFolderOpeners(runtime?: FolderOpenerRuntime): Promise<ProjectFolderOpener[]> {
  if (!runtime) {
    const now = Date.now()
    if (cachedDefaultOpeners && now - cachedDefaultOpeners.at < OPENER_PROBE_CACHE_TTL_MS) {
      return cachedDefaultOpeners.openers
    }
    const openers = await collectFolderOpeners(createDefaultRuntime())
    cachedDefaultOpeners = { at: now, openers }
    return openers
  }
  return collectFolderOpeners(runtime)
}

/** 探测结果缓存（仅默认运行环境）：安装新应用后至多 1 分钟内自动刷新菜单。 */
const OPENER_PROBE_CACHE_TTL_MS = 60_000
let cachedDefaultOpeners: { at: number; openers: ProjectFolderOpener[] } | null = null

async function collectFolderOpeners(runtime: FolderOpenerRuntime): Promise<ProjectFolderOpener[]> {
  const available = FOLDER_OPENER_SPECS
    .filter((spec) => spec.platforms.includes(runtime.platform))
    .filter((spec) => spec.createLaunch(runtime, '') !== null)

  return Promise.all(available.map(async (spec) => {
    const target = spec.iconTarget?.(runtime) ?? null
    const icon = target ? await runtime.getFileIcon(target) : null
    return icon ? { id: spec.id, label: spec.label, kind: spec.kind, icon } : { id: spec.id, label: spec.label, kind: spec.kind }
  }))
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
