import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { SpawnOptions } from 'node:child_process'
import type { FolderOpenerRuntime, FolderOpenerRunner, FolderOpenerLaunch } from './project-folder-openers.ts'

type ProjectFolderOpeners = typeof import('./project-folder-openers')

let service: ProjectFolderOpeners

beforeAll(async () => {
  // 模拟 electron app/shell；测试内的启动执行器由 fakeRunner 注入。
  mock.module('electron', () => ({
    app: { getFileIcon: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,icon' }) },
    shell: { openPath: async () => '' },
  }))
  service = await import('./project-folder-openers')
})

interface ProbeOverrides {
  /** 存在的 macOS .app 名称（探测路径固定为 /Applications/<name>.app） */
  apps?: string[]
  /** CLI 命令 → 解析出的完整路径 */
  clis?: Record<string, string>
  /** 额外判定为存在的物理路径（Windows exe 定位用） */
  paths?: string[]
  /** 图标读取结果：按目标路径返回 data URL；未命中返回 null */
  iconByPath?: Record<string, string>
  /** 所有图标读取都失败 */
  iconFails?: boolean
}

/** 构造假探测环境 */
function fakeRuntime(platform: string, overrides: ProbeOverrides = {}): FolderOpenerRuntime {
  const { apps = [], clis = {}, paths = [], iconByPath = {}, iconFails = false } = overrides
  return {
    platform,
    appBundlePath: (name) => (apps.includes(name) ? `/Applications/${name}.app` : null),
    cliPath: (command) => clis[command] ?? null,
    pathExists: (target) => paths.includes(target),
    getFileIcon: async (target) => (iconFails ? null : iconByPath[target] ?? null),
  }
}

interface Recorder {
  spawns: { command: string; args: string[]; options?: { cwd?: SpawnOptions['cwd'] } }[]
  openedPaths: string[]
}

function fakeRunner(): { runner: FolderOpenerRunner; recorder: Recorder } {
  const recorder: Recorder = { spawns: [], openedPaths: [] }
  return {
    recorder,
    runner: {
      spawnDetached: (command, args, options) => {
        recorder.spawns.push({ command, args, options: { cwd: options?.cwd } })
      },
      openPath: async (target) => {
        recorder.openedPaths.push(target)
        return ''
      },
    },
  }
}

describe('listProjectFolderOpeners', () => {
  test('Given macOS 装有 VS Code/Zed/iTerm2 When 探测打开方式 Then 依序列出访达、编辑器与终端', async () => {
    const openers = await service.listProjectFolderOpeners(fakeRuntime('darwin', {
      apps: ['Visual Studio Code', 'Zed', 'iTerm', 'Terminal'],
    }))

    expect(openers.map((opener) => [opener.id, opener.kind])).toEqual([
      [service.FILE_MANAGER_OPENER_ID, 'file-manager'],
      ['vscode', 'editor'],
      ['zed', 'editor'],
      ['terminal', 'terminal'],
      ['iterm2', 'terminal'],
    ])
    expect(openers.find((opener) => opener.id === service.FILE_MANAGER_OPENER_ID)?.label).toBe('访达')
  })

  test('Given 未安装的编辑器与终端 When 探测 Then 它们不出现在列表中', async () => {
    const openers = await service.listProjectFolderOpeners(fakeRuntime('darwin', { apps: ['Visual Studio Code', 'Terminal'] }))

    expect(openers.map((opener) => opener.id)).toEqual([service.FILE_MANAGER_OPENER_ID, 'vscode', 'terminal'])
  })

  test('Given Windows 可解析 code 与 wt When 探测 Then 列出资源管理器、编辑器与终端', async () => {
    const openers = await service.listProjectFolderOpeners(fakeRuntime('win32', {
      clis: {
        code: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
        wt: 'C:\\Program Files\\WindowsApps\\wt.exe',
        powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      },
    }))

    expect(openers.map((opener) => opener.id)).toEqual([
      service.FILE_MANAGER_OPENER_ID,
      'vscode',
      'windows-terminal',
      'powershell',
    ])
    expect(openers.find((opener) => opener.id === service.FILE_MANAGER_OPENER_ID)?.label).toBe('资源管理器')
  })

  test('Given Linux 装有 xdg-open/code/gnome-terminal When 探测 Then 列出文件管理器与系统终端', async () => {
    const openers = await service.listProjectFolderOpeners(fakeRuntime('linux', {
      clis: {
        'xdg-open': '/usr/bin/xdg-open',
        code: '/usr/bin/code',
        'gnome-terminal': '/usr/bin/gnome-terminal',
      },
    }))

    expect(openers.map((opener) => opener.id)).toEqual([service.FILE_MANAGER_OPENER_ID, 'vscode', 'terminal'])
  })

  test('Given 平台不支持的打开方式 When 探测 Then 不会泄露到其他平台列表', async () => {
    expect((await service.listProjectFolderOpeners(fakeRuntime('win32'))).map((o) => o.id))
      .toEqual([service.FILE_MANAGER_OPENER_ID])
    expect(await service.listProjectFolderOpeners(fakeRuntime('linux'))).toEqual([])
  })
})

describe('listProjectFolderOpeners 图标', () => {
  test('Given macOS 应用实体存在且可读图标 When 探测 Then 下发真实应用图标 data URL', async () => {
    const openers = await service.listProjectFolderOpeners(fakeRuntime('darwin', {
      apps: ['Visual Studio Code', 'Terminal'],
      iconByPath: {
        '/Applications/Visual Studio Code.app': 'data:image/png;base64,vscode-icon',
        '/Applications/Terminal.app': 'data:image/png;base64,terminal-icon',
      },
    }))

    expect(openers.find((opener) => opener.id === 'vscode')?.icon).toBe('data:image/png;base64,vscode-icon')
    expect(openers.find((opener) => opener.id === 'terminal')?.icon).toBe('data:image/png;base64,terminal-icon')
    // 访达图标目标（/System/Library/CoreServices/Finder.app）在假环境不可达 → 无 icon
    expect(openers.find((opener) => opener.id === service.FILE_MANAGER_OPENER_ID)?.icon).toBeUndefined()
  })

  test('Given Windows code 垫片与同级 Code.exe 存在 When 解析图标 Then 指向实际 exe', async () => {
    const shim = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    const openers = await service.listProjectFolderOpeners(fakeRuntime('win32', {
      clis: { code: shim },
      paths: ['C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'],
      iconByPath: { 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe': 'data:image/png;base64,code-exe' },
    }))

    expect(openers.find((opener) => opener.id === 'vscode')?.icon).toBe('data:image/png;base64,code-exe')
  })

  test('Given 找不到同级 exe When 解析图标 Then 回退垫片路径本身', async () => {
    const shim = 'D:\\tools\\cursor\\bin\\cursor.cmd'
    const openers = await service.listProjectFolderOpeners(fakeRuntime('win32', {
      clis: { cursor: shim },
      iconByPath: { [shim]: 'data:image/png;base64,generic-cmd' },
    }))

    expect(openers.find((opener) => opener.id === 'cursor')?.icon).toBe('data:image/png;base64,generic-cmd')
  })

  test('Given 图标读取失败或无目标 When 探测 Then 不带 icon 字段', async () => {
    const failed = await service.listProjectFolderOpeners(fakeRuntime('darwin', {
      apps: ['Visual Studio Code'],
      iconFails: true,
    }))
    expect(failed.find((opener) => opener.id === 'vscode')?.icon).toBeUndefined()

    // Linux 无图标目标，永远不带 icon
    const linux = await service.listProjectFolderOpeners(fakeRuntime('linux', {
      clis: { 'xdg-open': '/usr/bin/xdg-open' },
    }))
    expect(linux[0]?.icon).toBeUndefined()
  })
})

describe('openProjectFolderWith', () => {
  test('Given macOS 已装 VS Code When 用 vscode 打开 Then 经 open -a 后台启动并指向项目目录', async () => {
    const { runner, recorder } = fakeRunner()
    await service.openProjectFolderWith('vscode', '/Users/dev/Projects/demo', {
      runtime: fakeRuntime('darwin', { apps: ['Visual Studio Code'] }),
      runner,
    })

    expect(recorder.spawns).toEqual([
      { command: 'open', args: ['-a', 'Visual Studio Code', '/Users/dev/Projects/demo'], options: {} },
    ])
  })

  test('Given 系统文件管理器 When 用 file-manager 打开 Then 走 shell.openPath 而不是 spawn', async () => {
    const { runner, recorder } = fakeRunner()
    await service.openProjectFolderWith(service.FILE_MANAGER_OPENER_ID, '/Users/dev/Projects/demo', {
      runtime: fakeRuntime('darwin', { apps: [] }),
      runner,
    })

    expect(recorder.openedPaths).toEqual(['/Users/dev/Projects/demo'])
    expect(recorder.spawns).toEqual([])
  })

  test('Given Windows 已装 Windows Terminal When 用 windows-terminal 打开 Then 经 cmd start wt -d 启动', async () => {
    const { runner, recorder } = fakeRunner()
    await service.openProjectFolderWith('windows-terminal', 'C:\\dev\\my project', {
      runtime: fakeRuntime('win32', { clis: { wt: 'C:\\Program Files\\WindowsApps\\wt.exe' } }),
      runner,
    })

    expect(recorder.spawns).toEqual([
      { command: 'cmd.exe', args: ['/d', '/c', 'start', '', 'wt', '-d', 'C:\\dev\\my project'], options: {} },
    ])
  })

  test('Given Windows 用 PowerShell 打开 Then 以项目目录为 cwd 启动交互式会话', async () => {
    const { runner, recorder } = fakeRunner()
    await service.openProjectFolderWith('powershell', 'C:\\dev\\demo', {
      runtime: fakeRuntime('win32', { clis: { powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } }),
      runner,
    })

    expect(recorder.spawns).toEqual([
      { command: 'powershell.exe', args: ['-NoExit'], options: { cwd: 'C:\\dev\\demo' } },
    ])
  })

  test('Given Linux 只装有 x-terminal-emulator When 用 terminal 打开 Then 以 cwd 方式启动', async () => {
    const { runner, recorder } = fakeRunner()
    await service.openProjectFolderWith('terminal', '/home/dev/demo', {
      runtime: fakeRuntime('linux', { clis: { 'x-terminal-emulator': '/usr/bin/x-terminal-emulator' } }),
      runner,
    })

    expect(recorder.spawns).toEqual([
      { command: 'x-terminal-emulator', args: [], options: { cwd: '/home/dev/demo' } },
    ])
  })

  test('Given 未知或跨平台的 openerId When 打开 Then 抛出错误且不执行任何命令', async () => {
    const { runner, recorder } = fakeRunner()
    await expect(service.openProjectFolderWith('notepad', '/tmp/x', {
      runtime: fakeRuntime('darwin', { apps: [] }),
      runner,
    })).rejects.toThrow('未知的打开方式')

    // macOS 注册表里有 iterm2，但 Windows 平台不允许使用
    await expect(service.openProjectFolderWith('iterm2', 'C:\\dev', {
      runtime: fakeRuntime('win32'),
      runner,
    })).rejects.toThrow('未知的打开方式')

    expect(recorder.spawns).toEqual([])
    expect(recorder.openedPaths).toEqual([])
  })

  test('Given 应用在列表生成后被卸载 When 打开 Then 明确报不可用', async () => {
    const { runner } = fakeRunner()
    await expect(service.openProjectFolderWith('zed', '/tmp/x', {
      runtime: fakeRuntime('darwin', { apps: [] }),
      runner,
    })).rejects.toThrow('Zed 未安装或不可用')
  })
})

/** 类型层守卫：launch 描述只允许 openPath / spawn 两种形态，防止注册表漂移 */
test('FolderOpenerLaunch 描述保持闭合', () => {
  const launch: FolderOpenerLaunch = { type: 'openPath' }
  expect(launch.type).toBe('openPath')
})
