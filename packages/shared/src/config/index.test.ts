import { describe, expect, test } from 'bun:test'
import {
  APP_ID,
  APP_NAME,
  CLI_EXECUTABLE_BASENAME,
  assertMigrationFileMode,
  CONFIG_DIR_NAME,
  DEV_CONFIG_DIR_NAME,
  INSTALLER_TEMP_DIR_NAME,
  PREVIEW_TEMP_DIR_NAME,
  getMigrationExportExtension,
  isMigrationFileMode,
  isSupportedMigrationImportFile,
} from './index.ts'

describe('Domi Product Identity', () => {
  test('Given Workbench 安装 When 读取共享产品身份 Then 与 Proma 使用不同标识和目录', () => {
    expect({
      name: APP_NAME,
      id: APP_ID,
      configDir: CONFIG_DIR_NAME,
      devConfigDir: DEV_CONFIG_DIR_NAME,
      cli: CLI_EXECUTABLE_BASENAME,
      previewTempDir: PREVIEW_TEMP_DIR_NAME,
      installerTempDir: INSTALLER_TEMP_DIR_NAME,
    }).toEqual({
      name: 'Domi',
      id: 'local.domi.workbench',
      configDir: '.domi',
      devConfigDir: '.domi-dev',
      cli: 'domi',
      previewTempDir: 'domi-preview',
      installerTempDir: 'domi-installers',
    })
  })
})

describe('Domi 迁移文件格式', () => {
  test('Given 个人备份导出 When 选择文件扩展名 Then 只生成 Domi 格式', () => {
    expect(getMigrationExportExtension('personal')).toBe('domi-backup')
  })

  test('Given 分享包导出 When 选择文件扩展名 Then 只生成 Domi 格式', () => {
    expect(getMigrationExportExtension('share')).toBe('domi-share')
  })

  test('Given 任意 IPC 输入 When 校验迁移导出模式 Then 只接受显式支持值', () => {
    expect(['personal', 'share', 'invalid', null].map(isMigrationFileMode)).toEqual([
      true,
      true,
      false,
      false,
    ])
    expect(() => assertMigrationFileMode('invalid')).toThrow('无效的迁移模式')
  })

  test('Given Domi 与旧 Proma 迁移文件 When 用户显式选择导入 Then 两类格式都可接受', () => {
    const accepted = [
      'daily.domi-backup',
      'team.domi-share',
      'legacy.proma-backup',
      'legacy.proma-share',
      'archive.zip',
    ].map(isSupportedMigrationImportFile)

    expect(accepted).toEqual([true, true, true, true, false])
  })
})
