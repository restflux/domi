import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBashToolDefinition, createLocalBashOperations, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { initializeShellAnalysis } from '../execution-policy/shell-analysis.ts'
import { createRtkBashToolDefinition } from '../adapters/pi-rtk-output.ts'
import { createRtkService, findRtkExecutable, runRtkProcess } from './rtk-service.ts'
import { createRtkOriginalStore } from './rtk-original-store.ts'

const smoke = process.env.DOMI_RTK_SMOKE === '1' ? describe : describe.skip
smoke('真实 Bun → SDK Bash → 输出适配 → 原文与统计', () => {
  let root: string
  beforeAll(async () => {
    await initializeShellAnalysis()
    root = mkdtempSync(join(tmpdir(), 'domi-bun-rtk-'))
    writeFileSync(join(root, 'success.test.ts'), `import { test, expect } from 'bun:test';\n` +
      Array.from({ length: 24 }, (_, index) => `test('case ${index} retains a long descriptive successful test name', () => expect(1).toBe(1));`).join('\n'))
    writeFileSync(join(root, 'failure.test.ts'), `import { test, expect } from 'bun:test'; test('important failure diagnostic', () => expect(1).toBe(2));`)
  })
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  test('Given 真实成功/失败 Bun When 通过 SDK 执行 Then 成功可优化而失败原样抛出', async () => {
    const service = createRtkService({ findExecutable: findRtkExecutable, run: runRtkProcess })
    expect((await service.recheck()).availability).toBe('available')
    const operations = createLocalBashOperations()
    let executions = 0
    let original = ''
    const create = (onExit: (code: number | null) => void) => createBashToolDefinition(root, {
      exposeSessionEnvironment: false,
      operations: { async exec(command, cwd, options) {
        executions++
        const result = await operations.exec(command, cwd, { ...options, onData: data => {
          original += data.toString('utf8')
          options.onData(data)
        } })
        onExit(result.exitCode)
        return result
      } },
    }) as unknown as ToolDefinition
    const tool = createRtkBashToolDefinition(create, {
      isEnabled: () => true, getWorkflow: () => 'direct', supportedShell: true,
      dependencies: {
        filter: service.filter, record: service.record, skip: service.skip,
        saveOriginal: createRtkOriginalStore(root),
        originalPathHint: join(root, 'rtk-output', '00000000-0000-0000-0000-000000000000.txt'),
      },
    })
    const ctx = {} as Parameters<ToolDefinition['execute']>[4]
    const result = await tool.execute('success', { command: 'bun test ./success.test.ts' }, undefined, undefined, ctx)
    expect(executions).toBe(1)
    expect(service.getStatus().optimizedCalls).toBe(1)
    const path = (result.details as { fullOutputPath: string }).fullOutputPath
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('24 pass') })
    console.log(`[Bun SDK smoke] ${service.getStatus().originalBytes} → ${service.getStatus().returnedBytes} bytes（含原文引用）`)
    await expect(tool.execute('failure', { command: 'bun test ./failure.test.ts' }, undefined, undefined, ctx)).rejects.toThrow('important failure diagnostic')
    expect(executions).toBe(2)
    expect(service.getStatus()).toMatchObject({ optimizedCalls: 1, skippedCalls: { failed: 1 } })
  }, 30000)
})
