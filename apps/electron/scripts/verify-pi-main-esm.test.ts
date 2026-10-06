import { describe, expect, test } from 'bun:test'
import { assertPiMainEsmBundle, inspectPiMainEsmBundle } from './verify-pi-main-esm'

describe('Pi main ESM loading contract', () => {
  test('accepts preserved dynamic imports for Pi ESM packages', () => {
    const result = assertPiMainEsmBundle(`
      const pi = await import('@earendil-works/pi-ai')
      const transcript = await import('@earendil-works/pi-ai/utils/transcript')
      await import('@earendil-works/pi-ai/compat')
    `)

    expect(result.staticRequires).toEqual([])
    expect(result.dynamicImports).toEqual([
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/utils/transcript',
    ])
  })

  test('rejects CommonJS require for Pi ESM packages', () => {
    expect(() => assertPiMainEsmBundle(`
      const pi = require('@earendil-works/pi-ai')
      const transcript = require('@earendil-works/pi-ai/utils/transcript')
    `)).toThrow('CommonJS 主进程不能静态 require Pi ESM 包')
  })

  test('reports missing dynamic imports without executing the bundle', () => {
    expect(inspectPiMainEsmBundle('const value = 1')).toEqual({
      staticRequires: [],
      dynamicImports: [],
    })
    expect(() => assertPiMainEsmBundle('const value = 1')).toThrow('缺少 Pi ESM dynamic import')
  })
})
