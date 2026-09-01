/**
 * 跨进程共享的 Domi 产品配置。
 * `@domi/*` 是 monorepo package identity；旧产品数据只通过下方显式导入格式兼容。
 */

export const APP_NAME = 'Domi'
export const APP_ID = 'local.domi.workbench'
export const CONFIG_DIR_NAME = '.domi'
export const DEV_CONFIG_DIR_NAME = '.domi-dev'
export const CLI_EXECUTABLE_BASENAME = 'domi'
export const PREVIEW_TEMP_DIR_NAME = 'domi-preview'
export const INSTALLER_TEMP_DIR_NAME = 'domi-installers'

export type MigrationFileMode = 'personal' | 'share'

export function isMigrationFileMode(mode: unknown): mode is MigrationFileMode {
  return mode === 'personal' || mode === 'share'
}

export function assertMigrationFileMode(mode: unknown): asserts mode is MigrationFileMode {
  if (!isMigrationFileMode(mode)) {
    throw new Error(`无效的迁移模式: ${String(mode)}`)
  }
}

export const MIGRATION_IMPORT_EXTENSIONS = [
  'domi-backup',
  'domi-share',
  'proma-backup',
  'proma-share',
] as const

/** 返回 Domi 新导出文件使用的扩展名（不含前导点）。 */
export function getMigrationExportExtension(mode: MigrationFileMode): 'domi-backup' | 'domi-share' {
  return mode === 'personal' ? 'domi-backup' : 'domi-share'
}

/** 判断用户显式选择的文件是否属于当前或兼容的旧迁移格式。 */
export function isSupportedMigrationImportFile(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase()
  return MIGRATION_IMPORT_EXTENSIONS.some((extension) => normalizedPath.endsWith(`.${extension}`))
}
