import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  resolveDomiProductIdentity,
  resolveFallbackAppDataPath,
} from './product-identity.ts'

describe('Domi Product Identity', () => {
  test('Given 正式版 When 解析产品身份 Then 使用独立的 Domi 名称、标识和数据目录', () => {
    const identity = resolveDomiProductIdentity({
      isPackaged: true,
      appDataPath: join('C:', 'Users', 'owner', 'AppData', 'Roaming'),
      environment: {},
    })

    expect(identity).toEqual({
      applicationName: 'Domi',
      applicationId: 'local.domi.workbench',
      configDirName: '.domi',
      userDataPath: join('C:', 'Users', 'owner', 'AppData', 'Roaming', 'Domi'),
    })
  })

  test('Given 开发版 When 解析产品身份 Then 使用独立的开发数据目录', () => {
    const identity = resolveDomiProductIdentity({
      isPackaged: false,
      appDataPath: join('C:', 'Users', 'owner', 'AppData', 'Roaming'),
      environment: {},
    })

    expect(identity.configDirName).toBe('.domi-dev')
    expect(identity.userDataPath).toBe(join('C:', 'Users', 'owner', 'AppData', 'Roaming', 'Domi Dev'))
  })

  test('Given 正式版设置兼容环境变量 When 解析产品身份 Then 切换到 Domi 开发目录', () => {
    const identity = resolveDomiProductIdentity({
      isPackaged: true,
      appDataPath: join('C:', 'Users', 'owner', 'AppData', 'Roaming'),
      environment: { DOMI_DEV: '1' },
    })

    expect(identity.configDirName).toBe('.domi-dev')
    expect(identity.userDataPath).toBe(join('C:', 'Users', 'owner', 'AppData', 'Roaming', 'Domi Dev'))
  })
})

describe('resolveFallbackAppDataPath', () => {
  test('Given Windows 环境 When appData 获取失败 Then 回退到 %APPDATA%', () => {
    expect(
      resolveFallbackAppDataPath(
        { APPDATA: join('C:', 'Users', 'owner', 'AppData', 'Roaming') },
        'win32',
        join('C:', 'Users', 'owner'),
      ),
    ).toBe(join('C:', 'Users', 'owner', 'AppData', 'Roaming'))
  })

  test('Given macOS 环境且无 APPDATA When appData 获取失败 Then 回退到 ~/Library/Application Support', () => {
    expect(
      resolveFallbackAppDataPath({}, 'darwin', '/Users/owner'),
    ).toBe(join('/Users/owner', 'Library', 'Application Support'))
  })

  test('Given Linux 环境且配置 XDG_CONFIG_HOME When appData 获取失败 Then 回退到 XDG_CONFIG_HOME', () => {
    expect(
      resolveFallbackAppDataPath({ XDG_CONFIG_HOME: join('/home', 'owner', '.config') }, 'linux', '/home/owner'),
    ).toBe(join('/home', 'owner', '.config'))
  })

  test('Given Linux 环境且未配置 XDG_CONFIG_HOME When appData 获取失败 Then 回退到 ~/.config', () => {
    expect(resolveFallbackAppDataPath({}, 'linux', '/home/owner')).toBe(join('/home', 'owner', '.config'))
  })

  test('Given APPDATA 已设置 When 平台为 darwin Then APPDATA 优先（保持与 Electron 一致）', () => {
    expect(
      resolveFallbackAppDataPath(
        { APPDATA: join('C:', 'Users', 'owner', 'AppData', 'Roaming') },
        'darwin',
        '/Users/owner',
      ),
    ).toBe(join('C:', 'Users', 'owner', 'AppData', 'Roaming'))
  })
})
