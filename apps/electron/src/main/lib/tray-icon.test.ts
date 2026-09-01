import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { resolveTrayIconPath } from './tray-icon'

describe('托盘图标平台选择', () => {
  const resourcesDir = join('test', 'resources')

  it('Windows 使用彩色品牌图标', () => {
    expect(resolveTrayIconPath(resourcesDir, 'win32')).toBe(join(resourcesDir, 'icon.png'))
  })

  it('Linux 使用彩色品牌图标', () => {
    expect(resolveTrayIconPath(resourcesDir, 'linux')).toBe(join(resourcesDir, 'icon.png'))
  })

  it('macOS 使用系统 Template 图标', () => {
    expect(resolveTrayIconPath(resourcesDir, 'darwin')).toBe(
      join(resourcesDir, 'domi-logos', 'iconTemplate.png')
    )
  })
})
