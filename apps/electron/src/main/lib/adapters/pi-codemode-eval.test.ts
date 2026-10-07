import { expect, test } from 'bun:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { preparePiReadonlyCodemode } from './pi-codemode-readonly.ts'
import { createReadToolDefinition, defineTool } from '@earendil-works/pi-coding-agent'
import { access, readFile } from 'node:fs/promises'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codemodeCall, codemodeResults, nativeCodemodeSession } from './fixtures/pi-codemode-session.ts'
import { discoverySession, scriptDiscoveryRun } from './fixtures/pi-tool-discovery-session.ts'

interface LocalRow { id: number; active: boolean; payload: string }
interface Summary { ids: number[]; sourceRows: number; failed: number }
interface Measure { utf8Bytes: number; characterQuarterEstimate: number }
interface Comparison {
  fileCount: number
  missingFile: boolean
  mode: 'ordinary-parallel' | 'native-codemode-test-only' | 'domi-readonly-codemode'
  actualReads: number
  providerRequests: number
  correct: boolean
  completed: boolean
  returnedContent: Measure
}

function measure(value: unknown): Measure {
  const json = JSON.stringify(value)
  return { utf8Bytes: Buffer.byteLength(json), characterQuarterEstimate: Math.ceil(json.length / 4) }
}

async function comparison(fileCount: number, missingFile = false): Promise<Comparison[]> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'domi-codemode-eval-')))
  const filenames = Array.from({ length: fileCount }, (_, index) => join(directory, `${index}.json`))
  const data: LocalRow[] = Array.from({ length: 32 }, (_, id) => ({ id, active: id % 3 === 0, payload: 'local-only-data-'.repeat(32) }))
  const comparisons: Comparison[] = []
  try {
    filenames.forEach((file, index) => { if (!missingFile || index !== fileCount - 1) writeFileSync(file, JSON.stringify(data)) })
    for (const mode of ['ordinary-parallel', 'native-codemode-test-only', 'domi-readonly-codemode'] as const) {
      const reads = new Map<string, number>()
      // 与Domi核心读取相同的公开SDK定义；操作只允许此测试自己创建的固定文件。
      const read = defineTool(createReadToolDefinition(directory, { operations: {
        async access(path) { if (!filenames.includes(path)) throw new Error('not an owned fixture'); await access(path) },
        async readFile(path) {
          if (!filenames.includes(path)) throw new Error('not an owned fixture')
          reads.set(path, (reads.get(path) ?? 0) + 1)
          return await readFile(path)
        },
      } }))
      const plan = preparePiReadonlyCodemode({ ...sdk, CodemodeSandbox }, { enabled: mode === 'domi-readonly-codemode', tools: [read], ownedTools: [read] })
      const state = mode === 'native-codemode-test-only'
        ? await nativeCodemodeSession({ tools: [read] }) : await discoverySession({ tools: [read], factories: plan.extensionFactories })
      const { session } = state
      plan.initialize(session, state.guard)
      try {
        const code = `const files=${JSON.stringify(filenames)}; const results=[];
          for(let i=0;i<files.length;i+=4) results.push(...await Promise.allSettled(files.slice(i,i+4).map(path=>tools.read({path}))));
          const data=results.filter(result=>result.status==="fulfilled").flatMap(result=>JSON.parse(result.value));
          return {ids:[...new Set(data.filter(row=>row.active).map(row=>row.id))].sort((a,b)=>a-b),
            sourceRows:data.length, failed:results.filter(result=>result.status==="rejected").length};`
        const requests = scriptDiscoveryRun(session, [mode === 'ordinary-parallel'
          ? filenames.map(path => ({ name: 'read', arguments: { path } })) : [codemodeCall(code)]])
        await session.prompt('固定本地任务：批量读取，筛选active行，按id去重并汇总；不用外部Provider')
        const results = codemodeResults(session)
        let summary: Summary
        if (mode === 'ordinary-parallel') {
          const successful = results.filter(result => !result.isError)
          const rows = successful.flatMap(result => {
            const text = result.content.find(block => block.type === 'text')
            if (!text || text.type !== 'text') throw new Error('读取没有返回文本')
            const values: LocalRow[] = JSON.parse(text.text)
            return values
          })
          summary = { ids: [...new Set(rows.filter(row => row.active).map(row => row.id))].sort((a, b) => a - b),
            sourceRows: rows.length, failed: results.filter(result => result.isError).length }
        } else {
          const output = results[0]?.content.find(block => block.type === 'text' && block.text.startsWith('{'))
          if (!output || output.type !== 'text') throw new Error('脚本没有返回汇总JSON')
          const parsed = JSON.parse(output.text)
          summary = mode === 'domi-readonly-codemode' ? parsed.value : parsed
        }
        expect(summary).toEqual({ ids: data.filter(row => row.active).map(row => row.id),
          sourceRows: (fileCount - Number(missingFile)) * data.length, failed: Number(missingFile) })
        expect([...reads.values()]).toEqual(Array(fileCount - Number(missingFile)).fill(1))
        comparisons.push({ fileCount, missingFile, mode, actualReads: [...reads.values()].reduce((a, b) => a + b, 0),
          providerRequests: requests.length, correct: true, completed: summary.failed === 0,
          returnedContent: measure(results.map(result => result.content)) })
      } finally { session.dispose() }
    }
    return comparisons
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('Given 同一临时文件任务与并行工具基线 When Codemode只返回筛选汇总 Then 内容缩小但模拟轮次不减少，失败不重放', async () => {
  const rows = [...await comparison(2), ...await comparison(12), ...await comparison(12, true)]
  for (const row of rows) {
    expect(row.correct).toBe(true)
    expect(row.providerRequests).toBe(2)
    expect(row.completed).toBe(!row.missingFile)
    expect(row.actualReads).toBe(row.fileCount - Number(row.missingFile))
  }
  const largeOrdinary = rows.find(row => row.fileCount === 12 && !row.missingFile && row.mode === 'ordinary-parallel')!
  const largeCodemode = rows.find(row => row.fileCount === 12 && !row.missingFile && row.mode === 'native-codemode-test-only')!
  expect(largeCodemode.returnedContent.utf8Bytes).toBeLessThan(largeOrdinary.returnedContent.utf8Bytes / 10)
  console.log('[Pi Codemode offline comparison]', JSON.stringify({
    version: '1.0.4', method: 'Current toolResult content JSON only; UTF-8 bytes and ceil(JSON characters/4), not tokenizer/billing.',
    limitation: 'Native broad factory stays test-only; Domi path uses its default-off owned factory. Both consume the final guard for these held mutable fixture definitions. Scripts know filenames and use batches of four; ordinary summary is computed by test code, not a model. No real reasoning, latency, billing or autonomous success claim.',
    rows,
  }, null, 2))
})
