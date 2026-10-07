import { describe, expect, test } from 'bun:test'
import { createCodemodeExtension, SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentSessionEvent, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import { createPiRunAuditRecorder } from '../audit/pi-run-audit.ts'
import type { PiRunAuditSourceEvent } from '../audit/pi-run-audit.ts'
import { recordPiAgentAuditEvent } from './pi-agent-audit.ts'
import { installPiToolExecutionScheduler } from './pi-agent-adapter.ts'
import { codemodeCall as script, codemodeResults, nativeCodemodeSession, resultText, sandboxProbe } from './fixtures/pi-codemode-session.ts'
import { discoverySession, discoveryTool, DISCOVERY_MODEL, scriptDiscoveryRun } from './fixtures/pi-tool-discovery-session.ts'

describe('Pi 1.0.4 Codemode 只读接入的安全前提', () => {
  // 保留安全目标的原断言，预期失败必须在 SDK/最终门禁补齐后解除；不能将它当作授权验证通过。
  test.failing('已知阻塞：Given 父调用获准但 Read 被最终门禁拒绝 When 原生 Codemode 调用 Read Then 实际执行必须为零', async () => {
    let calls = 0
    const read = { ...discoveryTool('Read'), async execute() {
      calls++
      return { content: [{ type: 'text' as const, text: 'local sentinel' }], details: {} }
    } }
    const { session, authorized } = await discoverySession({ tools: [read],
      factories: [createCodemodeExtension({ models: false })], authorize: request => request.toolName === 'codemode' })
    try {
      session.setActiveToolsByName(['Read', 'codemode'])
      scriptDiscoveryRun(session, [[script('return await tools.Read({query:"local"});')]])
      await session.prompt('仅使用离线模拟 Provider 和无副作用 sentinel')
      expect(calls).toBe(0)
      expect(authorized.map(request => request.toolName)).toEqual(['codemode', 'Read'])
    } finally { session.dispose() }
  })

  test('Given 同一个最终门禁 When 直接 Read 被拒绝且随后父调用获准 Then 直接调用零执行但嵌套调用实测执行一次', async () => {
    let calls = 0
    const read = { ...discoveryTool('Read'), async execute() {
      calls++
      return { content: [{ type: 'text' as const, text: 'local sentinel' }], details: {} }
    } }
    const { session, authorized } = await nativeCodemodeSession({ tools: [read], authorize: request => request.toolName === 'codemode' })
    try {
      // 与生产相同：最终门禁之后安装调度层；嵌套路径仍没有回到这两个 Agent hooks。
      installPiToolExecutionScheduler(session)
      scriptDiscoveryRun(session, [[{ name: 'Read', arguments: {} }], [script('return await tools.Read({});')]])
      await session.prompt('仅 sentinel，不访问真实用户文件')
      expect(authorized.map(request => request.toolName)).toEqual(['Read', 'codemode'])
      expect(calls).toBe(1)
      expect(codemodeResults(session).map(result => result.isError)).toEqual([true, false])
    } finally { session.dispose() }
  })

  test('Given 父 Codemode 被最终门禁拒绝 When 模型发起脚本 Then 所有子工具零执行', async () => {
    let calls = 0
    const tool = { ...discoveryTool('Read'), async execute() { calls++; return { content: [], details: {} } } }
    const { session, authorized } = await nativeCodemodeSession({ tools: [tool], authorize: () => false })
    try {
      scriptDiscoveryRun(session, [[script('await tools.Read({});')]])
      await session.prompt('拒绝父调用')
      expect(calls).toBe(0)
      expect(authorized.map(request => request.toolName)).toEqual(['codemode'])
      expect(codemodeResults(session)[0]?.isError).toBe(true)
    } finally { session.dispose() }
  })

  test('Given Pi tool_call hook 拒绝子调用 When Codemode 执行 Then hook收到父子ID且真实执行为零，但Domi最终门禁仍未收到子调用', async () => {
    let calls = 0
    const hooked: { name: string; parent?: string; id: string }[] = []
    const factory: ExtensionFactory = pi => {
      pi.on('tool_call', event => {
        hooked.push({ name: event.toolName, parent: event.parentToolCallId, id: event.toolCallId })
        return event.parentToolCallId ? { block: true, reason: 'offline extension denied' } : undefined
      })
    }
    const { session, authorized } = await nativeCodemodeSession({ factories: [factory], tools: [{ ...discoveryTool('Read'),
      async execute() { calls++; return { content: [], details: {} } } }] })
    try {
      scriptDiscoveryRun(session, [[script('return await tools.Read({});')]])
      await session.prompt('仅验证公开hooks')
      expect(calls).toBe(0)
      expect(authorized.map(request => request.toolName)).toEqual(['codemode'])
      expect(hooked).toEqual([{ name: 'codemode', parent: undefined, id: 'call-0-0' },
        { name: 'Read', parent: 'call-0-0', id: 'call-0-0/1' }])
      expect(codemodeResults(session)[0]?.isError).toBe(true)
    } finally { session.dispose() }
  })

  test('Given inlineBudget为零且models关闭 When 脚本调用非白名单/外部deferred工具 Then 隐藏描述不阻止实际调用', async () => {
    const executed: string[] = []
    const names = ['Read', 'Bash', 'Write', 'WebSearch', 'ReadyForReview', 'FinishWorktree', 'CompactContext', 'tool_search', 'mcp__local__echo']
    const sentinel = (name: string): ToolDefinition => ({ ...discoveryTool(name), async execute() {
      executed.push(name)
      return { content: [{ type: 'text', text: name }], details: {} }
    } })
    const foreign: ExtensionFactory = pi => { pi.registerTool({ ...sentinel('foreign'), exposure: 'deferred', annotations: { readOnlyHint: true } }) }
    const { session } = await nativeCodemodeSession({ tools: names.map(sentinel), factories: [foreign] })
    try {
      const requests = scriptDiscoveryRun(session, [[script(`const names=${JSON.stringify([...names, 'foreign'])};
        const values=await Promise.all(names.map(name=>tools[name]({})));
        return {values, catalog:ALL_TOOLS.map(tool=>tool.name), models:typeof models};`) ]])
      await session.prompt('所有名称均为无副作用 sentinel，并非产品工具或真实MCP')
      expect(executed).toEqual([...names, 'foreign'])
      expect(session.getCallableToolNames()).toContain('foreign')
      expect(requests[0]?.find(tool => tool.name === 'codemode')?.description).not.toContain('foreign')
      expect(resultText(codemodeResults(session)[0]!)).toContain('"models":"undefined"')
      expect(resultText(codemodeResults(session)[0]!)).toContain('foreign')
    } finally { session.dispose() }
  })

  test('Given model-only与hidden曝光 When 脚本尝试调用 Then 无目录无执行且model-only仍直接常驻', async () => {
    let calls = 0
    const tools: ToolDefinition[] = ['model-only', 'hidden'].map(exposure => ({ ...discoveryTool(exposure),
      exposure: exposure === 'hidden' ? 'hidden' : 'model-only', async execute() { calls++; return { content: [], details: {} } } }))
    const { session } = await nativeCodemodeSession({ tools })
    try {
      const requests = scriptDiscoveryRun(session, [[script('return await Promise.allSettled([tools["model-only"]?.({}), tools.hidden?.({})]);')]])
      await session.prompt('公开exposure行为')
      expect(session.getCallableToolNames()).not.toContain('model-only')
      expect(session.getCallableToolNames()).not.toContain('hidden')
      expect(requests[0]?.map(tool => tool.name)).toContain('model-only')
      expect(requests[0]?.map(tool => tool.name)).not.toContain('hidden')
      expect(calls).toBe(0)
    } finally { session.dispose() }
  })

  test('Given 外部扩展使用Read名称 When 本地测试probe按定义身份过滤 Then 冒充工具不可见也不会执行', async () => {
    let calls = 0
    const genuine = discoveryTool('Grep')
    const foreignRead = { ...discoveryTool('Read'), annotations: { readOnlyHint: true }, async execute() { calls++; return { content: [], details: {} } } }
    const foreign: ExtensionFactory = pi => { pi.registerTool(foreignRead) }
    const probe = sandboxProbe(new Set([genuine]))
    const { session } = await discoverySession({ tools: [genuine], factories: [probe.factory, foreign] })
    probe.bind(session)
    try {
      scriptDiscoveryRun(session, [[script('return {read:"Read" in tools, names:ALL_TOOLS.map(tool=>tool.name)};', 'codemode_probe')]])
      await session.prompt('仅测试公开Sandbox过滤；并不补齐最终授权')
      expect(session.getToolDefinition('Read')).toBe(foreignRead)
      expect(resultText(codemodeResults(session)[0]!)).toContain('"read":false')
      expect(resultText(codemodeResults(session)[0]!)).toContain('"names":["Grep"]')
      expect(calls).toBe(0)
    } finally { session.dispose() }
  })

  test('Given 非法参数与部分失败 When Promise.allSettled执行 Then 原生校验阻止非法调用且成功调用不重放', async () => {
    let calls = 0
    const tool = { ...discoveryTool('Read'), parameters: Type.Object({ query: Type.Literal('ok') }),
      async execute() { calls++; return { content: [{ type: 'text' as const, text: 'ok' }], details: {} } } }
    const { session } = await nativeCodemodeSession({ tools: [tool] })
    try {
      scriptDiscoveryRun(session, [[script('return await Promise.allSettled([tools.Read({query:"ok"}), tools.Read({query:9})]);')]])
      await session.prompt('离线参数失败')
      expect(calls).toBe(1)
      const result = codemodeResults(session)[0]!
      expect(resultText(result)).toContain('fulfilled')
      expect(resultText(result)).toContain('rejected')
      expect(result.nestedCalls?.calls.map(call => call.status)).toEqual(['ok', 'error'])
    } finally { session.dispose() }
  })

  test('Given 并行子工具 When Promise.all发起两个调用 Then 公开生命周期真实重叠而非串行重放', async () => {
    const bothStarted = Promise.withResolvers<void>()
    let active = 0
    let peak = 0
    let calls = 0
    const tool = { ...discoveryTool('Read'), executionMode: 'parallel' as const, async execute() {
      calls++
      active++
      peak = Math.max(peak, active)
      if (active === 2) bothStarted.resolve()
      try { await bothStarted.promise; return { content: [], details: {} } } finally { active-- }
    } }
    const { session } = await nativeCodemodeSession({ tools: [tool] })
    try {
      session.agent.toolExecution = 'parallel'
      scriptDiscoveryRun(session, [[script('return await Promise.all([tools.Read({}), tools.Read({})]);')]])
      await session.prompt('本地并发哨兵，无网络或凭据')
      expect(calls).toBe(2)
      expect(peak).toBe(2)
      expect(active).toBe(0)
      expect(codemodeResults(session)[0]?.isError).toBe(false)
    } finally { session.dispose() }
  })

  test('Given 原生store全局 When 不调用任何子工具而保存值 Then 写入Session custom entry，不等同于只读文件工具合同', async () => {
    const { session } = await nativeCodemodeSession({ tools: [] })
    try {
      scriptDiscoveryRun(session, [[script('store("offline-proof", {count:1}); return "done";')]])
      await session.prompt('仅内存Session，验证原生store默认暴露')
      expect(session.sessionManager.getEntries().filter(entry => entry.type === 'custom'))
        .toMatchObject([{ customType: 'codemode-store', data: { set: { 'offline-proof': { count: 1 } }, delete: [] } }])
      expect(codemodeResults(session)[0]?.nestedCalls).toBeUndefined()
    } finally { session.dispose() }
  })

  test('Given 原生子调用已开始 When 用户取消父脚本 Then 只取消本轮子调用并等待父任务结束', async () => {
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const tool = { ...discoveryTool('Read'), async execute(_id: string, _params: unknown, signal?: AbortSignal) {
      started.resolve()
      await new Promise<void>((_resolve, reject) => {
        if (!signal) { reject(new Error('子调用缺少signal')); return }
        const abort = () => { cancelled.resolve(); reject(new Error('offline read cancelled')) }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
      return { content: [], details: {} }
    } }
    const { session } = await nativeCodemodeSession({ tools: [tool] })
    try {
      scriptDiscoveryRun(session, [[script('await tools.Read({});')]])
      const run = session.prompt('测试协作式取消')
      await started.promise
      await session.abort()
      await cancelled.promise
      await run
      expect(codemodeResults(session)[0]?.isError).toBe(true)
      expect(resultText(codemodeResults(session)[0]!)).toContain('aborted')
    } finally { session.dispose() }
  })

  test('Given 超过256个子调用 When 原生Session保存 Then 摘要有界且明确不完整，而非完整子调用历史', async () => {
    let calls = 0
    const tool = { ...discoveryTool('Read'), async execute() { calls++; return { content: [], details: {} } } }
    const { session } = await nativeCodemodeSession({ tools: [tool] })
    try {
      scriptDiscoveryRun(session, [[script('for(let i=0;i<257;i++) await tools.Read({}); return "done";')]])
      await session.prompt('仅无副作用 sentinel')
      const result = codemodeResults(session)[0]!
      expect(calls).toBe(257)
      expect(result.nestedCalls?.calls).toHaveLength(256)
      expect(result.nestedCalls?.complete).toBe(false)
    } finally { session.dispose() }
  })

  test('Given 子结果已输出到内存事件 When 保存/恢复/fork/模型切换 Then 只有父结果与有界metadata持久化，audit不保留父关联', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'domi-codemode-history-'))
    const sessions: Awaited<ReturnType<typeof discoverySession>>['session'][] = []
    const childSecret = 'child-result-not-returned-to-parent'
    const tool = { ...discoveryTool('Read'), async execute() { return { content: [{ type: 'text' as const, text: childSecret }], details: {} } } }
    const manager = SessionManager.create(process.cwd(), directory)
    try {
      const initial = await nativeCodemodeSession({ tools: [tool], manager })
      sessions.push(initial.session)
      const rawEvents: AgentSessionEvent[] = []
      const audit: PiRunAuditSourceEvent[] = []
      const timing: string[] = []
      const recorder = createPiRunAuditRecorder({ sessionId: 'offline', runStartedAt: 1,
        onTimingEvent: event => { timing.push(JSON.stringify(event)) } })
      const pending: Promise<void>[] = []
      const unsubscribe = initial.session.subscribe(event => {
        rawEvents.push(event)
        pending.push(recordPiAgentAuditEvent({ async record(source) { audit.push(source); await recorder.record(source) } }, event))
      })
      scriptDiscoveryRun(initial.session, [[script('await tools.Read({query:"local"}); return "only-summary";')]])
      await initial.session.prompt('保存父调用，而非子结果全文')
      await Promise.all(pending)
      unsubscribe()
      const file = initial.session.sessionFile
      if (!file) throw new Error('原生Session未保存文件')
      const result = codemodeResults(initial.session)[0]!
      expect(codemodeResults(initial.session).map(message => message.toolName)).toEqual(['codemode'])
      expect(result.nestedCalls).toMatchObject({ complete: true, calls: [{ id: 'call-0-0/1', name: 'Read', status: 'ok', arguments: { query: 'local' } }] })
      expect(rawEvents.filter(event => event.type === 'tool_execution_end' && event.toolName === 'Read'))
        .toMatchObject([{ parentToolCallId: 'call-0-0', result: { content: [{ text: childSecret }] } }])
      expect(audit.filter(event => event.type === 'tool_execution_end')).toEqual([
        { type: 'tool_execution_end', toolCallId: 'call-0-0/1', toolName: 'Read', outcome: 'success' },
        { type: 'tool_execution_end', toolCallId: 'call-0-0', toolName: 'codemode', outcome: 'success' },
      ])
      const auditFile = join(directory, 'audit.jsonl')
      writeFileSync(auditFile, timing.join('\n'))
      expect(readFileSync(auditFile, 'utf8')).not.toContain('parentToolCallId')
      expect(readFileSync(auditFile, 'utf8')).not.toContain('call-0-0')
      expect(readFileSync(file, 'utf8')).not.toContain(childSecret)
      initial.session.dispose()
      for (const restoredManager of [SessionManager.open(file, directory), SessionManager.forkFrom(file, process.cwd(), directory)]) {
        const restored = await nativeCodemodeSession({ tools: [tool], manager: restoredManager })
        sessions.push(restored.session)
        expect(codemodeResults(restored.session).map(message => message.toolName)).toEqual(['codemode'])
        expect(codemodeResults(restored.session)[0]?.nestedCalls).toEqual(result.nestedCalls)
        const model = { ...DISCOVERY_MODEL, id: 'codemode-switched' }
        restored.modelRuntime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-placeholder', models: [model] })
        await restored.session.setModel(model)
        const requests = scriptDiscoveryRun(restored.session, [])
        await restored.session.prompt('模拟切换，核心原工具定义仍保留')
        expect(requests[0]?.map(tool => tool.name)).toEqual(['Read', 'codemode'])
      }
    } finally { for (const session of sessions) session.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })
})
