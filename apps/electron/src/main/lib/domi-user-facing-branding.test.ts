import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const BRAND_PATTERN = /\b(?:PROMA|Proma)\b/
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.swift', '.md'])

const ALLOWED_COMPATIBILITY_PATTERNS = [
  /@proma\//,
  /\bDomiPermissionMode\b/,
  /\bPROMA_PERMISSION_[A-Z_]+\b/,
  /\bPROMA_(?:SCHEDULED_RUN|AUTOMATION)\b/,
  /\b(?:registerDomiFilePath|isDomiPermissionMode)\b/,
]

function collectSourceFiles(rootPath: string): string[] {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(entryPath)
    if (entry.name.includes('.test.')) return []
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [entryPath] : []
  })
}

function findVisibleBrandResidue(filePaths: string[]): string[] {
  return filePaths.flatMap((filePath) => {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    return lines.flatMap((line, index) => {
      if (!BRAND_PATTERN.test(line)) return []
      if (ALLOWED_COMPATIBILITY_PATTERNS.some((pattern) => pattern.test(line))) return []
      return [`${relative(join(import.meta.dir, '../../../..'), filePath)}:${index + 1}: ${line.trim()}`]
    })
  })
}

describe('Domi 用户可见品牌边界', () => {
  test('正常产品界面、Agent Island 与打包教程不再展示 Proma 品牌', () => {
    const checkedFiles = [
      ...collectSourceFiles(join(import.meta.dir, '../../renderer/components')),
      ...collectSourceFiles(join(import.meta.dir, '../../../native/agent-island')),
      join(import.meta.dir, '../../../resources/tutorial.md'),
      join(import.meta.dir, '../ipc.ts'),
    ]

    expect(findVisibleBrandResidue(checkedFiles)).toEqual([])
  })
})
