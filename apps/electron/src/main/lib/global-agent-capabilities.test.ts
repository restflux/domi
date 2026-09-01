import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeEffectiveMcpConfig,
  mergeEffectiveSkills,
  readGlobalAgentCapabilities,
  readPiGlobalMcpConfig,
  scanGlobalSkills,
  type GlobalCapabilityPaths,
} from './global-agent-capabilities'
import type { SkillMeta, WorkspaceMcpConfig } from '@domi/shared'

let root = ''
let paths: GlobalCapabilityPaths

function writeSkill(parent: string, slug: string, name = slug, description = `${name} description`): string {
  const dir = join(parent, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`, 'utf-8')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'domi-global-capabilities-'))
  paths = {
    piSkillsDir: join(root, '.pi', 'agent', 'skills'),
    agentsSkillsDir: join(root, '.agents', 'skills'),
    claudeSkillsDir: join(root, '.claude', 'skills'),
    piMcpPath: join(root, '.pi', 'agent', 'mcp.json'),
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('外部全局 Skill 扫描', () => {
  test('Given 三个来源包含同名项 When 扫描 Then 按 Pi、Agent Skills、Claude 顺序取第一个', () => {
    writeSkill(paths.piSkillsDir, 'shared', 'shared', 'pi winner')
    writeSkill(paths.agentsSkillsDir, 'shared', 'shared', 'agents loser')
    writeSkill(paths.claudeSkillsDir, 'claude-only')

    const result = scanGlobalSkills(paths)

    expect(result.skills.map((skill) => [skill.slug, skill.origin])).toEqual([
      ['shared', 'pi-global'],
      ['claude-only', 'claude-global'],
    ])
    expect(result.skills[0]?.description).toBe('pi winner')
    expect(result.diagnostics.some((message) => message.includes('shared') && message.includes('冲突'))).toBe(true)
  })

  test('Given 两个来源通过 symlink 指向同一目录 When 扫描 Then canonical realpath 去重', () => {
    const source = writeSkill(paths.piSkillsDir, 'linked')
    mkdirSync(paths.agentsSkillsDir, { recursive: true })
    symlinkSync(source, join(paths.agentsSkillsDir, 'linked-copy'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = scanGlobalSkills(paths)

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.origin).toBe('pi-global')
  })

  test('Given 来源根内链接指向根外 When 扫描 Then 不读取越界 Skill', () => {
    const outside = writeSkill(join(root, 'outside'), 'escaped')
    mkdirSync(paths.piSkillsDir, { recursive: true })
    symlinkSync(outside, join(paths.piSkillsDir, 'escaped-link'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = scanGlobalSkills(paths)

    expect(result.skills).toHaveLength(0)
    expect(result.diagnostics.some((message) => message.includes('来源目录外'))).toBe(true)
  })

  test('Given Skill 缺少 description When 扫描 Then 跳过并返回诊断', () => {
    const dir = join(paths.piSkillsDir, 'invalid')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: invalid\n---\n', 'utf-8')

    const result = scanGlobalSkills(paths)

    expect(result.skills).toHaveLength(0)
    expect(result.diagnostics.some((message) => message.includes('description'))).toBe(true)
  })
})

describe('Pi 全局 MCP 读取', () => {
  test('Given Pi mcp.json 含顶层服务器和 imports When 读取 Then 规范化服务器并明确 imports 未跟随', () => {
    mkdirSync(join(root, '.pi', 'agent'), { recursive: true })
    writeFileSync(paths.piMcpPath, JSON.stringify({
      imports: ['claude-code'],
      mcpServers: {
        docs: { url: 'https://example.com/mcp', lifecycle: 'eager', directTools: true, trustReadOnlyAnnotations: true },
        exa: { url: 'https://mcp.exa.ai/mcp' },
        local: { command: 'node', args: ['server.js'], environment: { TOKEN: 'secret' }, timeout: 1e12 },
      },
    }), 'utf-8')

    const result = readPiGlobalMcpConfig(paths.piMcpPath)

    expect(result.config.servers.docs).toMatchObject({
      type: 'http', url: 'https://example.com/mcp', enabled: true, trustReadOnlyAnnotations: true,
    })
    expect(result.config.servers.exa).toMatchObject({
      type: 'http', url: 'https://mcp.exa.ai/mcp', enabled: true, trustReadOnlyAnnotations: true,
    })
    expect(result.config.servers.local).toMatchObject({ type: 'stdio', command: 'node', env: { TOKEN: 'secret' }, enabled: true, timeout: 60 })
    expect(JSON.stringify(result.servers)).not.toContain('secret')
    expect(JSON.stringify(result.servers)).not.toContain('server.js')
    expect(result.diagnostics.some((message) => message.includes('imports') && message.includes('claude-code'))).toBe(true)
    expect(result.diagnostics.some((message) => message.includes('timeout') && message.includes('60'))).toBe(true)
  })
})

describe('项目能力覆盖', () => {
  test('Given 项目 active 或 inactive Skill 与全局同名 When 合并 Then 项目记录压住全局回退', () => {
    const globalSkills: SkillMeta[] = [
      { slug: 'review', name: 'review', description: 'global', enabled: true, origin: 'pi-global', readOnly: true },
      { slug: 'research', name: 'research', description: 'global', enabled: true, origin: 'pi-global', readOnly: true },
    ]
    const workspaceSkills: SkillMeta[] = [
      { slug: 'review', name: 'review', description: 'workspace', enabled: true },
      { slug: 'research', name: 'research', description: 'inactive workspace', enabled: false },
    ]

    const effective = mergeEffectiveSkills(workspaceSkills, globalSkills, true)

    expect(effective).toEqual(workspaceSkills)
  })

  test('Given 项目 disabled MCP 与全局同名 When 合并 Then disabled 项目配置阻止全局服务器启用', () => {
    const globalConfig: WorkspaceMcpConfig = {
      servers: { docs: { type: 'http', url: 'https://global.example/mcp', enabled: true } },
    }
    const workspaceConfig: WorkspaceMcpConfig = {
      servers: { docs: { type: 'http', url: 'https://project.example/mcp', enabled: false } },
    }

    const effective = mergeEffectiveMcpConfig(globalConfig, workspaceConfig, true)

    expect(effective.servers.docs).toEqual(workspaceConfig.servers.docs)
  })

  test('Given 两个全局开关关闭 When 读取摘要 Then 仍报告检测项但 effective merge 不继承', () => {
    writeSkill(paths.piSkillsDir, 'research')
    mkdirSync(join(root, '.pi', 'agent'), { recursive: true })
    writeFileSync(paths.piMcpPath, JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }), 'utf-8')

    const summary = readGlobalAgentCapabilities(paths, {
      externalGlobalSkillsEnabled: false,
      piGlobalMcpEnabled: false,
    })

    expect(summary.detectedSkills).toHaveLength(1)
    expect(summary.detectedMcpServers).toHaveLength(1)
    expect(mergeEffectiveSkills([], summary.detectedSkills, summary.skillsEnabled)).toEqual([])
    expect(mergeEffectiveMcpConfig({ servers: { docs: { type: 'http', url: 'https://example.com/mcp', enabled: true } } }, { servers: {} }, summary.mcpEnabled)).toEqual({ servers: {} })
  })
})
