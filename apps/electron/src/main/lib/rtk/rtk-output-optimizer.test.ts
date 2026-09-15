import { describe, expect, test } from 'bun:test'
import { optimizeRtkOutput, type RtkOptimizerDependencies } from './rtk-output-optimizer.ts'

const raw = 'modified: a.ts\n'.repeat(100)
function setup() {
  const saved: string[] = []
  const counted: number[][] = []
  const dependencies: RtkOptimizerDependencies = {
    filter: async () => '100 modified files',
    saveOriginal: async text => { saved.push(text); return '/session/rtk-output/raw.txt' },
    record: (before, after) => { counted.push([before, after]) },
  }
  return { saved, counted, dependencies }
}

describe('RTK 原始输出与回退', () => {
  test('Given 可压缩文本 When 优化 Then 保留完整原文并将引用开销计入统计', async () => {
    const { saved, counted, dependencies } = setup()
    const result = await optimizeRtkOutput('git-status', raw, dependencies)
    expect(saved).toEqual([raw])
    expect(result?.text).toContain('/session/rtk-output/raw.txt')
    expect(counted).toEqual([[Buffer.byteLength(raw), Buffer.byteLength(result!.text)]])
  })
  test('Given 无收益、异常或保存失败 When 优化 Then 返回原路径的信号且不记成功', async () => {
    for (const mode of ['no-gain', 'empty', 'filter-error', 'save-error', 'control']) {
      const { counted, dependencies } = setup()
      if (mode === 'no-gain') dependencies.filter = async () => raw
      if (mode === 'empty') dependencies.filter = async () => ''
      if (mode === 'filter-error') dependencies.filter = async () => { throw new Error('failed') }
      if (mode === 'save-error') dependencies.saveOriginal = async () => { throw new Error('disk full') }
      if (mode === 'control') dependencies.filter = async () => '\u0000bad'
      expect(await optimizeRtkOutput('git-status', raw, dependencies)).toBeUndefined()
      expect(counted).toEqual([])
    }
  })
  test('Given filter 或保存完成后权限撤销 When 返回 Then 不采用优化结果或增加统计', async () => {
    for (const stage of ['filter', 'save']) {
      const { dependencies, counted, saved } = setup()
      let allowed = true
      dependencies.isActive = () => allowed
      if (stage === 'filter') dependencies.filter = async () => { allowed = false; return 'short' }
      else dependencies.saveOriginal = async () => { allowed = false; return '/session/raw.txt' }
      expect(await optimizeRtkOutput('git-status', raw, dependencies)).toBeUndefined()
      expect(counted).toEqual([])
      expect(saved).toEqual([])
    }
  })
  test('Given 已取消或输出超限 When 优化 Then 不调用过滤器或写文件', async () => {
    const { dependencies, saved } = setup()
    let filters = 0
    dependencies.filter = async () => { filters++; return 'short' }
    const controller = new AbortController()
    controller.abort()
    expect(await optimizeRtkOutput('git-status', raw, dependencies, controller.signal)).toBeUndefined()
    expect(await optimizeRtkOutput('git-status', 'x'.repeat(50 * 1024), dependencies)).toBeUndefined()
    expect(filters).toBe(0)
    expect(saved).toEqual([])
  })
  test('Given 小于 1KB 且实际可节省 When 优化 Then 不再受固定门槛排除', async () => {
    const { dependencies, counted } = setup()
    const result = await optimizeRtkOutput('git-log', 'x'.repeat(240), dependencies)
    expect(result).toBeDefined()
    expect(counted).toHaveLength(1)
  })
  test('Given 长原文路径抵消收益 When 优化 Then 保存前按实际引用预算回退', async () => {
    const { dependencies, saved } = setup()
    const reasons: string[] = []
    dependencies.originalPathHint = '/session/' + '路径'.repeat(120) + '/raw.txt'
    dependencies.skip = reason => { reasons.push(reason) }
    expect(await optimizeRtkOutput('git-log', 'x'.repeat(500), dependencies)).toBeUndefined()
    expect(saved).toEqual([])
    expect(reasons).toEqual(['no-gain'])
  })

})
