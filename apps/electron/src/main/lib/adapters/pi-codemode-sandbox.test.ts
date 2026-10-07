import { describe, expect, test } from 'bun:test'
import { CodemodeSandbox, MAX_OUTPUT_CHARS, parseCodemodeSource } from '@earendil-works/pi-codemode'

const limits = { timeoutMs: 2000, memoryLimitBytes: 32 * 1024 * 1024 }

// 这里的plain host callbacks是测试哨兵，不是Domi工具，也不构成权限/Workspace边界验证。
describe('Pi 1.0.4 公开 CodemodeSandbox 资源合同', () => {
  test('Given 有界sandbox When 脚本CPU死循环 Then 硬deadline终止worker且后续执行不受污染', async () => {
    const sandbox = new CodemodeSandbox(limits)
    try {
      const timed = await sandbox.execute('while(true) {}', { timeoutMs: 100 })
      expect(timed).toMatchObject({ ok: false, error: { kind: 'timeout' } })
      expect(await sandbox.execute('return 42;')).toMatchObject({ ok: true, value: 42 })
    } finally { await sandbox.close() }
  })

  test('Given 明确的VM内存上限 When 脚本持续分配 Then VM失败而非无限增长', async () => {
    const sandbox = new CodemodeSandbox(limits)
    try {
      const result = await sandbox.execute('const a=[]; while(true) a.push("x".repeat(1024*1024));')
      expect(result).toMatchObject({ ok: false, error: { kind: 'script', message: expect.stringContaining('out of memory') } })
    } finally { await sandbox.close() }
  })

  test('Given 原生输出上限 When text超额 Then 输出被拒绝并明确失败', async () => {
    const sandbox = new CodemodeSandbox({ ...limits, memoryLimitBytes: 128 * 1024 * 1024 })
    try {
      const result = await sandbox.execute(`text("x".repeat(${MAX_OUTPUT_CHARS + 1}));`)
      expect(result).toMatchObject({ ok: false, error: { kind: 'script', message: expect.stringContaining('output exceeded the limit') } })
      expect(result.output).toEqual([])
    } finally { await sandbox.close() }
  })

  test('Given 保留globals/重复工具 When 创建或注册 Then 不允许名称冲突覆盖', async () => {
    expect(() => new CodemodeSandbox({ globals: [{ name: 'tools', execute: () => undefined }] })).toThrow('Invalid global name')
    const sandbox = new CodemodeSandbox({ ...limits, tools: [{ name: 'Read', execute: () => 'local' }] })
    try {
      expect(() => sandbox.registerTool({ name: 'Read', execute: () => 'foreign' })).toThrow('already registered')
      const result = await sandbox.execute('return {node:typeof process, fs:typeof require, network:typeof fetch, models:typeof models};')
      expect(result).toMatchObject({ ok: true, value: { node: 'undefined', fs: 'undefined', network: 'undefined', models: 'undefined' } })
    } finally { await sandbox.close() }
  })

  test('Given 两个拥有不同资源的sandbox When 关闭一个 Then 只取消该实例未完成调用、另一实例继续', async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const first = new CodemodeSandbox({ ...limits, tools: [{ name: 'wait', execute(_args, { signal }) {
      started.resolve()
      return new Promise((_resolve, reject) => {
        const abort = () => { aborted.resolve(); reject(new Error('owned callback aborted')) }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    } }] })
    const second = new CodemodeSandbox(limits)
    try {
      const run = first.execute('await tools.wait({});')
      await started.promise
      await first.close()
      await aborted.promise
      expect(await run).toMatchObject({ ok: false, error: { kind: 'aborted' } })
      await expect(first.execute('return 1;')).rejects.toThrow('closed')
      expect(await second.execute('return 2;')).toMatchObject({ ok: true, value: 2 })
    } finally { await first.close(); await second.close() }
  })

  test('Given 未await的callback When 脚本返回 Then 只取消本次执行的pending调用', async () => {
    let calls = 0
    const cancelled = Promise.withResolvers<void>()
    const sandbox = new CodemodeSandbox({ ...limits, tools: [{ name: 'Read', execute(_args, { signal }) {
      calls++
      return new Promise((_resolve, reject) => {
        const abort = () => { cancelled.resolve(); reject(new Error('pending callback cancelled')) }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    } }] })
    try {
      const result = await sandbox.execute('tools.Read({}); return "done";')
      await cancelled.promise
      expect(result).toMatchObject({ ok: true, value: 'done', calls: [{ name: 'Read', status: 'cancelled' }] })
      expect(calls).toBe(1)
    } finally { await sandbox.close() }
  })

  test('Given 预取消的signal When 执行 Then callback零启动', async () => {
    let calls = 0
    const sandbox = new CodemodeSandbox({ ...limits, tools: [{ name: 'Read', execute() { calls++; return 'local' } }] })
    const controller = new AbortController()
    controller.abort()
    try {
      expect(await sandbox.execute('await tools.Read({});', { signal: controller.signal })).toMatchObject({ ok: false, error: { kind: 'aborted' } })
      expect(calls).toBe(0)
    } finally { await sandbox.close() }
  })

  test('Given 一个成功和一个失败的callback When allSettled汇总 Then 部分成功不重放', async () => {
    let successful = 0
    let failed = 0
    const sandbox = new CodemodeSandbox({ ...limits, tools: [
      { name: 'Read', execute() { successful++; return 'local' } },
      { name: 'Grep', execute() { failed++; throw new Error('offline failure') } },
    ] })
    try {
      const result = await sandbox.execute('return await Promise.allSettled([tools.Read({}), tools.Grep({})]);')
      expect(result).toMatchObject({ ok: true, value: [{ status: 'fulfilled', value: 'local' }, { status: 'rejected' }] })
      expect(result.calls.map(call => call.status)).toEqual(['ok', 'error'])
      expect(successful).toBe(1)
      expect(failed).toBe(1)
    } finally { await sandbox.close() }
  })

  test('Given 原生source options When 脚本声明长时间/大输出 Then 解析会接受，不代表宿主硬上限', () => {
    expect(parseCodemodeSource('return 1;').options).toEqual({})
    expect(parseCodemodeSource('// @options: {"timeout_ms":2147483647,"max_output_tokens":999999999}\nreturn 1;').options)
      .toEqual({ timeoutMs: 2147483647, maxOutputTokens: 999999999 })
    expect(() => parseCodemodeSource('// @options: {"timeout_ms":0}\nreturn 1;')).toThrow('positive integer')
  })
})
