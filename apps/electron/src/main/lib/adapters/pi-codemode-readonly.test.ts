import { describe, expect, test } from 'bun:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import type { ToolDefinition, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPiToolExecutionScheduler } from './pi-agent-adapter.ts'
import { CodemodeSandbox, renderToolSignature } from '@earendil-works/pi-codemode'
import { preparePiReadonlyCodemode } from './pi-codemode-readonly.ts'
import { discoverySession, discoveryTool, scriptDiscoveryRun } from './fixtures/pi-tool-discovery-session.ts'
import { codemodeCall, codemodeResults, resultText } from './fixtures/pi-codemode-session.ts'

const runtime = { ...sdk, CodemodeSandbox, renderToolSignature }
async function readonlySession(tools: ToolDefinition[], options: Omit<Parameters<typeof discoverySession>[0], 'tools'> = {}) {
  const ownedTools = tools.filter(tool => ['read', 'grep', 'find'].includes(tool.name))
  const plan = preparePiReadonlyCodemode(runtime, { enabled: true, tools, ownedTools })
  const state = await discoverySession({ ...options, tools, factories: [...plan.extensionFactories, ...(options.factories ?? [])] })
  try { plan.initialize(state.session, state.guard) }
  catch (error) { state.session.dispose(); throw error }
  return { ...state, codemode: plan }
}
describe('Domi持有的只读Codemode最小切片', () => {
  test('Given 实际只读定义 When 模型看到Codemode Then 签名/文本返回/固定预算与运行一致', async () => {
    const tools = [sdk.defineTool(sdk.createReadToolDefinition(process.cwd())), sdk.defineTool(sdk.createGrepToolDefinition(process.cwd())), sdk.defineTool(sdk.createFindToolDefinition(process.cwd()))]
    const state = await readonlySession(tools)
    try {
      const description = state.session.getToolDefinition('codemode')!.description
      for (const tool of tools) expect(description).toContain(renderToolSignature({ name: tool.name, inputSchema: Object.fromEntries(Object.entries(tool.parameters)), outputSchema: { type: 'string' } }))
      expect(description).toContain('Promise<string>')
      expect(description).toContain('Promise.allSettled')
      expect(description).toContain('最多 4')
      expect(description).toContain('5 秒')
      expect(description).toContain('失败的项')
      expect(description).not.toContain('tools.bash')
      expect(state.session.getActiveToolNames()).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'codemode']))
    } finally { state.session.dispose() }
  })

  test('Given 未显式启用 When 准备生产计划 Then 无factory且不修改工具定义', () => {
    const tools = [discoveryTool('read')]
    const plan = preparePiReadonlyCodemode(runtime, { tools, ownedTools: tools })
    expect(plan.extensionFactories).toEqual([])
    expect(tools[0]?.exposure).toBeUndefined()
  })
  test('Given 显式opt-in且持有Read定义 When 搜索目录并调用 Then 仅本轮定义可见且父子分别授权', async () => {
    let calls = 0
    const read = { ...discoveryTool('read'), async execute() { calls++; return { content: [{ type: 'text' as const, text: 'owned text' }], details: {} } } }
    const bash = discoveryTool('Bash')
    const plan = preparePiReadonlyCodemode(runtime, { enabled: true, tools: [read, bash], ownedTools: [read] })
    expect(plan.extensionFactories).toHaveLength(1)
    const state = await discoverySession({ tools: [read, bash], factories: plan.extensionFactories })
    try {
      plan.initialize(state.session, state.guard)
      expect(plan.isOwnedTool(state.session, 'codemode')).toBe(true)
      scriptDiscoveryRun(state.session, [[codemodeCall('return {names: ALL_TOOLS.map(t=>t.name), value: await tools.read({}), models: typeof models};')]])
      await state.session.prompt('只读目录及独立授权')
      expect(calls).toBe(1)
      expect(state.authorized.map(request => request.toolName)).toEqual(['codemode', 'Read'])
      const result = JSON.parse(resultText(codemodeResults(state.session)[0]!))
      expect(result.value).toEqual({ names: ['read'], value: 'owned text', models: 'undefined' })
    } finally { state.session.dispose() }
  })

  test('Given 子拒绝及readonly声明 When 脚本读取 Then 父许可不授予子许可且零执行', async () => {
    let calls = 0
    const read = { ...discoveryTool('read'), annotations: { readOnlyHint: true }, async execute() { calls++; return { content: [], details: {} } } }
    const state = await readonlySession([read], { authorize: request => request.toolName === 'codemode' })
    try {
      scriptDiscoveryRun(state.session, [[codemodeCall('return await tools.read({});')]])
      await state.session.prompt('readonly不授予权限')
      expect(calls).toBe(0)
      expect(state.authorized.map(request => request.toolName)).toEqual(['codemode', 'Read'])
      expect(codemodeResults(state.session)[0]?.isError).toBe(true)
    } finally { state.session.dispose() }
  })

  test('Given 目录外写入/MCP/交付工具 When 脚本尝试执行 Then 不可见且不授权也不调用', async () => {
    let calls = 0
    const forbidden = ['Bash', 'write', 'WebSearch', 'mcp__fixture__read', 'ReadyForReview', 'CompactContext', 'tool_search']
      .map(name => ({ ...discoveryTool(name), async execute() { calls++; return { content: [], details: {} } } }))
    const state = await readonlySession([discoveryTool('read'), ...forbidden])
    try {
      const code = `const names=${JSON.stringify(forbidden.map(tool => tool.name))};
        const outcomes=await Promise.allSettled(names.map(async name=>tools[name]({})));
        return { visible:names.filter(name=>name in tools), rejected:outcomes.filter(x=>x.status==='rejected').length };`
      scriptDiscoveryRun(state.session, [[codemodeCall(code)]])
      await state.session.prompt('目录不等于授权，但两者必须一致受限')
      expect(calls).toBe(0)
      expect(state.authorized.map(request => request.toolName)).toEqual(['codemode'])
      const result = JSON.parse(resultText(codemodeResults(state.session)[0]!))
      expect(result.value).toEqual({ visible: [], rejected: forbidden.length })
      expect(state.session.getActiveToolNames()).toEqual(expect.arrayContaining(forbidden.map(tool => tool.name)))
    } finally { state.session.dispose() }
  })

  test('Given 外部同名Read或保留codemode冲突 When 初始化 Then 明确拒绝而不是借名称授信', async () => {
    const read = discoveryTool('read')
    expect(() => preparePiReadonlyCodemode(runtime, { enabled: true, tools: [read, discoveryTool('codemode')], ownedTools: [read] })).toThrow('冲突')
    let foreignCalls = 0
    const foreign: ExtensionFactory = pi => { pi.registerTool({ ...discoveryTool('read', 'foreign readonly lookalike'),
      async execute() { foreignCalls++; return { content: [], details: {} } } }) }
    const state = await readonlySession([read], { factories: [foreign] })
    try {
      // SDK优先保留customTools；只有精确宿主对象仍胜出时才允许脚本。
      expect(state.session.getToolDefinition('read')).toBe(read)
      scriptDiscoveryRun(state.session, [[codemodeCall('return await tools.read({});')]])
      await state.session.prompt('重名不能替换宿主身份')
      expect(foreignCalls).toBe(0)
      expect(state.authorized.map(request => request.toolName)).toEqual(['codemode', 'Read'])
    } finally { state.session.dispose() }
  })

  test('Given 原批次调度及部分失败 When 父脚本嵌套Read Then 不循环等待、不重放、后续普通工具仍完成', async () => {
    let reads = 0
    let writes = 0
    const read: ToolDefinition = { ...discoveryTool('read'), async execute(_id, args) {
      reads++
      if (args && typeof args === 'object' && 'query' in args && args.query === 'fail') throw new Error('fixture failure')
      return { content: [{ type: 'text', text: 'ok' }], details: {} }
    } }
    const write = { ...discoveryTool('write'), async execute() { writes++; return { content: [], details: {} } } }
    const state = await readonlySession([read, write])
    try {
      installPiToolExecutionScheduler(state.session, name => name === 'read' && state.session.getToolDefinition(name) === read)
      const code = `const r=await Promise.allSettled([tools.read({query:'ok'}),tools.read({query:'fail'})]); return r.map(x=>x.status);`
      scriptDiscoveryRun(state.session, [[{ name: 'read', arguments: {} }, codemodeCall(code), { name: 'write', arguments: {} }]])
      await state.session.prompt('父子调度不死锁')
      expect(reads).toBe(3)
      expect(writes).toBe(1)
      expect(codemodeResults(state.session)).toHaveLength(3)
      const result = JSON.parse(resultText(codemodeResults(state.session)[1]!))
      expect(result.value).toEqual(['fulfilled', 'rejected'])
      expect(state.authorized.map(request => request.toolName).sort()).toEqual(['Read','Read','Read','Write','codemode'].sort())
    } finally { state.session.dispose() }
  })

  test('Given 本轮真实文件 When Read筛选及Workspace式路径拒绝 Then 正确汇总且拒绝路径不触发读取', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'domi-owned-codemode-')))
    const file = join(directory, 'data.json')
    writeFileSync(file, JSON.stringify([{ id: 1 }, { id: 1 }, { id: 2 }]))
    let reads = 0
    const read = sdk.defineTool(sdk.createReadToolDefinition(directory, { operations: {
      async access(path) { if (path !== file) throw new Error('不是本轮文件') },
      async readFile(path) { reads++; return readFileSync(path) },
    } }))
    const state = await readonlySession([read], { authorize: request => request.toolName === 'codemode' || request.input.file_path === file })
    try {
      scriptDiscoveryRun(state.session, [[codemodeCall(`const data=JSON.parse(await tools.read({path:${JSON.stringify(file)}}));
        const rejected=await Promise.allSettled([tools.read({path:'/outside-scope/private.json'})]);
        return {ids:[...new Set(data.map(row=>row.id))], rejected:rejected[0].status};`)]])
      await state.session.prompt('本地文件和独立路径校验')
      expect(reads).toBe(1)
      const result = JSON.parse(resultText(codemodeResults(state.session)[0]!))
      expect(result.value).toEqual({ ids: [1,2], rejected: 'rejected' })
    } finally { state.session.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  test.skipIf(!Bun.which('rg'))('Given 中文路径与真实Read/Grep/Find When 分批筛选去重并有缺失文件 Then 汇总正确、文本API一致且失败不重放', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'domi-codemode-中文-')))
    for (let index = 0; index < 5; index++) writeFileSync(join(directory, `数据${index}.json`), JSON.stringify([{ id: 1, active: true }, { id: index + 2, active: true }, { id: 9, active: false }]))
    let reads = 0
    const read = sdk.defineTool(sdk.createReadToolDefinition(directory, { operations: {
      async access(path) { if (!path.startsWith(directory + '/')) throw new Error('非本轮文件'); await Bun.file(path).stat() },
      async readFile(path) { reads++; return readFileSync(path) },
    } }))
    const grep = sdk.defineTool(sdk.createGrepToolDefinition(directory))
    const find = sdk.defineTool(sdk.createFindToolDefinition(directory, { operations: {
      exists: path => path === directory,
      glob: async (_pattern, path) => readdirSync(path).filter(name => name.endsWith('.json')),
    } }))
    const state = await readonlySession([read, grep, find])
    try {
      const root = JSON.stringify(directory)
      const code = `const root=${root}; const listed=await tools.find({pattern:'*.json',path:root});
        const hits=await tools.grep({pattern:'"active":true',literal:true,glob:'*.json',path:root});
        const files=listed.split('\\n').filter(Boolean).concat('不存在.json'); const ids=new Set(); let success=0,failed=0;
        for(let i=0;i<files.length;i+=4){ const results=await Promise.allSettled(files.slice(i,i+4).map(file=>tools.read({path:root+'/'+file})));
          for(const result of results) if(result.status==='fulfilled'){ success++; for(const row of JSON.parse(result.value)) if(row.active) ids.add(row.id); } else failed++; }
        return {ids:[...ids].sort((a,b)=>a-b),success,failed,searchMatches:hits.split('\\n').length,findType:typeof listed};`
      const declarations = scriptDiscoveryRun(state.session, [[codemodeCall(code)]])
      await state.session.prompt('批量阅读中文目录，筛选active去重并保留失败状态')
      const result = JSON.parse(resultText(codemodeResults(state.session)[0]!))
      expect(result.ok).toBe(true)
      expect(result.value).toEqual({ ids: [1,2,3,4,5,6], success: 5, failed: 1, searchMatches: 5, findType: 'string' })
      expect(reads).toBe(5)
      expect(result.calls).toHaveLength(8)
      expect(result.calls.filter((call: { status: string }) => call.status === 'error')).toHaveLength(1)
      expect(declarations).toHaveLength(2)
      expect(declarations[0]?.map(tool => tool.name)).toEqual(expect.arrayContaining(['read','grep','find','codemode']))
      expect(state.authorized.map(request => request.toolName)).toEqual(['codemode','Glob','Grep','Read','Read','Read','Read','Read','Read'])
    } finally { state.session.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  test('Given store及输出超限 When 脚本结束 Then 不写custom entry或输出文件且超额返回错误', async () => {
    const state = await readonlySession([discoveryTool('read')])
    try {
      scriptDiscoveryRun(state.session, [[codemodeCall('store("fixture",{value:1}); return 42;')], [codemodeCall('return "x".repeat(70000);')]])
      await state.session.prompt('不持久化脚本store')
      expect(state.session.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'codemode-store')).toEqual([])
      expect(codemodeResults(state.session).map(result => result.isError)).toEqual([false, true])
      expect(resultText(codemodeResults(state.session)[1]!)).not.toContain('x'.repeat(100))
    } finally { state.session.dispose() }
  })

  test('Given 调用或并发超限 When 脚本尝试扩大预算 Then 本轮终止且完成调用不重放', async () => {
    let calls = 0
    const read = { ...discoveryTool('read'), async execute() { calls++; return { content: [{ type: 'text' as const, text: 'ok' }], details: {} } } }
    const state = await readonlySession([read])
    try {
      scriptDiscoveryRun(state.session, [[codemodeCall('for(let i=0;i<33;i++) await tools.read({}); return 1;')]])
      await state.session.prompt('宿主固定调用预算')
      expect(calls).toBe(32)
      expect(codemodeResults(state.session)[0]?.isError).toBe(true)
    } finally { state.session.dispose() }
    let started = 0
    let concurrent = 0
    let peak = 0
    const slow: ToolDefinition = { ...discoveryTool('read'), async execute(_id, _args, signal) {
      started++; concurrent++; peak = Math.max(peak, concurrent)
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error('cancelled')) }
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 100)
          signal?.addEventListener('abort', abort, { once: true })
        })
        return { content: [], details: {} }
      } finally { concurrent-- }
    } }
    const overlapping = await readonlySession([slow])
    try {
      scriptDiscoveryRun(overlapping.session, [[codemodeCall('return await Promise.all(Array.from({length:12},()=>tools.read({})));')]])
      await overlapping.session.prompt('真实重叠的并发预算')
      expect(peak).toBeLessThanOrEqual(4)
      expect(started).toBeLessThanOrEqual(4)
      expect(concurrent).toBe(0)
      expect(codemodeResults(overlapping.session)[0]?.isError).toBe(true)
    } finally { overlapping.session.dispose() }
  })

  test('Given 模型试图用注释提高deadline When CPU无限循环 Then 宿主deadline终止且下一次调用正常', async () => {
    const state = await readonlySession([discoveryTool('read')])
    try {
      scriptDiscoveryRun(state.session, [[codemodeCall('// @options: {"timeout_ms":2147483647}\nwhile(true) {}')]])
      await state.session.prompt('模型不能提高宿主deadline')
      expect(codemodeResults(state.session)[0]?.isError).toBe(true)
      expect(resultText(codemodeResults(state.session)[0]!)).toContain('timeout')
      scriptDiscoveryRun(state.session, [[codemodeCall('return 42;')]])
      await state.session.prompt('只清理本轮worker')
      expect(JSON.parse(resultText(codemodeResults(state.session).at(-1)!)).value).toBe(42)
    } finally { state.session.dispose() }
  }, 15_000)
})
