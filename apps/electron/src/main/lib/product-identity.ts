import { join } from 'node:path'
import {
  APP_ID,
  APP_NAME,
  CONFIG_DIR_NAME,
  DEV_CONFIG_DIR_NAME,
} from '@domi/shared'

/**
 * 计算 appData 根目录的兜底值。
 *
 * Electron 的 app.getPath('appData') 在 Windows 上依赖 Known Folder API
 * （FOLDERID_RoamingAppData）解析，系统 Shell 未就绪或特殊启动上下文（服务、
 * 计划任务等）下可能失败并抛出 "Failed to get 'appData' path"，导致主进程
 * 在启动第一步就崩溃。此处按平台回退到环境变量与用户主目录。
 */
export function resolveFallbackAppDataPath(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string {
  // Windows：%APPDATA% 即 Roaming AppData
  if (environment.APPDATA) return environment.APPDATA
  // macOS：~/Library/Application Support
  if (platform === 'darwin') return join(homeDirectory, 'Library', 'Application Support')
  // Linux：$XDG_CONFIG_HOME 或 ~/.config（与 Chromium appData 语义一致）
  return environment.XDG_CONFIG_HOME || join(homeDirectory, '.config')
}

export interface DomiProductIdentityInput {
  isPackaged: boolean
  appDataPath: string
  environment: Readonly<Record<string, string | undefined>>
}

export interface DomiProductIdentity {
  applicationName: typeof APP_NAME
  applicationId: typeof APP_ID
  configDirName: typeof CONFIG_DIR_NAME | typeof DEV_CONFIG_DIR_NAME
  userDataPath: string
}

/** 解析 Domi 在当前运行模式下使用的独立应用身份。 */
export function resolveDomiProductIdentity(input: DomiProductIdentityInput): DomiProductIdentity {
  const isDevelopment = !input.isPackaged || input.environment.DOMI_DEV === '1'

  return {
    applicationName: APP_NAME,
    applicationId: APP_ID,
    configDirName: isDevelopment ? DEV_CONFIG_DIR_NAME : CONFIG_DIR_NAME,
    userDataPath: join(input.appDataPath, isDevelopment ? 'Domi Dev' : 'Domi'),
  }
}
