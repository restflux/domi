import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTerminalCwd } from './terminal-cwd-policy.ts'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'domi-terminal-cwd-'))
  cleanup.push(path)
  return path
}

describe('terminal cwd policy', () => {
  test('accepts the canonical target root and descendants', () => {
    const root = tempRoot()
    const child = join(root, 'packages', 'app')
    mkdirSync(child, { recursive: true })
    expect(resolveTerminalCwd(root)).toBe(root)
    expect(resolveTerminalCwd(root, 'packages/app')).toBe(child)
  })

  test('accepts an explicitly authorized attached directory without widening to its siblings', () => {
    const root = tempRoot()
    const attachedParent = tempRoot()
    const attached = join(attachedParent, 'attached')
    const sibling = join(attachedParent, 'sibling')
    mkdirSync(attached, { recursive: true })
    mkdirSync(sibling, { recursive: true })

    expect(resolveTerminalCwd([root, attached], attached)).toBe(attached)
    expect(() => resolveTerminalCwd([root, attached], sibling)).toThrow('授权范围')
  })

  test('rejects lexical traversal outside the target root', () => {
    const root = tempRoot()
    expect(() => resolveTerminalCwd(root, '..')).toThrow('Session Target')
  })

  test('rejects a symlink or junction that resolves outside the target root', () => {
    const root = tempRoot()
    const outside = tempRoot()
    const link = join(root, 'outside-link')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolveTerminalCwd(root, link)).toThrow('Session Target')
  })
})
