import { expect, test } from 'bun:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiRunAuditRecorder, type PiRunAuditTimingEvent } from '../audit/pi-run-audit.ts'
import { recordPiAgentAuditEvent } from './pi-agent-audit.ts'
import { preparePiReadonlyCodemode } from './pi-codemode-readonly.ts'
import { DISCOVERY_MODEL, discoverySession, discoveryTool, scriptDiscoveryRun } from './fixtures/pi-tool-discovery-session.ts'
import { codemodeCall, codemodeResults, resultText } from './fixtures/pi-codemode-session.ts'

test('Given 生产只读切片及真实磁盘JSONL When 模型切换/重启/fork Then 父子关联脱敏而子结果仍只有有界历史', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'domi-readonly-history-'))
  const secret = 'owned-child-body-not-in-parent'
  let reads = 0
  const read = { ...discoveryTool('read'), async execute() { reads++; return { content: [{ type: 'text' as const, text: secret }], details: {} } } }
  const tools = [read, discoveryTool('ReadyForReview'), discoveryTool('AskUserQuestion')]
  const events: PiRunAuditTimingEvent[] = []
  const recorder = createPiRunAuditRecorder({ sessionId: 'offline-history', runStartedAt: 1,
    onTimingEvent: event => { events.push(event) } })
  const create = async (manager: sdk.SessionManager) => {
    const plan = preparePiReadonlyCodemode({ ...sdk, CodemodeSandbox }, { enabled: true, tools, ownedTools: [read] })
    const state = await discoverySession({ tools, manager, factories: plan.extensionFactories, auditRecorder: recorder })
    plan.initialize(state.session, state.guard)
    return state
  }
  const states: Awaited<ReturnType<typeof create>>[] = []
  try {
    const first = await create(sdk.SessionManager.create(process.cwd(), directory))
    states.push(first)
    const writes: Promise<void>[] = []
    const unsubscribe = first.session.subscribe(event => { writes.push(recordPiAgentAuditEvent(recorder, event)) })
    scriptDiscoveryRun(first.session, [[codemodeCall('await tools.read({}); return "summary-only";')]])
    await first.session.prompt('真实生产factory历史验证')
    await Promise.all(writes)
    unsubscribe()
    const file = first.session.sessionFile
    if (!file) throw new Error('没有原生JSONL文件')
    const parent = codemodeResults(first.session)[0]!
    expect(parent.nestedCalls?.calls).toHaveLength(1)
    expect(parent.nestedCalls?.complete).toBe(true)
    expect(codemodeResults(first.session).map(result => result.toolName)).toEqual(['codemode'])
    expect(readFileSync(file, 'utf8')).not.toContain(secret)
    const parentTiming = events.find(event => event.phase === 'tool_execution' && event.toolName === 'codemode')
    if (parentTiming?.phase !== 'tool_execution') throw new Error('没有父执行timing')
    const children = events.filter(event => (event.phase === 'tool_execution' || event.phase === 'tool_wait') && event.toolName === 'read')
    expect(children).toHaveLength(2)
    for (const child of children) expect(child).toMatchObject({ parentToolCorrelationId: parentTiming.toolCorrelationId })
    const timingFile = join(directory, 'existing-audit-format.jsonl')
    writeFileSync(timingFile, events.map(event => JSON.stringify(event)).join('\n'))
    for (const forbidden of [secret, 'call-0-0', 'toolCallId', 'parentToolCallId']) expect(readFileSync(timingFile, 'utf8')).not.toContain(forbidden)
    first.session.dispose()
    for (const manager of [sdk.SessionManager.open(file, directory), sdk.SessionManager.forkFrom(file, process.cwd(), directory)]) {
      const restored = await create(manager)
      states.push(restored)
      expect(codemodeResults(restored.session)[0]?.nestedCalls).toEqual(parent.nestedCalls)
      const model = { ...DISCOVERY_MODEL, id: 'readonly-switched' }
      restored.modelRuntime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-placeholder', models: [model] })
      await restored.session.setModel(model)
      const declarations = scriptDiscoveryRun(restored.session, [[codemodeCall('return await tools.read({});')]])
      await restored.session.prompt('新一轮许可，不复用旧执行')
      expect(declarations[0]?.map(tool => tool.name)).toEqual(expect.arrayContaining(['read', 'codemode', 'ReadyForReview', 'AskUserQuestion']))
      expect(restored.authorized.map(request => request.toolName)).toEqual(['codemode', 'Read'])
      expect(JSON.parse(resultText(codemodeResults(restored.session).at(-1)!)).value).toBe(secret)
      restored.session.dispose()
    }
    expect(reads).toBe(3)
  } finally { for (const state of states) state.session.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

test('Given 生产worker中子读取已开始 When 用户取消 Then 实际child signal取消且只清理本轮实例', async () => {
  let started = () => {}
  const beginning = new Promise<void>(resolve => { started = resolve })
  let childSignal: AbortSignal | undefined
  const read: ToolDefinition = { ...discoveryTool('read'), async execute(_id, _args, signal) {
    if (!signal) throw new Error('缺少真实call-level signal')
    childSignal = signal
    started()
    await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true }) })
    return { content: [], details: {} }
  } }
  const plan = preparePiReadonlyCodemode({ ...sdk, CodemodeSandbox }, { enabled: true, tools: [read], ownedTools: [read] })
  const state = await discoverySession({ tools: [read], factories: plan.extensionFactories })
  try {
    plan.initialize(state.session, state.guard)
    scriptDiscoveryRun(state.session, [[codemodeCall('return await tools.read({});')]])
    const running = state.session.prompt('协作式取消')
    await beginning
    await state.session.abort()
    await running
    expect(childSignal?.aborted).toBe(true)
    expect(codemodeResults(state.session)[0]?.isError).toBe(true)
    scriptDiscoveryRun(state.session, [[codemodeCall('return 42;')]])
    await state.session.prompt('下一执行有自己的worker')
    expect(JSON.parse(resultText(codemodeResults(state.session).at(-1)!)).value).toBe(42)
  } finally { state.session.dispose() }
})

test('Given 生产VM内存固定 When 模型分配大数组 Then 原生内存门限拒绝而非扩大权限', async () => {
  const read = discoveryTool('read')
  const plan = preparePiReadonlyCodemode({ ...sdk, CodemodeSandbox }, { enabled: true, tools: [read], ownedTools: [read] })
  const state = await discoverySession({ tools: [read], factories: plan.extensionFactories })
  try {
    plan.initialize(state.session, state.guard)
    scriptDiscoveryRun(state.session, [[codemodeCall('return new Array(10000000).fill("data");')]])
    await state.session.prompt('VM内存有界')
    expect(codemodeResults(state.session)[0]?.isError).toBe(true)
    expect(resultText(codemodeResults(state.session)[0]!)).toContain('out of memory')
    expect(state.authorized.map(request => request.toolName)).toEqual(['codemode'])
  } finally { state.session.dispose() }
}, 15_000)
