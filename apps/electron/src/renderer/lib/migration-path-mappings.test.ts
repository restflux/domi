import { expect, test } from 'bun:test'
import { initialMigrationPathMappings } from './migration-path-mappings.ts'

test('Given 备份包含存在或不存在的路径 When 初始化导入 Then 全部等待用户手动选择', () => {
  expect(initialMigrationPathMappings([
    { path: 'C:\\Users\\Alice\\Documents', exists: true },
    { path: '/Users/alice/existing', exists: true },
    { path: 'D:\\missing', exists: false },
  ])).toEqual({
    'C:\\Users\\Alice\\Documents': null,
    '/Users/alice/existing': null,
    'D:\\missing': null,
  })
})
