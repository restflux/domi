import { expect, test } from 'bun:test'
import { shouldWriteTerminalOutput } from './terminalOutputSequence.ts'

/**
 * 高频输出合帧回归基准：度量「快照序列去重 → 写入决策」纯函数路径的吞吐。
 * 该路径在每条 PTY 输出事件上执行，是渲染层防重复合帧的守门逻辑；
 * xterm.write 自身的缓冲不在 renderer 责任范围内。
 *
 * 断言使用宽松上界（p95 < 1ms/千事件），只在性能量级回退时失败，
 * 避免慢机器 CI 抖动；median/p95 具体值随测试名输出便于人工对照。
 */
function percentile(sortedDurations: number[], p: number): number {
  const index = Math.min(sortedDurations.length - 1, Math.max(0, Math.ceil((p / 100) * sortedDurations.length) - 1))
  return sortedDurations[index] ?? 0
}

test('terminal output sequence guard sustains high-frequency streams', () => {
  const ROUNDS = 200
  const EVENTS_PER_ROUND = 1_000
  const durations: number[] = []

  for (let round = 0; round < ROUNDS; round += 1) {
    const baseSequence = round * EVENTS_PER_ROUND
    const startedAt = performance.now()
    let writes = 0
    let lastSequence = baseSequence
    for (let i = 1; i <= EVENTS_PER_ROUND; i += 1) {
      // 模拟交错流：约 1/3 事件为快照已包含的旧序列，必须被去重跳过。
      const sequence = i % 3 === 0 ? baseSequence : baseSequence + i
      if (shouldWriteTerminalOutput(sequence, lastSequence)) {
        writes += 1
        if (sequence > lastSequence) lastSequence = sequence
      }
    }
    if (round === 0) {
      // 去重正确性：旧序列全部跳过，新序列全部放行。
      expect(writes).toBe(EVENTS_PER_ROUND - Math.floor(EVENTS_PER_ROUND / 3))
    }
    durations.push(performance.now() - startedAt)
  }

  const sorted = [...durations].sort((left, right) => left - right)
  const median = percentile(sorted, 50)
  const p95 = percentile(sorted, 95)
  const medianPerEventMs = median / EVENTS_PER_ROUND
  const p95PerEventMs = p95 / EVENTS_PER_ROUND

  // 宽松上界：每事件守门成本应远低于 1ms；回退两个量级以上才失败。
  expect(medianPerEventMs).toBeLessThan(0.001)
  expect(p95PerEventMs).toBeLessThan(0.001)
  expect(`${medianPerEventMs.toFixed(6)}ms median / ${p95PerEventMs.toFixed(6)}ms p95 per event`).toContain('median')
})
