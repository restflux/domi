#!/usr/bin/env bun

import { resolve } from 'node:path'
import { compareTestFailures, extractTestFailures } from './test-baseline.ts'

interface TestFailureBaseline {
  platform: NodeJS.Platform
  failures: string[]
}

const repoRoot = resolve(import.meta.dir, '..')
const baselinePath = resolve(repoRoot, '.github', 'test-baseline.windows.json')
const shouldUpdate = process.argv.includes('--update')

// Bun 的 module mock 与全局状态默认跨文件共享；本地双 worker 自动逐文件隔离。
// Windows CI runner 的 Git fixture 明显受磁盘与进程争用影响，串行执行可避免正常测试被拖过超时上限。
const testConcurrency = process.env.CI === 'true' ? '1' : '2'
const processHandle = Bun.spawn(['bun', 'test', `--parallel=${testConcurrency}`, `--max-concurrency=${testConcurrency}`], {
  cwd: repoRoot,
  env: process.env,
  stdout: 'pipe',
  stderr: 'pipe',
})
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(processHandle.stdout).text(),
  new Response(processHandle.stderr).text(),
  processHandle.exited,
])
process.stdout.write(stdout)
process.stderr.write(stderr)

const failures = extractTestFailures(stderr)
if (shouldUpdate) {
  const baseline: TestFailureBaseline = { platform: process.platform, failures }
  await Bun.write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`[测试基线] 已记录 ${failures.length} 个 ${process.platform} 失败项`)
  process.exit(0)
}

const baseline = await Bun.file(baselinePath).json() as TestFailureBaseline
if (baseline.platform !== process.platform) {
  console.error(`[测试基线] 平台不匹配：期望 ${baseline.platform}，实际 ${process.platform}`)
  process.exit(1)
}

const comparison = compareTestFailures(baseline.failures, failures, exitCode)
console.log(
  `[测试基线] 当前 ${failures.length} 项；已知 ${comparison.known.length} 项；` +
    `已消失 ${comparison.resolved.length} 项；新增 ${comparison.regressions.length} 项`,
)
if (comparison.resolved.length > 0) {
  console.log(`[测试基线] 已消失 ${comparison.resolved.length} 项：\n${comparison.resolved.map((failure) => `- ${failure}`).join('\n')}`)
}
if (comparison.regressions.length > 0) {
  console.error(`[测试基线] 发现新增失败：\n${comparison.regressions.map((failure) => `- ${failure}`).join('\n')}`)
  process.exit(1)
}
if (comparison.unexpectedNonzeroExit) {
  console.error(`[测试基线] bun test 以 ${exitCode} 退出，但未识别到可比对的失败项`)
  process.exit(1)
}
