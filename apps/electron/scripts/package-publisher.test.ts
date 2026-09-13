import { describe, expect, test } from 'bun:test'
import manifest from '../package.json'
import rootManifest from '../../../package.json'

// NSIS 默认从应用 author.name 生成卸载项 Publisher，不应复用上游作者身份。
describe('安装包发布者元数据', () => {
  test('Given Domi 应用清单 When 打包读取作者 Then 发布者为 Wlait 且不使用上游邮箱', () => {
    expect(manifest.author).toEqual({ name: 'Wlait', email: 'hi@restflux.com' })
  })

  test('Given 发布者修正版 When 读取应用版本 Then 根清单与 Electron 清单一致', () => {
    expect(manifest.version).toBe(rootManifest.version)
  })
})
