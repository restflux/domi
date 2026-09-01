import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  copyForkWorkspaceFiles,
  copyRequiredForkSessionContext,
  shouldCopyForkWorkspacePath,
} from './agent-fork-workspace-copy'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'domi-fork-copy-'))
  tempRoots.push(root)
  return root
}

function writeFile(path: string, content = 'x'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!
    rmSync(root, { recursive: true, force: true })
  }
})

describe('fork 工作区复制', () => {
  test('Given 会话目录包含上下文和依赖目录 When 复制 fork 工作区 Then 保留 .context 并跳过高风险目录', () => {
    const root = makeTempRoot()
    const sourceDir = join(root, 'source')
    const destDir = join(root, 'dest')

    writeFile(join(sourceDir, '.context', 'note.md'), 'keep')
    writeFile(join(sourceDir, '.claude', 'settings.json'), '{}')
    writeFile(join(sourceDir, 'node_modules', 'pkg', 'index.js'))
    writeFile(join(sourceDir, '.venv', 'pyvenv.cfg'))
    writeFile(join(sourceDir, 'dist', 'bundle.js'))
    writeFile(join(sourceDir, 'src', 'index.ts'), 'export {}')
    writeFile(join(sourceDir, 'nested-repo', '.git', 'config'))
    writeFile(join(sourceDir, 'nested-repo', 'src', 'file.ts'), 'export const ok = true')

    expect(copyRequiredForkSessionContext(sourceDir, destDir)).toBe(true)
    const result = copyForkWorkspaceFiles(sourceDir, destDir, { skipSessionContext: true })

    expect(result.copiedCount).toBe(2)
    expect(result.skippedCount).toBe(5)
    expect(result.failedCount).toBe(0)
    expect(existsSync(join(destDir, '.context', 'note.md'))).toBe(true)
    expect(existsSync(join(destDir, 'src', 'index.ts'))).toBe(true)
    expect(existsSync(join(destDir, 'nested-repo', 'src', 'file.ts'))).toBe(true)
    expect(existsSync(join(destDir, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(destDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(destDir, '.venv'))).toBe(false)
    expect(existsSync(join(destDir, 'dist'))).toBe(false)
    expect(existsSync(join(destDir, 'nested-repo', '.git'))).toBe(false)
  })

  test('Given 新 Pi 会话初始化了空 .context When 必需上下文迁移 Then 原子替换为空目录并保留源内容', () => {
    const root = makeTempRoot()
    const sourceDir = join(root, 'source')
    const destDir = join(root, 'dest')
    writeFile(join(sourceDir, '.context', 'note.md'), 'source')
    mkdirSync(join(destDir, '.context'), { recursive: true })

    expect(copyRequiredForkSessionContext(sourceDir, destDir)).toBe(true)
    expect(readFileSync(join(destDir, '.context', 'note.md'), 'utf8')).toBe('source')
    expect(readdirSync(destDir).some((name) => name.startsWith('.context.fork-staging-'))).toBe(false)
  })

  test('Given 目标 .context 已有内容 When 必需上下文迁移 Then 拒绝覆盖且不留下 staging', () => {
    const root = makeTempRoot()
    const sourceDir = join(root, 'source')
    const destDir = join(root, 'dest')
    writeFile(join(sourceDir, '.context', 'note.md'), 'source')
    writeFile(join(destDir, '.context', 'note.md'), 'existing')

    expect(() => copyRequiredForkSessionContext(sourceDir, destDir)).toThrow('拒绝覆盖')
    expect(readFileSync(join(destDir, '.context', 'note.md'), 'utf8')).toBe('existing')
    expect(readdirSync(destDir).some((name) => name.startsWith('.context.fork-staging-'))).toBe(false)
  })

  test('Given 路径是会话上下文或依赖目录 When 判断是否复制 Then 只放行上下文', () => {
    expect(shouldCopyForkWorkspacePath('/tmp/session/.context')).toBe(true)
    expect(shouldCopyForkWorkspacePath('/tmp/session/.claude')).toBe(false)
    expect(shouldCopyForkWorkspacePath('/tmp/session/node_modules')).toBe(false)
    expect(shouldCopyForkWorkspacePath('/tmp/session/.git')).toBe(false)
  })
})
