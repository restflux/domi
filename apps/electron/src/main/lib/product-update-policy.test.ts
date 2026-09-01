import { describe, expect, test } from 'bun:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

describe('Domi 更新策略', () => {
  test('Given Domi 主进程入口 When 生成生产 bundle Then 官方 updater 不可达', async () => {
    const result = await build({
      entryPoints: [resolve(import.meta.dir, '..', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      metafile: true,
      external: [
        'electron',
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-ai',
      ],
    })

    const bundledInputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll('\\', '/'))
    expect(bundledInputs.some((path) => path.includes('/lib/updater/'))).toBe(false)
  }, 20_000)
})
