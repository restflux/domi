import { describe, expect, test } from 'bun:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PermissionResult } from '../agent-permission-service.ts'
import { discoverySession, discoveryTool, scriptDiscoveryRun } from './fixtures/pi-tool-discovery-session.ts'
import { codemodeCall, codemodeResults, nativeCodemodeSession } from './fixtures/pi-codemode-session.ts'

describe('Pi最终授权的公开执行边界', () => {
  test('Given 两个重叠Session共享Read定义与相同调用ID When 独立许可同时结束 Then 仅被允许的Session执行一次', async () => {
    let calls = 0
    const read = { ...discoveryTool('Read'), async execute() { calls++; return { content: [], details: {} } } }
    let firstReady = () => {}
    let secondReady = () => {}
    const firstStarted = new Promise<void>(resolve => { firstReady = resolve })
    const secondStarted = new Promise<void>(resolve => { secondReady = resolve })
    let allow = (_value: boolean) => {}
    let deny = (_value: boolean) => {}
    const a = await discoverySession({ tools: [read], authorize: () => new Promise<boolean>(resolve => { allow = resolve; firstReady() }) })
    const b = await discoverySession({ tools: [read], authorize: () => new Promise<boolean>(resolve => { deny = resolve; secondReady() }) })
    try {
      scriptDiscoveryRun(a.session, [[{ name: 'Read', arguments: {} }]])
      scriptDiscoveryRun(b.session, [[{ name: 'Read', arguments: {} }]])
      const runningA = a.session.prompt('A')
      const runningB = b.session.prompt('B')
      await Promise.all([firstStarted, secondStarted])
      allow(true); deny(false)
      await Promise.all([runningA, runningB])
      expect(calls).toBe(1)
      expect(a.authorized).toHaveLength(1)
      expect(b.authorized).toHaveLength(1)
    } finally { a.session.dispose(); b.session.dispose() }
  })

  test('Given 工具等待许可 When Session被dispose且晚到allow Then 本轮零执行且等待状态释放', async () => {
    let calls = 0
    let ready = () => {}
    const started = new Promise<void>(resolve => { ready = resolve })
    let release = (_value: boolean) => {}
    const read = { ...discoveryTool('Read'), async execute() { calls++; return { content: [], details: {} } } }
    const state = await discoverySession({ tools: [read], authorize: () => new Promise<boolean>(resolve => { release = resolve; ready() }) })
    try {
      scriptDiscoveryRun(state.session, [[{ name: 'Read', arguments: {} }]])
      const running = state.session.prompt('等待许可')
      await started
      state.session.dispose()
      release(true)
      await running
      expect(calls).toBe(0)
      expect(state.authorized[0]?.options.signal?.aborted).toBe(true)
    } finally { state.session.dispose() }
  })
  test('Given 两个会话共享同一个定义对象 When 各自执行Read Then 各授权一次且不借用另一会话身份', async () => {
    let calls = 0
    const tool = { ...discoveryTool('Read'), async execute() { calls++; return { content: [], details: {} } } }
    const first = await discoverySession({ tools: [tool] })
    const second = await discoverySession({ tools: [tool] })
    try {
      for (const runtime of [first, second]) {
        scriptDiscoveryRun(runtime.session, [[{ name: 'Read', arguments: {} }]])
        await runtime.session.prompt('共享定义不共享许可')
        expect(runtime.authorized.map(request => request.toolName)).toEqual(['Read'])
        expect(codemodeResults(runtime.session)[0]?.isError).toBe(false)
      }
      expect(calls).toBe(2)
    } finally { first.session.dispose(); second.session.dispose() }
  })

  test('Given 前一个Session已dispose When 重用本轮自有manager和定义创建Session Then 不遗留旧owner或旧许可', async () => {
    const manager = SessionManager.inMemory(process.cwd())
    const tool = discoveryTool('Read')
    const first = await discoverySession({ tools: [tool], manager })
    first.session.dispose()
    const second = await discoverySession({ tools: [tool], manager })
    try {
      scriptDiscoveryRun(second.session, [[{ name: 'Read', arguments: {} }]])
      await second.session.prompt('复用本轮拥有资源')
      expect(second.authorized.map(request => request.toolName)).toEqual(['Read'])
      expect(codemodeResults(second.session)[0]?.isError).toBe(false)
    } finally { second.session.dispose() }
  })

  test('Given 许可等待期间执行定义被替换 When 许可返回allow Then 旧许可不能执行被替换的实现', async () => {
    let calls = 0
    const tool = discoveryTool('Read')
    const runtime = await discoverySession({ tools: [tool], authorize: () => {
      tool.execute = async () => { calls++; return { content: [], details: {} } }
      return true
    } })
    try {
      scriptDiscoveryRun(runtime.session, [[{ name: 'Read', arguments: {} }]])
      await runtime.session.prompt('执行定义漂移必须关闭许可')
      expect(calls).toBe(0)
      expect(codemodeResults(runtime.session)[0]?.isError).toBe(true)
    } finally { runtime.session.dispose() }
  })

  test('Given 前置子hook修改执行入口 When 嵌套pipeline继续 Then 不能跳过最终授权执行替换实现', async () => {
    let calls = 0
    const tool = discoveryTool('Read')
    const factory: ExtensionFactory = pi => {
      pi.on('tool_call', event => {
        if (event.parentToolCallId) tool.execute = async () => { calls++; return { content: [], details: {} } }
      })
    }
    const runtime = await nativeCodemodeSession({ tools: [tool], factories: [factory] })
    try {
      scriptDiscoveryRun(runtime.session, [[codemodeCall('return await tools.Read({});')]])
      await runtime.session.prompt('定义身份不仅是名称和对象地址')
      expect(calls).toBe(0)
      expect(codemodeResults(runtime.session)[0]?.isError).toBe(true)
    } finally { runtime.session.dispose() }
  })

  test('Given 前置子hook通过defineProperty替换入口 When 原始Read策略拒绝 Then 入口不能绕过门禁', async () => {
    let calls = 0
    const tool = discoveryTool('Read')
    const factory: ExtensionFactory = pi => {
      pi.on('tool_call', event => {
        if (event.parentToolCallId) {
          try { Object.defineProperty(tool, 'execute', { value: async () => { calls++; return { content: [], details: {} } } }) }
          catch { /* 公共执行入口不可撤掉；不是依赖hook异常被SDK传播。 */ }
        }
      })
    }
    const runtime = await nativeCodemodeSession({ tools: [tool], factories: [factory], authorize: request => request.toolName !== 'Read' })
    try {
      scriptDiscoveryRun(runtime.session, [[codemodeCall('return await tools.Read({});')]])
      await runtime.session.prompt('不可撤掉执行入口')
      expect(calls).toBe(0)
      expect(runtime.authorized.map(request => request.toolName)).toEqual(['codemode', 'Read'])
    } finally { runtime.session.dispose() }
  })

  test('Given 外部工具使用冻结定义 When 普通直接调用 Then 保留原授权和执行但明确不能进入宿主脚本', async () => {
    const tool = Object.freeze(discoveryTool('FrozenRead'))
    const runtime = await discoverySession({ tools: [tool] })
    try {
      expect(runtime.guard.isProtected(tool)).toBe(false)
      scriptDiscoveryRun(runtime.session, [[{ name: 'FrozenRead', arguments: {} }]])
      await runtime.session.prompt('冻结外部定义保持普通行为')
      expect(runtime.authorized.map(request => request.toolName)).toEqual(['FrozenRead'])
      expect(codemodeResults(runtime.session)[0]?.isError).toBe(false)
    } finally { runtime.session.dispose() }
  })

  test('Given 前置子hook修改已校验的输入 When 嵌套Read继续 Then 输入漂移保守拒绝且零执行', async () => {
    let calls = 0
    const tool = { ...discoveryTool('Read'), async execute() { calls++; return { content: [], details: {} } } }
    const factory: ExtensionFactory = pi => { pi.on('tool_call', event => {
      if (event.parentToolCallId) Reflect.set(event.input, 'query', 'changed-after-validation')
    }) }
    const runtime = await nativeCodemodeSession({ tools: [tool], factories: [factory] })
    try {
      scriptDiscoveryRun(runtime.session, [[codemodeCall('return await tools.Read({query:"original"});')]])
      await runtime.session.prompt('不能审批未经原验证的变更')
      expect(calls).toBe(0)
      expect(runtime.authorized.map(request => request.toolName)).toEqual(['codemode'])
    } finally { runtime.session.dispose() }
  })

  test('Given 子调用授权正在等待 When 仅取消该子signal并收到晚到allow Then 零执行、父未取消、下一次调用不借用旧许可', async () => {
    let calls = 0
    let releaseChild = () => {}
    let lateAllow = () => {}
    let childWaited = false
    let childSignal: AbortSignal | undefined
    let parentSignal: AbortSignal | undefined
    const started = new Promise<void>(resolve => { releaseChild = resolve })
    const read = { ...discoveryTool('Read'), async execute() { calls++; return { content: [], details: {} } } }
    const parent: ToolDefinition = { ...discoveryTool('Parent'), async execute(_id, _args, signal, _update, ctx) {
      if (!ctx) throw new Error('没有公开Context')
      parentSignal = signal
      const child = new AbortController()
      const pending = ctx.executeTool('Read', {}, { signal: child.signal })
      await started
      child.abort()
      const outcome = await pending
      return { ...outcome.result, isError: outcome.isError }
    } }
    const runtime = await discoverySession({ tools: [read, parent], authorize: request => {
      if (request.toolName !== 'Read' || childWaited) return true
      childWaited = true
      childSignal = request.options.signal
      releaseChild()
      return new Promise<PermissionResult>(resolve => { lateAllow = () => resolve({ behavior: 'allow', updatedInput: request.input }) })
    } })
    try {
      scriptDiscoveryRun(runtime.session, [[{ name: 'Parent', arguments: {} }]])
      await runtime.session.prompt('独立子调用取消')
      lateAllow()
      await Promise.resolve()
      expect(childSignal?.aborted).toBe(true)
      expect(parentSignal?.aborted).toBe(false)
      expect(calls).toBe(0)
      scriptDiscoveryRun(runtime.session, [[{ name: 'Read', arguments: {} }]])
      await runtime.session.prompt('再次明确授权')
      expect(calls).toBe(1)
      expect(runtime.authorized.map(request => request.toolName)).toEqual(['Parent', 'Read', 'Read'])
    } finally { runtime.session.dispose() }
  })
})
