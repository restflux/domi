import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResolvedHtmlPreviewPath, createResolvedPreviewPath } from './resolved-preview-path'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'domi-resolved-preview-path-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('createResolvedPreviewPath', () => {
  test('Given an authorized directory When resolving a message path Then it remains a valid directory target without file URL registration', () => {
    const directoryPath = makeTempRoot()
    let registerCalls = 0

    const result = createResolvedPreviewPath(directoryPath, () => {
      registerCalls += 1
      throw new Error('directories cannot be registered as files')
    })

    expect(result).toEqual({ kind: 'directory' })
    expect(registerCalls).toBe(0)
  })

  test('Given an authorized file When resolving a message path Then it returns the registered preview URL', () => {
    const root = makeTempRoot()
    const filePath = join(root, 'report.md')
    writeFileSync(filePath, '# report', 'utf8')

    const result = createResolvedPreviewPath(filePath, (resolvedPath) => `domi-file://${resolvedPath}`)

    expect(result).toEqual({ kind: 'file', url: `domi-file://${filePath}` })
  })

  test('Given an authorized HTML file When resolving its preview Then the containing directory is registered and the encoded filename stays relative', () => {
    const root = makeTempRoot()
    const filePath = join(root, '演示 page.html')
    writeFileSync(filePath, '<!doctype html>', 'utf8')
    const registeredDirectories: string[] = []

    const result = createResolvedHtmlPreviewPath(filePath, (directoryPath) => {
      registeredDirectories.push(directoryPath)
      return 'domi-file://opaque-token'
    })

    expect(registeredDirectories).toEqual([root])
    expect(result).toEqual({
      kind: 'file',
      url: 'domi-file://opaque-token/%E6%BC%94%E7%A4%BA%20page.html',
    })
  })
})
