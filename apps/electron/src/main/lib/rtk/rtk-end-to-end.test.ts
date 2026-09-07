import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRtkService, findRtkExecutable, runRtkProcess } from './rtk-service.ts'
import { createRtkOriginalStore } from './rtk-original-store.ts'
import { optimizeRtkOutput } from './rtk-output-optimizer.ts'

const smoke = process.env.DOMI_RTK_SMOKE === '1' ? describe : describe.skip
smoke('RTK 真实过滤与原文落盘闭环', () => {
  let root: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'domi-rtk-e2e-')) })
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  test('Given 内置 RTK When 优化 Git 日志 Then 原文一致且统计包含引用开销', async () => {
    const service = createRtkService({ findExecutable: findRtkExecutable, run: runRtkProcess })
    expect((await service.recheck()).availability).toBe('available')
    const raw = Array.from({ length: 30 }, (_, i) => `commit ${String(i).padStart(40, '0')}\nAuthor: Test <test@example.invalid>\nDate: Sat Sep 5 2026\n\n    Change ${i}\n`).join('\n')
    const result = await optimizeRtkOutput('git-log', raw, {
      filter: service.filter, saveOriginal: createRtkOriginalStore(root), record: service.record,
    })
    expect(result).toBeDefined()
    expect(readFileSync(result!.originalPath, 'utf8')).toBe(raw)
    expect(service.getStatus()).toMatchObject({ optimizedCalls: 1, originalBytes: Buffer.byteLength(raw), returnedBytes: Buffer.byteLength(result!.text) })
    expect(Buffer.byteLength(result!.text)).toBeLessThan(Buffer.byteLength(raw))
    console.log(`[RTK e2e] Git log（含原文引用）: ${Buffer.byteLength(raw)} -> ${Buffer.byteLength(result!.text)} bytes`)
  }, 15000)
  test('Given Git status 无净收益 When 过滤 Then 不保存冗余原文也不虚报节省', async () => {
    const service = createRtkService({ findExecutable: findRtkExecutable, run: runRtkProcess })
    const noGainRoot = mkdtempSync(join(root, 'no-gain-'))
    const result = await optimizeRtkOutput('git-status', Array.from({ length: 90 }, (_, i) => ` M src/component-${i}.ts`).join('\n'), {
      filter: service.filter, saveOriginal: createRtkOriginalStore(noGainRoot), record: service.record,
    })
    expect(result).toBeUndefined()
    expect(readdirSync(noGainRoot)).toEqual([])
    expect(service.getStatus().optimizedCalls).toBe(0)
  }, 15000)
})
