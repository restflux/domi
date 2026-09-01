import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import type { DefaultSkillsManifest } from './default-skill-lifecycle.ts'

type AgentWorkspaceManager = typeof import('./agent-workspace-manager')
type ConfigPathsModule = typeof import('./config-paths')
type DefaultSkillLifecycleModule = typeof import('./default-skill-lifecycle.ts')

let manager: AgentWorkspaceManager
let configPaths: ConfigPathsModule
let defaultSkillLifecycle: DefaultSkillLifecycleModule
let tempHome: string
const originalHome = process.env.HOME
const originalDomiDev = process.env.DOMI_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'domi-agent-workspace-manager-'))
  process.env.HOME = tempHome
  process.env.DOMI_DEV = '0'
  configPaths = await import('./config-paths')
  defaultSkillLifecycle = await import('./default-skill-lifecycle.ts')
  manager = await import('./agent-workspace-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.domi'), { recursive: true, force: true })
  mkdirSync(join(tempHome, '.domi'), { recursive: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalDomiDev === undefined) {
    delete process.env.DOMI_DEV
  } else {
    process.env.DOMI_DEV = originalDomiDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

function writeBundledSkill(bundledDir: string, slug: string, version: string, body: string): void {
  const skillDir = join(bundledDir, slug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${slug}\nversion: "${version}"\n---\n${body}\n`, 'utf-8')
}

function writeWorkspaceSkill(workspaceSlug: string, skillSlug: string, name: string): void {
  const skillDir = join(configPaths.getWorkspaceSkillsDir(workspaceSlug), skillSlug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8')
}

describe('Agent 工作区 MCP 配置', () => {
  test('Given 工作区 MCP 包含内置保留名 When 归一化配置 Then 剔除冲突项并保留普通服务器', () => {
    const normalized = manager.normalizeWorkspaceMcpConfig({
      servers: {
        automation: {
          type: 'stdio',
          command: 'custom-automation',
          enabled: true,
        },
        nano_banana: {
          type: 'stdio',
          command: 'custom-nano',
          enabled: true,
        },
        github: {
          type: 'stdio',
          command: 'github-mcp',
          enabled: true,
        },
      },
    })

    expect(Object.keys(normalized.servers).sort()).toEqual(['github'])
    expect(normalized.servers.github?.command).toBe('github-mcp')
  })
})

describe('项目术语迁移', () => {
  test('Given 新安装 When 创建默认项目 Then 使用项目名称', () => {
    const workspace = manager.ensureDefaultWorkspace()

    expect(workspace.name).toBe('默认项目')
  })
})

describe('Domi 工作区 AGENTS.md 迁移', () => {
  test('Given 存量工作区仅有 CLAUDE.md When 启动初始化 Then 自动迁移所有受管工作区', () => {
    const workspace = manager.createAgentWorkspace('Existing Project')
    const root = configPaths.getAgentWorkspacePath(workspace.slug)
    writeFileSync(join(root, 'CLAUDE.md'), '# Existing\n', 'utf-8')

    manager.ensureDefaultWorkspace()

    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe('# Existing\n')
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
  })

  test('Given 仅有普通 legacy CLAUDE.md When 迁移 Then 原文移动到 AGENTS.md 且重复执行幂等', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const root = configPaths.getAgentWorkspacePath(workspace.slug)
    const legacyPath = join(root, 'CLAUDE.md')
    const agentsPath = join(root, 'AGENTS.md')
    writeFileSync(legacyPath, '# Stable rules\n', 'utf-8')

    const first = manager.migrateWorkspaceInstructionFiles()
    const second = manager.migrateWorkspaceInstructionFiles()

    expect(first).toContainEqual(expect.objectContaining({ workspaceSlug: workspace.slug, status: 'migrated' }))
    expect(second).toContainEqual(expect.objectContaining({ workspaceSlug: workspace.slug, status: 'ready' }))
    expect(existsSync(legacyPath)).toBe(false)
    expect(readFileSync(agentsPath, 'utf-8')).toBe('# Stable rules\n')
  })

  test('Given AGENTS.md 与 CLAUDE.md 内容相同 When 迁移 Then 只清理重复 legacy 文件', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const root = configPaths.getAgentWorkspacePath(workspace.slug)
    writeFileSync(join(root, 'AGENTS.md'), '# Same\n', 'utf-8')
    writeFileSync(join(root, 'CLAUDE.md'), '# Same\n', 'utf-8')

    const reports = manager.migrateWorkspaceInstructionFiles()

    expect(reports).toContainEqual(expect.objectContaining({ workspaceSlug: workspace.slug, status: 'duplicate_removed' }))
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe('# Same\n')
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
  })

  test('Given 双文件内容不同 When 迁移 Then 两份完整保留并在摘要中公开冲突', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const root = configPaths.getAgentWorkspacePath(workspace.slug)
    writeFileSync(join(root, 'AGENTS.md'), '# New\n', 'utf-8')
    writeFileSync(join(root, 'CLAUDE.md'), '# Legacy\n', 'utf-8')

    const reports = manager.migrateWorkspaceInstructionFiles()
    const summary = manager.getWorkspaceMemorySummary(workspace.slug)

    expect(reports).toContainEqual(expect.objectContaining({ workspaceSlug: workspace.slug, status: 'conflict' }))
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe('# New\n')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe('# Legacy\n')
    expect(summary.instructionMigration).toMatchObject({ status: 'conflict' })
    expect(summary.agentsMd.path).toBe(join(root, 'AGENTS.md'))
    expect(summary.legacyClaudeMd?.exists).toBe(true)
  })

  test('Given legacy 指令是符号链接或目录 When 迁移 Then 不跟随也不破坏原路径', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const root = configPaths.getAgentWorkspacePath(workspace.slug)
    const outside = join(tempHome, 'outside-instructions')
    mkdirSync(outside)
    writeFileSync(join(outside, 'content.md'), '# Outside\n', 'utf-8')
    symlinkSync(outside, join(root, 'CLAUDE.md'), 'junction')

    const linkedReports = manager.migrateWorkspaceInstructionFiles()

    expect(linkedReports).toContainEqual(expect.objectContaining({ workspaceSlug: workspace.slug, status: 'blocked' }))
    expect(readFileSync(join(outside, 'content.md'), 'utf-8')).toBe('# Outside\n')
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)

    unlinkSync(join(root, 'CLAUDE.md'))
    mkdirSync(join(root, 'CLAUDE.md'))
    const directoryReports = manager.migrateWorkspaceInstructionFiles()

    expect(directoryReports).toContainEqual(expect.objectContaining({ workspaceSlug: workspace.slug, status: 'blocked' }))
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
  })

  test('Given 复制后删除 legacy 失败 When 迁移 Then 回滚目标并完整保留原文件', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const root = configPaths.getAgentWorkspacePath(workspace.slug)
    const legacyPath = join(root, 'CLAUDE.md')
    writeFileSync(legacyPath, '# Keep me\n', 'utf-8')

    const report = manager.migrateWorkspaceInstructionFile(workspace.slug, {
      removeFile: (path) => {
        if (path === legacyPath) throw new Error('simulated lock')
        rmSync(path, { force: true })
      },
    })

    expect(report.status).toBe('failed')
    expect(readFileSync(legacyPath, 'utf-8')).toBe('# Keep me\n')
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
  })

  test('Given 新主文件 API 与历史别名 When 读写 Then 都操作 AGENTS.md', () => {
    const workspace = manager.ensureDefaultWorkspace()

    manager.writeWorkspaceAgentsMd(workspace.slug, '# Agents\n')
    expect(manager.readWorkspaceAgentsMd(workspace.slug).relativePath).toBe('AGENTS.md')
    expect(manager.readWorkspaceClaudeMd(workspace.slug).content).toBe('# Agents\n')

    manager.writeWorkspaceClaudeMd(workspace.slug, '# Compatible\n')
    expect(manager.readWorkspaceAgentsMd(workspace.slug).content).toBe('# Compatible\n')
  })
})

describe('Agent 工作区创建', () => {
  test('Given 项目名称是 Windows 保留设备名 When 创建工作区 Then slug 避免直接使用保留名', () => {
    const workspace = manager.createAgentWorkspace('CON')

    expect(workspace.slug).toBe('workspace-con')
    expect(existsSync(configPaths.getAgentWorkspacePath(workspace.slug))).toBe(true)
  })

  test('Given Domi 托管项目 When 解析可打开文件夹 Then 返回已创建的 workspace-files 目录', () => {
    const workspace = manager.createAgentWorkspace('Managed Folder')

    expect(manager.resolveAgentWorkspaceProjectFolder(workspace.id)).toBe(
      configPaths.getWorkspaceFilesDir(workspace.slug),
    )
  })

  test('Given 本地项目文件夹已被移走 When 解析可打开文件夹 Then 给出可恢复提示', () => {
    const projectRoot = join(tempHome, 'local-project')
    mkdirSync(projectRoot, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: 'Missing Folder', projectRootPath: projectRoot })
    rmSync(projectRoot, { recursive: true, force: true })

    expect(() => manager.resolveAgentWorkspaceProjectFolder(workspace.id)).toThrow(
      '项目文件夹不存在，请重新选择或恢复项目文件夹',
    )
  })

  test('Given 默认 Skill 包含 blocklist 目录 When 创建工作区 Then 初始化 Skills 时跳过高风险目录', () => {
    const defaultSkillDir = join(configPaths.getDefaultSkillsDir(), 'sample-skill')
    mkdirSync(join(defaultSkillDir, '.git', 'objects'), { recursive: true })
    mkdirSync(join(defaultSkillDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(defaultSkillDir, 'SKILL.md'), '---\nname: Sample\n---\n', 'utf-8')
    writeFileSync(join(defaultSkillDir, '.git', 'objects', 'locked'), 'skip', 'utf-8')
    writeFileSync(join(defaultSkillDir, 'node_modules', 'pkg', 'index.js'), 'skip', 'utf-8')

    const workspace = manager.createAgentWorkspace('Filtered Copy')
    const copiedSkillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample-skill')

    expect(existsSync(join(copiedSkillDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(copiedSkillDir, '.git'))).toBe(false)
    expect(existsSync(join(copiedSkillDir, 'node_modules'))).toBe(false)
  })
})

describe('默认 Skill 安全升级与删除意图', () => {
  const rewrittenDocumentSkillSlugs = ['docx', 'pdf', 'pptx', 'xlsx'] as const

  function createBundle(): string {
    const bundledDir = join(tempHome, 'bundled-default-skills')
    rmSync(bundledDir, { recursive: true, force: true })
    mkdirSync(bundledDir, { recursive: true })
    return bundledDir
  }

  test('Given document Skills are independently rewritten When bundle is distributed Then AGPL replacements preserve upgrade baselines', () => {
    const bundledDir = join(import.meta.dir, '../../../default-skills')
    const manifest = JSON.parse(
      readFileSync(join(bundledDir, 'default-skills-manifest.json'), 'utf-8'),
    ) as DefaultSkillsManifest

    for (const slug of rewrittenDocumentSkillSlugs) {
      const skillDir = join(bundledDir, slug)
      const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
      const entry = manifest.skills[slug]

      expect(configPaths.RETIRED_DEFAULT_SKILL_SLUGS).not.toContain(slug)
      expect(skill).toContain('version: "2.0.0"')
      expect(skill).toContain('license: AGPL-3.0-only')
      expect(skill).not.toContain('Proprietary')
      expect(entry?.currentHash).toBe(defaultSkillLifecycle.computeSkillDirectoryHash(skillDir))
      expect(entry?.knownBaselineHashes.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('Given unmodified active default Skill When bundle version increases Then upgrade in place', () => {
    const bundle = createBundle()
    writeBundledSkill(bundle, 'sample', '1.0.0', 'old baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const workspace = manager.createAgentWorkspace('Managed Active')

    writeBundledSkill(bundle, 'sample', '1.1.0', 'new baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    manager.upgradeDefaultSkillsInWorkspaces()

    const skillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample')
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toContain('new baseline')
    expect(defaultSkillLifecycle.readDefaultSkillSourceMetadata(skillDir)?.version).toBe('1.1.0')
  })

  test('Given unmodified inactive default Skill When upgraded Then it remains inactive', () => {
    const bundle = createBundle()
    writeBundledSkill(bundle, 'sample', '1.0.0', 'old baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const workspace = manager.createAgentWorkspace('Managed Inactive')
    manager.toggleWorkspaceSkill(workspace.slug, 'sample', false)

    writeBundledSkill(bundle, 'sample', '1.1.0', 'new baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    manager.upgradeDefaultSkillsInWorkspaces()

    expect(existsSync(join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample'))).toBe(false)
    expect(readFileSync(join(configPaths.getInactiveSkillsDir(workspace.slug), 'sample', 'SKILL.md'), 'utf-8')).toContain('new baseline')
  })

  test('Given user customizes default cache When bundle upgrades Then cache is preserved but new workspaces receive pristine baseline', () => {
    const bundle = createBundle()
    writeBundledSkill(bundle, 'sample', '1.0.0', 'old baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const cachedSkillMd = join(configPaths.getDefaultSkillsDir(), 'sample', 'SKILL.md')
    writeFileSync(cachedSkillMd, `${readFileSync(cachedSkillMd, 'utf-8')}\nuser cache customization\n`, 'utf-8')

    writeBundledSkill(bundle, 'sample', '1.1.0', 'new pristine baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const workspace = manager.createAgentWorkspace('Pristine Distribution')

    expect(readFileSync(cachedSkillMd, 'utf-8')).toContain('user cache customization')
    const workspaceContent = readFileSync(
      join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample', 'SKILL.md'),
      'utf-8',
    )
    expect(workspaceContent).toContain('new pristine baseline')
    expect(workspaceContent).not.toContain('user cache customization')
  })

  test('Given user customizes default Skill When bundle upgrades Then active content is preserved', () => {
    const bundle = createBundle()
    writeBundledSkill(bundle, 'sample', '1.0.0', 'old baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const workspace = manager.createAgentWorkspace('Customized Default')
    const skillMd = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample', 'SKILL.md')
    writeFileSync(skillMd, `${readFileSync(skillMd, 'utf-8')}\nuser customization\n`, 'utf-8')

    writeBundledSkill(bundle, 'sample', '1.1.0', 'new baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    manager.upgradeDefaultSkillsInWorkspaces()

    const content = readFileSync(skillMd, 'utf-8')
    expect(content).toContain('user customization')
    expect(content).not.toContain('new baseline')
  })

  test('Given legacy unmodified copy without sidecar When old hash is known Then migrate on upgrade', () => {
    const bundle = createBundle()
    writeBundledSkill(bundle, 'sample', '1.0.0', 'legacy baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const workspace = manager.createAgentWorkspace('Legacy Default')
    const skillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample')
    rmSync(join(skillDir, defaultSkillLifecycle.DEFAULT_SKILL_SOURCE_FILE), { force: true })

    writeBundledSkill(bundle, 'sample', '1.1.0', 'new baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    manager.upgradeDefaultSkillsInWorkspaces()

    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toContain('new baseline')
    expect(defaultSkillLifecycle.readDefaultSkillSourceMetadata(skillDir)?.version).toBe('1.1.0')
  })

  test('Given a seen default Skill is missing When startup sync runs Then it is not re-injected', () => {
    const bundle = createBundle()
    writeBundledSkill(bundle, 'sample', '1.0.0', 'baseline')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const workspace = manager.createAgentWorkspace('Removed Default')
    const skillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample')
    rmSync(skillDir, { recursive: true, force: true })

    manager.upgradeDefaultSkillsInWorkspaces()

    expect(existsSync(skillDir)).toBe(false)
  })

  test('Given a genuinely new default Skill When startup sync runs Then inject once into active', () => {
    const bundle = createBundle()
    writeBundledSkill(bundle, 'alpha', '1.0.0', 'alpha')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    const workspace = manager.createAgentWorkspace('New Default')

    writeBundledSkill(bundle, 'beta', '1.0.0', 'beta')
    configPaths.syncBundledDefaultSkills(bundle, configPaths.getDefaultSkillsDir())
    manager.upgradeDefaultSkillsInWorkspaces()

    const betaDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'beta')
    expect(existsSync(join(betaDir, 'SKILL.md'))).toBe(true)
    rmSync(betaDir, { recursive: true, force: true })
    manager.upgradeDefaultSkillsInWorkspaces()
    expect(existsSync(betaDir)).toBe(false)
  })

  test('Given retired managed and customized copies When cleanup runs Then only unmodified managed copy is deleted', () => {
    const workspaceManaged = manager.createAgentWorkspace('Retired Managed')
    const workspaceCustomized = manager.createAgentWorkspace('Retired Customized')
    const retiredCache = join(configPaths.getDefaultSkillsDir(), 'brainstorming')
    writeBundledSkill(configPaths.getDefaultSkillsDir(), 'brainstorming', '1.0.0', 'retired baseline')
    const baselineHash = defaultSkillLifecycle.computeSkillDirectoryHash(retiredCache)
    const manifest = defaultSkillLifecycle.readDefaultSkillsManifest(configPaths.getDefaultSkillsDir())
    defaultSkillLifecycle.recordDefaultSkillBaseline(manifest, 'brainstorming', '1.0.0', baselineHash)
    defaultSkillLifecycle.writeDefaultSkillsManifest(configPaths.getDefaultSkillsDir(), manifest)

    const managedDir = join(configPaths.getWorkspaceSkillsDir(workspaceManaged.slug), 'brainstorming')
    const customizedDir = join(configPaths.getWorkspaceSkillsDir(workspaceCustomized.slug), 'brainstorming')
    defaultSkillLifecycle.copyManagedSkillDirectory(retiredCache, managedDir, {
      slug: 'brainstorming', version: '1.0.0', baselineHash,
    })
    defaultSkillLifecycle.copyManagedSkillDirectory(retiredCache, customizedDir, {
      slug: 'brainstorming', version: '1.0.0', baselineHash,
    })
    writeFileSync(join(customizedDir, 'notes.md'), 'user customization', 'utf-8')

    manager.upgradeDefaultSkillsInWorkspaces()

    expect(existsSync(managedDir)).toBe(false)
    expect(existsSync(customizedDir)).toBe(true)
  })
})

describe('Agent 工作区 Skill 扫描', () => {
  test('Given Skills 目录包含 broken symlink When 获取工作区 Skills Then 跳过坏条目并继续扫描后续 Skill', () => {
    const workspaceSlug = 'workspace-a'
    const skillsDir = configPaths.getWorkspaceSkillsDir(workspaceSlug)

    writeWorkspaceSkill(workspaceSlug, 'alpha', 'Alpha')
    try {
      symlinkSync(join(skillsDir, 'missing-target'), join(skillsDir, 'broken-link'), 'dir')
    } catch (error) {
      // Windows 未启用 Developer Mode / SeCreateSymbolicLinkPrivilege 时无法建立测试 fixture。
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM')
      return
    }
    writeWorkspaceSkill(workspaceSlug, 'zeta', 'Zeta')

    for (let i = 0; i < 20; i++) {
      const entryNames = readdirSync(skillsDir)
      const brokenIndex = entryNames.indexOf('broken-link')
      const hasSkillAfterBroken = entryNames.slice(brokenIndex + 1).some((name) => name !== 'missing-target')
      if (brokenIndex !== -1 && hasSkillAfterBroken) break
      writeWorkspaceSkill(workspaceSlug, `tail-${i}`, `Tail ${i}`)
    }

    const finalEntryNames = readdirSync(skillsDir)
    const finalBrokenIndex = finalEntryNames.indexOf('broken-link')
    expect(finalBrokenIndex).not.toBe(-1)
    expect(finalEntryNames.slice(finalBrokenIndex + 1).some((name) => name !== 'missing-target')).toBe(true)

    const expectedSlugs = finalEntryNames
      .filter((name) => name !== 'broken-link')
      .sort()
    const skills = manager.getWorkspaceSkills(workspaceSlug)

    expect(skills.map((skill) => skill.slug).sort()).toEqual(expectedSlugs)
  })
})
