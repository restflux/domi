import { describe, expect, test } from 'bun:test'
import { resolveChangedFileTerminalCwd } from './terminal-directory-routing.ts'

describe('terminal directory routing', () => {
  test('routes changed files to their project-relative parent directory', () => {
    expect(resolveChangedFileTerminalCwd('apps/electron/src/main.ts')).toBe('apps/electron/src')
    expect(resolveChangedFileTerminalCwd('README.md')).toBe('.')
    expect(resolveChangedFileTerminalCwd('apps\\electron\\package.json')).toBe('apps/electron')
  })

  test('rejects traversal and empty changed-file paths', () => {
    expect(() => resolveChangedFileTerminalCwd('../outside.txt')).toThrow('路径无效')
    expect(() => resolveChangedFileTerminalCwd('')).toThrow('路径无效')
  })
})
