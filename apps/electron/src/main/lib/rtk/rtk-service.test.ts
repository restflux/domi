import { describe, expect, test } from 'bun:test'
import { buildRtkEnvironment, createRtkService, RTK_SUPPORTED_VERSION } from './rtk-service.ts'

describe('RTK 宿主服务', () => {
  test('Given 明确版本与 pipe 能力 When 检测和过滤 Then 使用固定 argv 和 stdin', async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = []
    const service = createRtkService({
      findExecutable: async () => '/trusted/rtk',
      run: async (_exe, args, input) => {
        calls.push({ args, input })
        if (args[0] === '--version') return `rtk ${RTK_SUPPORTED_VERSION}`
        return input ?? ''
      },
    })
    expect(service.getStatus().availability).toBe('not-checked')
    expect((await service.recheck()).availability).toBe('available')
    expect(await service.filter('git-status', 'raw output')).toBe('raw output')
    expect(calls.at(-1)).toEqual({ args: ['pipe', '--filter', 'git-status'], input: 'raw output' })
    service.record(1000, 200)
    expect(service.getStatus()).toMatchObject({ optimizedCalls: 1, originalBytes: 1000, returnedBytes: 200 })
  })
  test('Given 缺失、不兼容、能力异常或进程失败 When 检测 Then 不允许过滤', async () => {
    for (const mode of ['missing', 'version', 'probe', 'error']) {
      let filters = 0
      const service = createRtkService({
        findExecutable: async () => mode === 'missing' ? undefined : '/trusted/rtk',
        run: async (_exe, args) => {
          if (mode === 'error') throw new Error('spawn failed')
          if (args[0] === '--version') return `rtk ${mode === 'version' ? '99.0.0' : RTK_SUPPORTED_VERSION}`
          if (args.includes('--filter')) filters++
          return 'wrong probe'
        },
      })
      await service.recheck()
      expect(await service.filter('git-status', 'raw')).toBeUndefined()
      expect(filters).toBe(0)
    }
  })
  test('Given 上次检测可用 When 重新检测失败 Then 不复用失效的可执行文件', async () => {
    let installed = true
    const service = createRtkService({
      findExecutable: async () => installed ? '/trusted/rtk' : undefined,
      run: async (_exe, args, input) => args[0] === '--version' ? `rtk ${RTK_SUPPORTED_VERSION}` : input ?? '',
    })
    await service.recheck()
    installed = false
    expect((await service.recheck()).availability).toBe('not-found')
    expect(await service.filter('git-log', 'raw')).toBeUndefined()
  })
  test('Given 自动检测中撤销执行权限或取消 When await 恢复 Then 不启动后续阶段', async () => {
    for (const stage of ['find', 'version', 'probe']) {
      for (const cancel of [false, true]) {
        let allowed = true
        const controller = new AbortController()
        const calls: string[] = []
        const revoke = () => { if (cancel) controller.abort(); else allowed = false }
        const service = createRtkService({
          findExecutable: async () => { if (stage === 'find') revoke(); return '/trusted/rtk' },
          run: async (_exe, args, input) => {
            calls.push(args.join(' '))
            if (stage === 'version' && args[0] === '--version') revoke()
            if (stage === 'probe' && args.includes('--passthrough')) revoke()
            return args[0] === '--version' ? `rtk ${RTK_SUPPORTED_VERSION}` : input ?? ''
          },
        })
        expect(await service.filter('git-log', 'raw', controller.signal, () => allowed)).toBeUndefined()
        expect(calls.some(call => call.includes('--filter'))).toBe(false)
        expect(calls).toHaveLength(stage === 'find' ? 0 : stage === 'version' ? 1 : 2)
        expect(service.getStatus().availability).toBe('not-checked')
      }
    }
  })
  test('Given 当前平台未内置 RTK When 检查 Then 不误导用户重新安装且不启动程序', async () => {
    const service = createRtkService({
      isSupported: () => false,
      findExecutable: async () => { throw new Error('不应查找') },
      run: async () => { throw new Error('不应启动') },
    })
    expect((await service.inspect()).availability).toBe('unsupported')
    expect(await service.filter('git-log', 'raw')).toBeUndefined()
  })
  test('Given 首次打开设置 When 并发读取状态 Then 自动检查一次并保留统计', async () => {
    let versions = 0
    const service = createRtkService({
      findExecutable: async () => '/bundled/rtk',
      run: async (_exe, args, input) => {
        if (args[0] === '--version') { versions++; return `rtk ${RTK_SUPPORTED_VERSION}` }
        return input ?? ''
      },
    })
    const statuses = await Promise.all([service.inspect(), service.inspect()])
    expect(statuses.every(status => status.availability === 'available')).toBe(true)
    service.record(1000, 200)
    expect(await service.inspect()).toMatchObject({ optimizedCalls: 1, originalBytes: 1000, returnedBytes: 200 })
    expect(versions).toBe(1)
  })
  test('Given Provider 凭据和 RTK 用户配置环境 When 启动 filter Then 不继承敏感值并强制关闭遥测', () => {
    const env = buildRtkEnvironment('/private/rtk', {
      OPENAI_API_KEY: 'test-only', RTK_CONFIG: '/project/config', PATH: '/project/bin',
      RTK_TELEMETRY_DISABLED: '0', HOME: '/user', SystemRoot: 'C:\\Windows',
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.RTK_CONFIG).toBeUndefined()
    expect(env.PATH).toBeUndefined()
    expect(env.HOME).toBe('/private/rtk')
    expect(env.RTK_TELEMETRY_DISABLED).toBe('1')
    expect(env.SystemRoot).toBe('C:\\Windows')
  })
})
