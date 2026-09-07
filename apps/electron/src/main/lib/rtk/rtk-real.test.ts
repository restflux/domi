import { describe, expect, test } from 'bun:test'
import { findRtkExecutable, runRtkProcess, RTK_SUPPORTED_VERSION } from './rtk-service.ts'
import type { RtkFilter } from './rtk-command-filter.ts'

const smoke = process.env.DOMI_RTK_SMOKE === '1' ? describe : describe.skip
smoke('内置 RTK 真实二进制（显式 opt-in，不安装）', () => {
  test('Given 内置受支持版本 When 使用固定 pipe filters Then 输出压缩且入口契约兼容', async () => {
    const path = await findRtkExecutable()
    expect(path).toBeDefined()
    expect((await runRtkProcess(path!, ['--version'])).trim()).toBe(`rtk ${RTK_SUPPORTED_VERSION}`)
    const cases: Array<{ filter: RtkFilter; raw: string }> = [
      { filter: 'git-status', raw: 'On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n\n' + Array.from({ length: 90 }, (_, i) => `\tmodified:   src/component-${i}.ts`).join('\n') + '\n\nno changes added to commit\n' },
      { filter: 'git-log', raw: Array.from({ length: 30 }, (_, i) => `commit ${String(i).padStart(40, '0')}\nAuthor: Test <test@example.invalid>\nDate:   Sat Sep 5 14:00:00 2026 +0800\n\n    Update component ${i}\n`).join('\n') },
      { filter: 'tsc', raw: '' },
      { filter: 'vitest', raw: ' RUN  v3.0.0 /repo\n' + Array.from({ length: 50 }, (_, i) => ` ✓ src/component-${i}.test.ts (3 tests) 4ms`).join('\n') + '\n\n Test Files  50 passed (50)\n      Tests  150 passed (150)\n   Duration  1.00s\n' },
    ]
    for (const { filter, raw } of cases) {
      const filtered = await runRtkProcess(path!, ['pipe', '--filter', filter], raw)
      console.log(`[RTK smoke] ${filter}: ${Buffer.byteLength(raw)} -> ${Buffer.byteLength(filtered)} bytes`)
      if (raw) expect(Buffer.byteLength(filtered)).toBeLessThan(Buffer.byteLength(raw))
      if (filter === 'vitest') expect(filtered).toContain('150')
      if (filter === 'git-status') expect(filtered).toContain('main')
      if (filter === 'git-log') expect(filtered).toContain('Update component')
    }
  }, 20000)
})

describe('RTK 子进程硬边界', () => {
  test('Given 非零退出、stderr或过量输出 When 后处理 Then 拒绝该过滤结果', async () => {
    for (const source of ['process.exit(2)', 'console.error("warning")', 'process.stdout.write("x".repeat(100000))']) {
      await expect(runRtkProcess(process.execPath, ['-e', source])).rejects.toThrow()
    }
  })
  test('Given 运行中取消 When 后处理 Then 终止进程并返回失败供原文回退', async () => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 150)
    try {
      await expect(runRtkProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], '', abort.signal)).rejects.toThrow('取消')
    } finally { clearTimeout(timer) }
  })
  test('Given 忽略 SIGTERM 的过滤进程 When 达到上限 Then 强杀并有界返回', async () => {
    const started = Date.now()
    await expect(runRtkProcess(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'])).rejects.toThrow('超时')
    expect(Date.now() - started).toBeLessThan(5000)
  }, 6000)
  test('Given 后代继承 stdio When 进程树超时 Then 独立期限仍能收敛', async () => {
    const started = Date.now()
    const source = 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 4500)"], {stdio: ["ignore", 1, 2]}); setInterval(() => {}, 1000)'
    await expect(runRtkProcess(process.execPath, ['-e', source])).rejects.toThrow('超时')
    expect(Date.now() - started).toBeLessThan(5000)
  }, 6500)
  test('Given 临时目录创建期间权限撤销 When 准备 spawn Then 不执行程序', async () => {
    let checks = 0
    await expect(runRtkProcess(process.execPath, ['-e', 'process.stdout.write("should not run")'], '', undefined, () => ++checks === 1)).rejects.toThrow('取消')
    expect(checks).toBe(2)
  })
})
