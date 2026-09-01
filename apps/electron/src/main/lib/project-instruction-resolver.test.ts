import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTrustedProjectInstruction, resolveTrustedWorkspaceInstruction } from './project-instruction-resolver'

const roots: string[] = []

function createRoot(prefix = 'domi-project-instruction-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Domi 受管 AGENTS.md 注入', () => {
  test('Given 普通工作区 AGENTS.md When 解析 Then 返回正文与 hash', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Workspace\n', 'utf-8')

    const result = resolveTrustedWorkspaceInstruction(path)

    expect(result.source).toMatchObject({ absolutePath: path, content: '# Workspace\n' })
    expect(result.source?.contentHash).toHaveLength(64)
  })

  test('Given 工作区迁移失败仅保留 legacy CLAUDE.md When 解析 Then 继续只读兼容注入', () => {
    const root = createRoot()
    const legacyPath = join(root, 'CLAUDE.md')
    writeFileSync(legacyPath, '# Legacy workspace\n', 'utf-8')

    const result = resolveTrustedWorkspaceInstruction(join(root, 'AGENTS.md'), legacyPath)

    expect(result.source).toMatchObject({ kind: 'claude', absolutePath: legacyPath, content: '# Legacy workspace\n' })
    expect(result.diagnostics.join('\n')).toContain('迁移尚未完成')
  })

  test('Given 工作区 AGENTS.md 是符号链接 When 解析 Then 拒绝注入', () => {
    const root = createRoot()
    const target = join(root, 'target')
    mkdirSync(target)
    symlinkSync(target, join(root, 'AGENTS.md'), 'junction')

    const result = resolveTrustedWorkspaceInstruction(join(root, 'AGENTS.md'))

    expect(result.source).toBeUndefined()
    expect(result.diagnostics.join('\n')).toContain('不是普通文件')
  })
})

describe('受信 Session Target 项目根指令', () => {
  test('Given 项目根 AGENTS.md When 解析 Then 返回经过验证的绝对路径和正文', () => {
    const root = createRoot()
    writeFileSync(join(root, 'AGENTS.md'), '# Project rules\n', 'utf-8')

    const result = resolveTrustedProjectInstruction(root)

    expect(result.source).toMatchObject({
      kind: 'agents',
      relativePath: 'AGENTS.md',
      content: '# Project rules\n',
    })
    expect(result.source?.absolutePath).toBe(join(root, 'AGENTS.md'))
    expect(result.projectRoot).toBe(root)
    expect(result.diagnostics).toEqual([])
  })

  test('Given 同根双文件 When 解析 Then AGENTS.md 胜出且不改写 legacy 文件', () => {
    const root = createRoot()
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n', 'utf-8')
    writeFileSync(join(root, 'CLAUDE.md'), '# Legacy\n', 'utf-8')

    const result = resolveTrustedProjectInstruction(root)

    expect(result.source?.kind).toBe('agents')
    expect(result.source?.content).toBe('# Agents\n')
    expect(result.diagnostics.join('\n')).toContain('CLAUDE.md')
  })

  test('Given 仅有 legacy CLAUDE.md When 解析 Then 作为只读兼容来源', () => {
    const root = createRoot()
    writeFileSync(join(root, 'CLAUDE.md'), '# Legacy\n', 'utf-8')

    const result = resolveTrustedProjectInstruction(root)

    expect(result.source).toMatchObject({ kind: 'claude', relativePath: 'CLAUDE.md', content: '# Legacy\n' })
  })

  test('Given 父目录和附加目录含指令 When 解析当前根 Then 不做祖先或附加目录发现', () => {
    const parent = createRoot('domi-project-parent-')
    const root = join(parent, 'checkout')
    const additional = createRoot('domi-project-additional-')
    mkdirSync(root)
    writeFileSync(join(parent, 'AGENTS.md'), '# Parent\n', 'utf-8')
    writeFileSync(join(additional, 'AGENTS.md'), '# Additional\n', 'utf-8')

    const result = resolveTrustedProjectInstruction(root)

    expect(result.source).toBeUndefined()
    expect(result.projectRoot).toBe(root)
  })

  test('Given 高优先级 AGENTS.md 是目录 When 解析 Then 不静默暴露 CLAUDE.md', () => {
    const root = createRoot()
    mkdirSync(join(root, 'AGENTS.md'))
    writeFileSync(join(root, 'CLAUDE.md'), '# Legacy\n', 'utf-8')

    const result = resolveTrustedProjectInstruction(root)

    expect(result.source).toBeUndefined()
    expect(result.diagnostics.join('\n')).toContain('普通文件')
  })

  test('Given AGENTS.md 符号链接越过项目根 When 解析 Then 拒绝读取', () => {
    const parent = createRoot('domi-project-link-parent-')
    const root = join(parent, 'checkout')
    const outside = join(parent, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'content.md'), '# Outside\n', 'utf-8')
    symlinkSync(outside, join(root, 'AGENTS.md'), 'junction')

    const result = resolveTrustedProjectInstruction(root)

    expect(result.source).toBeUndefined()
    expect(result.diagnostics.join('\n')).toContain('授权项目根之外')
  })

  test('Given 项目指令超过注入上限 When 解析 Then 返回诊断而不注入正文', () => {
    const root = createRoot()
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 1), 'utf-8')

    const result = resolveTrustedProjectInstruction(root)

    expect(result.source).toBeUndefined()
    expect(result.diagnostics.join('\n')).toContain('64 KB')
  })
})
