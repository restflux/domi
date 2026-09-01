import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import { resolveConfigDir } from './paths.ts'

describe('Domi CLI 会话路径', () => {
  test('Given 默认运行 When 解析配置目录 Then 读取 Domi 正式版数据', () => {
    expect(basename(resolveConfigDir())).toBe('.domi')
  })

  test('Given 开发模式 When 解析配置目录 Then 读取 Domi 开发数据', () => {
    expect(basename(resolveConfigDir({ dev: true }))).toBe('.domi-dev')
  })
})
