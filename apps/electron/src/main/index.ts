import './lib/initialize-product-identity.ts'
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeTheme, protocol, screen, shell } from 'electron'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { getConfigDir, seedDefaultSkills } from './lib/config-paths'
import { createRuntimeDiagnostics, describeDiagnosticError } from './lib/runtime-diagnostics'
import { registerEditableContextMenus } from './lib/editable-context-menu'
import { runAppStartupSequence } from './lib/app-startup-sequence'

const runtimeDiagnostics = createRuntimeDiagnostics({
  directory: join(getConfigDir(), 'logs'),
  appVersion: app.getVersion(),
})

// 单实例锁：防止重复启动同一个版本（dev/prod 因 userData 已隔离，互不影响）
//
// 失败的常见原因：用户升级新版本时旧版进程仍在后台运行（macOS 关闭窗口 = hide
// 不退出）。原先此处直接 process.exit(0)，没有任何用户可见反馈——如果旧进程
// 卡在启动期，second-instance 也唤不起窗口，用户表现就是"双击应用没反应"。
// 改为：留下 stderr 排查线索后正常退出，让 Electron 触发已存在实例的
// second-instance 事件，由主实例负责显示窗口。
if (!app.requestSingleInstanceLock()) {
  console.warn(
    '[启动] 已有 Domi 进程持有单实例锁，本次启动将退出。\n' +
      '  如果窗口未出现，可能旧进程已卡死。请结束 Domi 进程后重试。',
  )
  app.quit()
} else {
  // 主流程：正常启动（单实例锁已获取）
  registerProtocolsAndHandlers()
}

function registerProtocolsAndHandlers(): void {
  initializeRuntimeDiagnostics()
  registerEditableContextMenus(app, ipcMain)

  // 注册自定义协议方案为"特权"（必须在 app ready 之前）
  // 用于内联预览本地文件（renderer 用 iframe 加载 domi-file:// 资源）
  protocol.registerSchemesAsPrivileged([
    { scheme: 'domi-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ])

  // Windows: 禁用 LCD 次像素抗锯齿（ClearType），改用灰度 AA。
  // ClearType 是为浅色背景+深色文字设计的，在深色代码块背景下会产生彩色边缘，导致文字模糊。
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('disable-lcd-text')
  }

  // macOS 文件关联：在 app ready 之前注册 open-file 事件
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    handleMigrationFileOpen(filePath)
  })

  // Windows 文件关联：当用户双击文件时，新实例的参数会通过 second-instance 传给已有实例
  app.on('second-instance', (_event, argv) => {
    showAndFocusMainWindow()
    const fileArg = argv.find(isSupportedMigrationImportFile)
    if (fileArg) {
      handleMigrationFileOpen(fileArg)
    }
  })
}

let runtimeDiagnosticsInitialized = false

function initializeRuntimeDiagnostics(): void {
  if (runtimeDiagnosticsInitialized) return
  runtimeDiagnosticsInitialized = true

  try {
    crashReporter.start({ uploadToServer: false })
    runtimeDiagnostics.record('crash_reporter_started', {
      crashDumpsPath: app.getPath('crashDumps'),
    })
  } catch (error) {
    runtimeDiagnostics.record('crash_reporter_start_failed', describeDiagnosticError(error))
  }

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    runtimeDiagnostics.record('main_uncaught_exception', {
      origin,
      error: describeDiagnosticError(error),
    })
  })
  // Node 会把默认模式下的未处理 Promise rejection 提升为 uncaught exception；
  // uncaughtExceptionMonitor 能旁路记录且不改变退出语义。不要注册 unhandledRejection
  // listener，否则会意外吞掉原本应终止进程的 rejection。
  app.on('child-process-gone', (_event, details) => {
    runtimeDiagnostics.record('child_process_gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
      metrics: getSafeAppMetrics(),
    })
  })
}

function getSafeAppMetrics(): Array<Record<string, unknown>> {
  try {
    return app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      cpuPercent: metric.cpu?.percentCPUUsage,
      workingSetSize: metric.memory?.workingSetSize,
      peakWorkingSetSize: metric.memory?.peakWorkingSetSize,
    }))
  } catch (error) {
    return [{ metricsError: describeDiagnosticError(error) }]
  }
}

import { getSettings, updateSettings } from './lib/settings-service'
import { handleDomiFileRequest } from './lib/local-file-protocol'

// 处理 EPIPE 错误：当 stdout/stderr 管道被关闭时（如 electronmon 重启），忽略写入错误
// 这在开发环境热重载时经常发生，不影响应用功能
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})

// 清理本地环境中的 ANTHROPIC_* 变量，防止干扰应用的认证流程
// Electron 桌面应用通过渠道系统管理 API Key，不应受终端环境变量影响
// 注意：此操作必须在 initializeRuntime()（loadShellEnv）之前执行
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTHROPIC_')) {
    delete process.env[key]
  }
}

import { createApplicationMenu } from './menu'
import { registerIpcHandlers } from './ipc'
import { createTray, destroyTray, getTray } from './tray'
import { initializeRuntime } from './lib/runtime-init'
import { upgradeDefaultSkillsInWorkspaces } from './lib/agent-workspace-manager'
import { stopAllAgents, cleanupAgentRuntimeResources } from './lib/agent-service'
import { disposePiMcpConnections } from './lib/adapters/pi-mcp-tools'
import { markRunningDelegationsAsInterrupted } from './lib/agent-session-manager'
import { reconcileProductionSessionCheckouts } from './lib/session-checkout/production.ts'
import { stopAllGenerations } from './lib/chat-service'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from './lib/workspace-watcher'
import { startChatToolsWatcher, stopChatToolsWatcher } from './lib/chat-tools-watcher'
import { getIsQuitting, setQuitting } from './lib/app-lifecycle'
import {
  registerBridge,
  startAllBridges,
  startBridgeSelfHealing,
  stopAllBridges,
  stopBridgeSelfHealing,
} from './lib/bridge-registry'
import { startScheduler, stopScheduler } from './lib/automation-scheduler'
import { startPlanningReminderScheduler, stopPlanningReminderScheduler } from './lib/planning-reminder-scheduler'
import { feishuBridgeManager } from './lib/feishu-bridge-manager'
import { getFeishuMultiBotConfig } from './lib/feishu-config'
import { stopFeishuSyncSleepBlocker, syncFeishuSyncSleepBlocker } from './lib/feishu-sleep-blocker'
import { getPersistableMainWindowState, hideMacMainWindowAfterClose } from './lib/main-window-lifecycle'
import {
  disposeWorkActivityNotificationService,
  startWorkActivityNotificationService,
} from './lib/work-activity-notification-service.ts'
import { dingtalkBridgeManager } from './lib/dingtalk-bridge-manager'
import { getDingTalkMultiBotConfig } from './lib/dingtalk-config'
import { wechatBridge } from './lib/wechat-bridge'
import { getWeChatConfig } from './lib/wechat-config'
import { createQuickTaskWindow, toggleQuickTaskWindow, destroyQuickTaskWindow } from './lib/quick-task-window'
import { destroyPlanningWindow, showPlanningWindow } from './lib/planning-window'
import { createAgentIslandWindow, destroyAgentIslandWindow, showAgentIslandWindow } from './lib/agent-island-window'
import { handleNativeAgentIslandEvent, initAgentIslandService, disposeAgentIslandService, publishAgentIslandNow } from './lib/agent-island-service'
import { disposeMacAgentIslandNativeHost, startMacAgentIslandNativeHost } from './lib/mac-agent-island-native-host'
import {
  createVoiceDictationWindow,
  toggleVoiceDictationWindow,
  destroyVoiceDictationWindow,
  shouldSuppressVoiceDictationActivate,
} from './lib/voice-dictation-window'
import { registerGlobalShortcut, unregisterAllGlobalShortcuts } from './lib/global-shortcut-service'
import { setDomiCompatibilityVersion } from '@domi/core'
import { BROWSER_IPC_CHANNELS, isSupportedMigrationImportFile, type BrowserFocusEscapeRequest, type BrowserStateChange } from '@domi/shared'
import { configureBrowserModule, disposeBrowserModule, getBrowserSessionService } from './lib/browser/browser-module.ts'
import { configureTerminalModule, disposeTerminalModule, getTerminalSessionService } from './lib/terminal/terminal-module.ts'
import { terminalRuntimeClient } from './lib/terminal/terminal-runtime-client.ts'
import { TRAY_IPC_CHANNELS } from '../types'

const MIGRATION_IPC_OPEN = 'migration:open-import-file'

let agentIslandElectronFallbackActive = false

/** 非 macOS 或 Swift helper 不可用时的无损降级。 */
function activateAgentIslandElectronFallback(reason?: string): void {
  if (agentIslandElectronFallbackActive) return
  agentIslandElectronFallbackActive = true
  if (reason) console.warn(`[agent-island] 使用 Electron 降级窗口：${reason}`)
  createAgentIslandWindow()
  showAgentIslandWindow()
  publishAgentIslandNow()
}

/** macOS 优先使用真刘海 NSPanel；其他平台保持既有 BrowserWindow 体验。 */
function startAgentIslandSurface(): void {
  const startedNative = startMacAgentIslandNativeHost({
    onReady: () => {
      console.info('[agent-island] macOS 原生 NSPanel helper 已就绪')
      publishAgentIslandNow()
    },
    onEvent: handleNativeAgentIslandEvent,
    onUnavailable: (reason) => activateAgentIslandElectronFallback(reason),
  })
  if (!startedNative) activateAgentIslandElectronFallback(process.platform === 'darwin' ? 'native helper unavailable' : 'non-macOS platform')
}

/** 检查文件路径是否为迁移文件，如果是则通知渲染进程打开导入流程 */
function handleMigrationFileOpen(filePath: string): void {
  if (isSupportedMigrationImportFile(filePath)) {
    sendToMainWindow(MIGRATION_IPC_OPEN, { filePath })
  }
}

// ===== Bridge 注册（新增 Bridge 只需在此添加一个 registerBridge 调用） =====

registerBridge({
  name: '飞书 BridgeManager',
  shouldAutoStart: () => {
    const config = getFeishuMultiBotConfig()
    return config.bots.some((b) => b.enabled && b.appId && b.appSecret)
  },
  needsRecovery: () => {
    const config = getFeishuMultiBotConfig()
    const states = feishuBridgeManager.getStates()
    return config.bots.some((bot) => (
      bot.enabled &&
      !!bot.appId &&
      !!bot.appSecret &&
      states.bots[bot.id]?.status === 'error'
    ))
  },
  start: () => feishuBridgeManager.startAll(),
  stop: () => feishuBridgeManager.stopAll(),
  recover: () => recoverEnabledFeishuBots(),
})

registerBridge({
  name: '钉钉 BridgeManager',
  shouldAutoStart: () => {
    const config = getDingTalkMultiBotConfig()
    return config.bots.some((b) => b.enabled && b.clientId && b.clientSecret)
  },
  needsRecovery: () => {
    const config = getDingTalkMultiBotConfig()
    const states = dingtalkBridgeManager.getStates()
    return config.bots.some((bot) => (
      bot.enabled &&
      !!bot.clientId &&
      !!bot.clientSecret &&
      states.bots[bot.id]?.status === 'error'
    ))
  },
  start: () => dingtalkBridgeManager.startAll(),
  stop: () => dingtalkBridgeManager.stopAll(),
  recover: () => recoverEnabledDingTalkBots(),
})

registerBridge({
  name: '微信 Bridge',
  shouldAutoStart: () => {
    const config = getWeChatConfig()
    return !!(config.enabled && config.credentials)
  },
  needsRecovery: () => wechatBridge.getStatus().status === 'error',
  start: () => wechatBridge.start(),
  stop: () => wechatBridge.stop(),
})

async function recoverEnabledFeishuBots(): Promise<void> {
  const config = getFeishuMultiBotConfig()
  let failedCount = 0
  for (const bot of config.bots) {
    if (!bot.enabled || !bot.appId || !bot.appSecret) continue
    try {
      await feishuBridgeManager.restartBot(bot.id)
    } catch (error) {
      failedCount++
      console.error(`[飞书 BridgeManager] Bot "${bot.name}" 自愈恢复失败:`, error)
    }
  }
  if (failedCount > 0) {
    throw new Error(`${failedCount} 个飞书 Bot 自愈恢复失败`)
  }
}

async function recoverEnabledDingTalkBots(): Promise<void> {
  const config = getDingTalkMultiBotConfig()
  let failedCount = 0
  for (const bot of config.bots) {
    if (!bot.enabled || !bot.clientId || !bot.clientSecret) continue
    try {
      await dingtalkBridgeManager.restartBot(bot.id)
    } catch (error) {
      failedCount++
      console.error(`[钉钉 BridgeManager] Bot "${bot.name}" 自愈恢复失败:`, error)
    }
  }
  if (failedCount > 0) {
    throw new Error(`${failedCount} 个钉钉 Bot 自愈恢复失败`)
  }
}

let mainWindow: BrowserWindow | null = null
let mainWindowReadyPromise: Promise<void> | null = null
let bootstrapStartedAt = 0
let appActivationHandlerRegistered = false
const isLaunchSmoke = process.argv.includes('--launch-smoke')
const isTerminalSmoke = process.argv.includes('--terminal-smoke')

/** 获取主窗口实例（供其他模块使用） */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

function installWindowsZoomInFallback(win: BrowserWindow): void {
  if (process.platform !== 'win32') return

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return

    // Windows 下主键盘的 Ctrl++ 常会以 Ctrl+= 上报；小键盘加号也需要兜底。
    const key = input.key.toLowerCase()
    if (!['=', '+', 'numadd', 'add'].includes(key)) return

    event.preventDefault()
    const currentZoomLevel = win.webContents.getZoomLevel()
    win.webContents.setZoomLevel(Math.min(currentZoomLevel + 0.5, 9))
  })
}

/**
 * 检查窗口是否在可用显示器范围内
 * 处理外接显示器断开后窗口位于不可见区域的情况
 */
function ensureWindowOnScreen(win: BrowserWindow): void {
  const bounds = win.getBounds()
  const displays = screen.getAllDisplays()
  // 检查窗口中心点是否在任一显示器范围内
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const isOnScreen = displays.some((display) => {
    const { x, y, width, height } = display.workArea
    return centerX >= x && centerX <= x + width && centerY >= y && centerY <= y + height
  })
  if (!isOnScreen) {
    // 窗口不在任何屏幕内，移动到主显示器居中位置
    const primary = screen.getPrimaryDisplay()
    const { x, y, width, height } = primary.workArea
    win.setBounds({
      x: x + Math.round((width - bounds.width) / 2),
      y: y + Math.round((height - bounds.height) / 2),
      width: bounds.width,
      height: bounds.height,
    })
    console.log('[窗口] 窗口已重新定位到主显示器')
  }
}

/** 显示并聚焦主窗口，确保窗口在可见区域；若窗口已销毁则重新创建 */
function showAndFocusMainWindow(): void {
  if (process.platform === 'darwin') {
    if (app.dock) app.dock.show()
    app.show()
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow()
    return
  }
  ensureWindowOnScreen(mainWindow)
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Get the appropriate app icon path for the current platform
 */
function getIconPath(): string {
  // resources 在 build:resources 阶段被复制到 dist/ 下，与 main.cjs 同级
  const resourcesDir = join(__dirname, 'resources')

  if (process.platform === 'darwin') {
    return join(resourcesDir, 'icon.icns')
  } else if (process.platform === 'win32') {
    return join(resourcesDir, 'icon.ico')
  } else {
    return join(resourcesDir, 'icon.png')
  }
}

/** macOS Dock 始终使用正式默认图标。 */
function getDockIconPath(): string {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
  return join(resourcesDir, 'icon.png')
}

function saveMainWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const mainWindowState = getPersistableMainWindowState(mainWindow)
  if (!mainWindowState) return
  updateSettings({
    mainWindowState,
  })
}

function isDevServerNavigation(url: string): boolean {
  try {
    return new URL(url).origin === 'http://127.0.0.1:5173'
  } catch {
    return false
  }
}

function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindowReadyPromise ?? Promise.resolve()
  }

  const windowCreationStartedAt = Date.now()
  const iconPath = getIconPath()
  const iconExists = existsSync(iconPath)

  if (!iconExists) {
    console.warn('App icon not found at:', iconPath)
  }

  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'

  const titleBarOptions = isMac
    ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 18, y: 18 },
        vibrancy: 'under-window' as const,
        visualEffectState: 'followWindow' as const,
      }
    : isWindows
      ? { titleBarStyle: 'hidden' as const }
      : {}

  const savedState = getSettings().mainWindowState
  const initialBounds = savedState
    ? { width: savedState.width, height: savedState.height, x: savedState.x, y: savedState.y }
    : { width: 1400, height: 900 }

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 800,
    minHeight: 600,
    icon: iconExists ? iconPath : undefined,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#fafafa',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    ...titleBarOptions,
  })
  installWindowsZoomInFallback(mainWindow)

  const diagnosticWindow = mainWindow
  runtimeDiagnostics.record('main_window_created', {
    durationMs: Date.now() - windowCreationStartedAt,
    sinceBootstrapMs: bootstrapStartedAt > 0 ? Date.now() - bootstrapStartedAt : undefined,
  })
  let resolveWindowReady: (() => void) | null = null
  const windowReadyPromise = new Promise<void>((resolve) => {
    resolveWindowReady = resolve
  })
  let startupContinued = false
  const continueStartup = (
    trigger: 'ready-to-show' | 'load-failed' | 'timeout' | 'closed',
  ): void => {
    if (startupContinued) return
    startupContinued = true
    resolveWindowReady?.()
    resolveWindowReady = null
    runtimeDiagnostics.record('main_window_startup_gate_opened', {
      trigger,
      sinceBootstrapMs: bootstrapStartedAt > 0 ? Date.now() - bootstrapStartedAt : undefined,
    })
  }
  const startupFallbackTimer = setTimeout(() => {
    console.warn('[启动] 主窗口 15 秒内未进入 ready-to-show，显示降级窗口并继续后台初始化')
    if (!isLaunchSmoke && !diagnosticWindow.isDestroyed() && !diagnosticWindow.isVisible()) {
      if (savedState?.isMaximized ?? true) diagnosticWindow.maximize()
      diagnosticWindow.show()
      runtimeDiagnostics.record('main_window_shown', {
        trigger: 'timeout',
        sinceBootstrapMs: bootstrapStartedAt > 0 ? Date.now() - bootstrapStartedAt : undefined,
      })
    }
    continueStartup('timeout')
  }, 15_000)
  startupFallbackTimer.unref?.()

  // 不等待 React 首屏：先展示带主题背景的原生窗口，明确反馈“点击已生效”。
  if (!isLaunchSmoke) {
    if (savedState?.isMaximized ?? true) diagnosticWindow.maximize()
    if (process.platform === 'darwin' && app.dock) app.dock.show()
    diagnosticWindow.show()
    runtimeDiagnostics.record('main_window_shown', {
      trigger: 'window-created',
      sinceBootstrapMs: bootstrapStartedAt > 0 ? Date.now() - bootstrapStartedAt : undefined,
    })
  }

  const diagnosticWebContents = diagnosticWindow.webContents
  let unresponsiveStartedAt: number | null = null
  let lastRendererRecoveryAt = 0

  diagnosticWindow.on('unresponsive', () => {
    unresponsiveStartedAt = Date.now()
    runtimeDiagnostics.record('renderer_unresponsive', {
      windowVisible: diagnosticWindow.isVisible(),
      windowFocused: diagnosticWindow.isFocused(),
      windowMinimized: diagnosticWindow.isMinimized(),
      metrics: getSafeAppMetrics(),
    })
  })

  diagnosticWindow.on('responsive', () => {
    const responsiveAt = Date.now()
    runtimeDiagnostics.record('renderer_responsive', {
      unresponsiveDurationMs: unresponsiveStartedAt == null
        ? undefined
        : responsiveAt - unresponsiveStartedAt,
      metrics: getSafeAppMetrics(),
    })
    unresponsiveStartedAt = null
  })

  diagnosticWebContents.on('render-process-gone', (_event, details) => {
    runtimeDiagnostics.record('render_process_gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      metrics: getSafeAppMetrics(),
    })

    if (details.reason === 'clean-exit' || getIsQuitting() || diagnosticWebContents.isDestroyed()) {
      return
    }

    const now = Date.now()
    if (now - lastRendererRecoveryAt < 60_000) {
      runtimeDiagnostics.record('renderer_recovery_skipped', { reason: 'cooldown' })
      return
    }
    lastRendererRecoveryAt = now

    setTimeout(() => {
      if (getIsQuitting() || diagnosticWebContents.isDestroyed()) return
      try {
        diagnosticWebContents.once('did-finish-load', () => {
          runtimeDiagnostics.record('renderer_recovery_loaded')
        })
        runtimeDiagnostics.record('renderer_recovery_reload_requested', {
          reason: details.reason,
        })
        diagnosticWebContents.reload()
      } catch (error) {
        runtimeDiagnostics.record('renderer_recovery_reload_failed', describeDiagnosticError(error))
      }
    }, 500)
  })

  // 窗口就绪后，按保存的状态决定是否最大化。必须先显示窗口，再放行慢启动任务。
  mainWindow.once('ready-to-show', () => {
    clearTimeout(startupFallbackTimer)
    runtimeDiagnostics.record('main_window_ready_to_show', {
      sinceBootstrapMs: bootstrapStartedAt > 0 ? Date.now() - bootstrapStartedAt : undefined,
    })
    if (isLaunchSmoke) {
      console.log('[启动 smoke] 主窗口 renderer 已就绪')
      continueStartup('ready-to-show')
      app.exit(0)
      return
    }
    if (savedState?.isMaximized ?? true) {
      mainWindow?.maximize()
    }
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show()
    }
    mainWindow?.show()
    continueStartup('ready-to-show')
  })

  mainWindow.webContents.once('did-fail-load', (
    _event,
    errorCode,
    errorDescription,
    _validatedURL,
    isMainFrame,
  ) => {
    if (!isMainFrame) return
    clearTimeout(startupFallbackTimer)
    runtimeDiagnostics.record('main_window_load_failed', { errorCode, errorDescription })
    continueStartup('load-failed')
  })

  // Load the renderer
  const isDev = !app.isPackaged
  if (isDev) {
    void mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools()
  } else {
    void mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'))
  }

  // 持久化窗口大小和位置（防抖 500ms，避免频繁写入）
  let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleWindowStateSave = (): void => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
    windowStateSaveTimer = setTimeout(() => {
      windowStateSaveTimer = null
      saveMainWindowState()
    }, 500)
  }
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('move', scheduleWindowStateSave)

  // 拦截页面内导航，外部链接用系统浏览器打开，防止 Electron 窗口被覆盖
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 允许开发模式下的 Vite HMR 热重载
    if (isDev && isDevServerNavigation(url)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
  })

  // 拦截 window.open / target="_blank" 链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // macOS: 点击关闭按钮时隐藏窗口+应用，而不是退出
  // 同时隐藏应用（类似 Cmd+H），确保点击 Dock 图标时 macOS 能正确触发 activate 事件
  if (process.platform === 'darwin') {
    mainWindow.on('close', (event) => {
      if (!getIsQuitting()) {
        // 隐藏前先刷新挂起的窗口状态保存
        if (windowStateSaveTimer) {
          clearTimeout(windowStateSaveTimer)
          windowStateSaveTimer = null
        }
        saveMainWindowState()
        event.preventDefault()
        if (mainWindow && !mainWindow.isDestroyed()) {
          hideMacMainWindowAfterClose(mainWindow, app)
        }
      }
    })
  }

  // Windows: 点击关闭按钮时隐藏窗口到托盘，而不是退出
  if (process.platform === 'win32') {
    mainWindow.on('close', (event) => {
      if (!getIsQuitting() && getTray()) {
        // 隐藏前先刷新挂起的窗口状态保存
        if (windowStateSaveTimer) {
          clearTimeout(windowStateSaveTimer)
          windowStateSaveTimer = null
        }
        saveMainWindowState()
        event.preventDefault()
        mainWindow?.hide()
      }
    })
  }

  mainWindow.on('closed', () => {
    clearTimeout(startupFallbackTimer)
    continueStartup('closed')
    void disposeBrowserModule()
    void disposeTerminalModule()
    mainWindow = null
    mainWindowReadyPromise = null
  })

  mainWindowReadyPromise = windowReadyPromise
  return windowReadyPromise
}

function createBrowserIpcRegistration(): NonNullable<Parameters<typeof registerIpcHandlers>[0]>['browser'] {
  let service
  try {
    service = getBrowserSessionService()
  } catch {
    service = configureBrowserModule({
      getMainWindow,
      sendState: sendBrowserState,
      sendFocusEscapeRequest: sendBrowserFocusEscapeRequest,
    })
  }
  return {
    service,
    guard: {
      assertSender: (senderId) => {
        const window = getMainWindow()
        if (!window || window.isDestroyed() || window.webContents.id !== senderId) {
          throw new Error('仅主窗口可以操作内置浏览器。')
        }
      },
    },
  }
}

function sendBrowserState(state: BrowserStateChange): void {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return
  const send = (): void => {
    if (!window.isDestroyed()) window.webContents.send(BROWSER_IPC_CHANNELS.STATE_CHANGED, state)
  }
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send)
  else send()
}

function sendBrowserFocusEscapeRequest(request: BrowserFocusEscapeRequest): void {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || window.webContents.isLoading()) return
  window.webContents.send(BROWSER_IPC_CHANNELS.FOCUS_ESCAPE_REQUESTED, request)
}

async function runTerminalRuntimeSmoke(): Promise<void> {
  const terminalId = `terminal-smoke-${Date.now()}`
  const marker = `DOMI_TERMINAL_SMOKE_${Date.now()}`
  let disposeOutput: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const output = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('终端 smoke 输出超时')), 15_000)
      disposeOutput = terminalRuntimeClient.onOutput((event) => {
        if (event.terminalId === terminalId && event.data.includes(marker)) resolve()
      })
    })
    await terminalRuntimeClient.create({
      terminalId,
      cwd: dirname(process.execPath),
      profile: process.platform === 'win32' ? 'git-bash' : 'bash',
      cols: 80,
      rows: 24,
      mode: 'agent-command',
      command: `printf '${marker}\\n'`,
    })
    await output
    console.log(`[终端 smoke] ${marker}`)
  } finally {
    if (timeout) clearTimeout(timeout)
    disposeOutput?.()
    terminalRuntimeClient.kill(terminalId)
    terminalRuntimeClient.stop()
  }
}

function createTerminalIpcRegistration(): NonNullable<Parameters<typeof registerIpcHandlers>[0]>['terminal'] {
  let service
  try {
    service = getTerminalSessionService()
  } catch {
    service = configureTerminalModule({ getMainWindow })
  }
  return {
    service,
    guard: {
      assertSender: (senderId) => {
        const window = getMainWindow()
        if (!window || window.isDestroyed() || window.webContents.id !== senderId) {
          throw new Error('仅主窗口可以操作内置终端。')
        }
      },
    },
  }
}

function sendToMainWindow(channel: string, data?: unknown): void {
  showAndFocusMainWindow()

  const win = mainWindow
  if (!win || win.isDestroyed()) return

  const send = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

app.whenReady().then(bootstrap).catch(handleBootstrapFailure)

/**
 * 启动主流程。所有非关键步骤用 safeRun / safeAwait 隔离，
 * 单点失败不应阻止窗口和托盘的创建（用户至少要能看到界面）。
 */
async function bootstrap(): Promise<void> {
  bootstrapStartedAt = Date.now()
  if (isTerminalSmoke) {
    await runTerminalRuntimeSmoke()
    app.exit(0)
    return
  }
  runtimeDiagnostics.recordStart()
  runtimeDiagnostics.record('bootstrap_started')

  await runAppStartupSequence({
    prepareWindow: prepareMainWindowStartup,
    createWindow,
    initializeServices: initializePostWindowServices,
  })
}

/** 只保留窗口显示所需的轻量初始化，避免磁盘扫描和外部命令挡在首屏之前。 */
async function prepareMainWindowStartup(): Promise<void> {
  setDomiCompatibilityVersion(app.getVersion())

  // 协议只接受主进程签发的 opaque token，不解析 renderer 提供的绝对路径。
  protocol.handle('domi-file', handleDomiFileRequest)

  Menu.setApplicationMenu(createApplicationMenu())
  registerIpcHandlers({
    browser: createBrowserIpcRegistration(),
    terminal: createTerminalIpcRegistration(),
  })

  if (!appActivationHandlerRegistered) {
    appActivationHandlerRegistered = true
    app.on('activate', () => {
      if (shouldSuppressVoiceDictationActivate()) return

      if (!mainWindow || mainWindow.isDestroyed()) {
        void createWindow()
      } else {
        showAndFocusMainWindow()
      }
    })
  }
}

/** 窗口已可见后再执行可能受磁盘、Git/WSL 或网络状态影响的初始化。 */
async function initializePostWindowServices(): Promise<void> {
  if (isLaunchSmoke || getIsQuitting() || !mainWindow || mainWindow.isDestroyed()) return

  // 给系统合成器一个事件循环机会，确保窗口先真正呈现，再开始同步兼容检查。
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  if (process.platform === 'darwin' && app.dock) {
    await app.dock.show()
    const dockIconPath = getDockIconPath()
    if (existsSync(dockIconPath)) {
      app.dock.setIcon(dockIconPath)
    }
  }

  createTray({
    showMainWindow: showAndFocusMainWindow,
    openAgentSession: (sessionId, title) => {
      sendToMainWindow(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, { sessionId, title })
    },
    createChatSession: () => {
      sendToMainWindow(TRAY_IPC_CHANNELS.CREATE_SESSION, { mode: 'chat' })
    },
    createAgentSession: () => {
      sendToMainWindow(TRAY_IPC_CHANNELS.CREATE_SESSION, { mode: 'agent' })
    },
  })

  // Shell 环境必须先于依赖 PATH 的后台服务完成；但不再阻塞窗口创建。
  await safeAwait('initializeRuntime', () => initializeRuntime())
  safeRun('seedDefaultSkills', seedDefaultSkills)
  safeRun('upgradeDefaultSkillsInWorkspaces', upgradeDefaultSkillsInWorkspaces)
  safeRun('markRunningDelegationsAsInterrupted', markRunningDelegationsAsInterrupted)
  await safeAwait('reconcileSessionCheckouts', reconcileProductionSessionCheckouts)

  await safeAwait('startWorkActivityNotificationService', () => startWorkActivityNotificationService({
    getMainWindow,
    showAndFocusMainWindow,
  }))

  if (mainWindow) {
    safeRun('startWorkspaceWatcher', () => startWorkspaceWatcher(mainWindow!))
  }
  safeRun('startChatToolsWatcher', startChatToolsWatcher)

  safeRun('createQuickTaskWindow', createQuickTaskWindow)
  if (getSettings().voiceDictation?.enabled === true) {
    safeRun('createVoiceDictationWindow', createVoiceDictationWindow)
  }

  safeRun('initAgentIslandService', () => {
    initAgentIslandService({
      showAndFocusMainWindow,
      openAgentSession: (sessionId, title) => {
        sendToMainWindow(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, { sessionId, title })
      },
      openPlanning: showPlanningWindow,
      enabled: () => getSettings().agentIsland?.enabled !== false,
    })
  })
  safeRun('startAgentIslandSurface', startAgentIslandSurface)
  safeRun('syncFeishuSyncSleepBlocker', () => syncFeishuSyncSleepBlocker(getSettings()))

  safeRun('registerGlobalShortcut:quick-task', () =>
    registerGlobalShortcut('quick-task', toggleQuickTaskWindow),
  )
  safeRun('registerGlobalShortcut:show-main-window', () =>
    registerGlobalShortcut('show-main-window', showAndFocusMainWindow),
  )
  safeRun('registerGlobalShortcut:voice-dictation', () =>
    registerGlobalShortcut('voice-dictation', () => {
      toggleVoiceDictationWindow({ targetIsDomi: mainWindow?.isFocused() === true })
    }),
  )

  await safeAwait('startAllBridges', () => startAllBridges())
  safeRun('startBridgeSelfHealing', startBridgeSelfHealing)
  safeRun('startScheduler', startScheduler)
  safeRun('startPlanningReminderScheduler', startPlanningReminderScheduler)

  runtimeDiagnostics.record('post_window_startup_completed', {
    sinceBootstrapMs: bootstrapStartedAt > 0 ? Date.now() - bootstrapStartedAt : undefined,
  })
}

/** 同步启动钩子隔离：单点失败仅记录日志，不阻断启动链，并记录实际耗时。 */
function safeRun(name: string, fn: () => void): void {
  const startedAt = Date.now()
  let status: 'completed' | 'failed' = 'completed'
  try {
    fn()
  } catch (err) {
    status = 'failed'
    console.error(`[启动] ${name} 失败（已隔离）:`, err)
  } finally {
    runtimeDiagnostics.record('startup_step_finished', {
      name,
      status,
      durationMs: Date.now() - startedAt,
    })
  }
}

/** 异步启动钩子隔离：同 safeRun，但适用于返回 Promise 的钩子。 */
async function safeAwait(name: string, fn: () => Promise<unknown>): Promise<void> {
  const startedAt = Date.now()
  let status: 'completed' | 'failed' = 'completed'
  try {
    await fn()
  } catch (err) {
    status = 'failed'
    console.error(`[启动] ${name} 失败（已隔离）:`, err)
  } finally {
    runtimeDiagnostics.record('startup_step_finished', {
      name,
      status,
      durationMs: Date.now() - startedAt,
    })
  }
}

/**
 * whenReady 顶层兜底：理论上 bootstrap 内的 safeRun/safeAwait 已经把所有可预期
 * 异常隔离掉了，能走到这里说明出了 bootstrap 本身控制流的意外（极端情况），
 * 此时仍尝试创建一个降级窗口，让用户至少能看到界面、复制日志、提交反馈。
 */
function handleBootstrapFailure(err: unknown): void {
  console.error('[启动] bootstrap 致命错误，进入降级模式:', err)

  try {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    dialog.showErrorBox(
      'Domi 启动遇到错误',
      `部分功能可能不可用：\n\n${message}\n\n` +
        `日志位置：${app.getPath('logs')}\n\n` +
        `常见原因与排查：\n` +
        `1. 旧版 Domi 进程未退出（请结束 Domi 进程后重试）\n` +
        `2. ~/.domi/ 配置损坏（重命名 ~/.domi 后重启）\n` +
        `3. 系统 Keychain 无法解密保存的凭证（删除 ~/.domi/feishu.json 等后重新登录）\n\n` +
        `如需协助请到 GitHub Issues 反馈。`,
    )
  } catch {
    /* dialog 也失败，无能为力 */
  }

  try {
    registerIpcHandlers({
      browser: createBrowserIpcRegistration(),
      terminal: createTerminalIpcRegistration(),
    })
    void createWindow()
  } catch (fallbackErr) {
    console.error('[启动] 降级窗口创建也失败:', fallbackErr)
  }
}

app.on('window-all-closed', () => {
  // 非 macOS：关闭所有窗口时退出应用
  // macOS：保持应用运行（可通过 tray 或 Dock 重新打开）
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  runtimeDiagnostics.recordCleanShutdown()
  void disposeBrowserModule()
  void disposeTerminalModule()

  // 标记正在退出，让 close 事件不再阻止关闭
  setQuitting()

  // 中止所有活跃的 Agent 和 Chat 子进程
  stopAllAgents()
  stopAllGenerations()
  // 最后释放 Pi runtime 与 SDK 资源。
  cleanupAgentRuntimeResources()
  // 停止工作区文件监听
  stopWorkspaceWatcher()
  // 停止 Chat 工具配置文件监听
  stopChatToolsWatcher()
  // 停止所有 Bridge
  stopBridgeSelfHealing()
  stopAllBridges()
  // 停止定时任务调度器
  stopScheduler()
  stopPlanningReminderScheduler()
  disposeWorkActivityNotificationService()
  // 释放飞书同步防休眠
  stopFeishuSyncSleepBlocker()
  // 注销全局快捷键
  unregisterAllGlobalShortcuts()
  // 销毁辅助窗口
  destroyQuickTaskWindow()
  destroyPlanningWindow()
  destroyVoiceDictationWindow()
  // 销毁灵动岛服务与窗口（先关闭 NSPanel helper，避免开发热重载遗留原生面板）
  disposeMacAgentIslandNativeHost()
  disposeAgentIslandService()
  destroyAgentIslandWindow()
  // 关闭 Pi MCP 桥接连接（释放 stdio 子进程）
  disposePiMcpConnections().catch(() => {})
  // Clean up system tray before quitting
  destroyTray()
})
