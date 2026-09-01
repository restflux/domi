import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')

function listCurrentTrackedFiles(pathspecs: string[]): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '--', ...pathspecs], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  expect(result.exitCode).toBe(0)
  return result.stdout
    .toString('utf-8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(resolve(repoRoot, line)))
}

function findTrackedMatches(pattern: string): string[] {
  const result = Bun.spawnSync(['git', 'grep', '-n', '-E', pattern, '--'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  expect([0, 1]).toContain(result.exitCode)
  return result.stdout
    .toString('utf-8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
}

function listMarkdownFilesUnder(path: string): string[] {
  const absolutePath = resolve(repoRoot, path)
  if (!existsSync(absolutePath)) return []
  if (statSync(absolutePath).isFile()) return path.endsWith('.md') ? [path] : []

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = relative(repoRoot, resolve(absolutePath, entry.name)).replaceAll('\\', '/')
    return entry.isDirectory()
      ? listMarkdownFilesUnder(childPath)
      : entry.isFile() && childPath.endsWith('.md')
        ? [childPath]
        : []
  })
}

function markdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)]
    .map((match) => match[1]?.replace(/^<|>$/gu, '') ?? '')
    .filter((target) => target.length > 0)
}

function resolveRelativeMarkdownTarget(sourcePath: string, target: string): string | undefined {
  if (
    target.startsWith('#')
    || target.startsWith('//')
    || isAbsolute(target)
    || /^[a-z][a-z\d+.-]*:/iu.test(target)
  ) {
    return undefined
  }

  const pathOnly = target.split(/[?#]/u, 1)[0]
  if (!pathOnly) return undefined

  try {
    return resolve(repoRoot, dirname(sourcePath), decodeURIComponent(pathOnly))
  } catch {
    return resolve(repoRoot, dirname(sourcePath), pathOnly)
  }
}

function publicMarkdownFiles(): string[] {
  return [
    ...listMarkdownFilesUnder('README.md'),
    ...listMarkdownFilesUnder('README.en.md'),
    ...listMarkdownFilesUnder('AGENTS.md'),
    ...listMarkdownFilesUnder('CLAUDE.md'),
    ...listMarkdownFilesUnder('CONTEXT.md'),
    ...listMarkdownFilesUnder('CONTRIBUTING.md'),
    ...listMarkdownFilesUnder('SECURITY.md'),
    ...listMarkdownFilesUnder('THIRD_PARTY_NOTICES.md'),
    ...listMarkdownFilesUnder('docs'),
    ...listMarkdownFilesUnder('tutorial'),
  ]
}

function brokenPublicMarkdownLinks(): string[] {
  const brokenLinks: string[] = []

  for (const sourcePath of publicMarkdownFiles()) {
    const markdown = readFileSync(resolve(repoRoot, sourcePath), 'utf-8')
    for (const target of markdownLinkTargets(markdown)) {
      const resolvedTarget = resolveRelativeMarkdownTarget(sourcePath, target)
      if (!resolvedTarget || existsSync(resolvedTarget)) continue
      brokenLinks.push(`${sourcePath} -> ${target}`)
    }
  }

  return brokenLinks
}

function stalePublicDocumentPhrases(): string[] {
  const stalePhrases = [
    '维护者的私有构建产物',
    "maintainer's private builds",
    'Claude remains a Legacy Runtime',
    '基于 Proma v0.12.x 演进',
    'rather than public distribution',
  ]
  const matches: string[] = []

  for (const sourcePath of publicMarkdownFiles()) {
    const markdown = readFileSync(resolve(repoRoot, sourcePath), 'utf-8')
    for (const phrase of stalePhrases) {
      if (markdown.includes(phrase)) matches.push(`${sourcePath} -> ${phrase}`)
    }
  }

  return matches
}


describe('仓库隐私生成产物门禁', () => {
  test('Given Agent 会话生成图片 When 检查仓库卫生 Then 目录被忽略且没有文件进入 Git 跟踪', () => {
    const gitignore = readFileSync(resolve(repoRoot, '.gitignore'), 'utf-8')
      .split(/\r?\n/u)
      .map((line) => line.trim())

    expect(gitignore).toContain('generated-images/')
    expect(listCurrentTrackedFiles(['generated-images'])).toEqual([])
  })
})

describe('公开文档卫生门禁', () => {
  test('Given 正式文档树 When 检查公开路径 Then 不重新跟踪计划流水账、内部研究或上游作者文章', () => {
    const forbiddenPaths = [
      'proma-thinking',
      'release-notes',
      'docs/plans',
      'docs/research',
      'docs/mainstream-coding-tool-gap-analysis.zh-CN.md',
      'docs/personal-coding-tool-assessment.zh-CN.md',
      'docs/picli-feature-porting-discussion.zh-CN.md',
      'docs/proactive-scheduler-monitor-design.md',
      'docs/vision-relay-quality-eval.md',
    ]

    expect(forbiddenPaths.filter((path) => existsSync(resolve(repoRoot, path)))).toEqual([])
    expect(listCurrentTrackedFiles(forbiddenPaths)).toEqual([])
  })

  test('Given README、教程与正式工程文档 When 检查相对链接 Then 所有目标都存在', () => {
    expect(brokenPublicMarkdownLinks()).toEqual([])
  })

  test('Given Domi canonical identity When 检查 tracked tree Then 不再主动使用旧 package、环境变量或文件协议', () => {
    const legacyBrand = 'pro' + 'ma'
    expect(findTrackedMatches(`@${legacyBrand}/`)).toEqual([])
    expect(findTrackedMatches(`\\b${legacyBrand.toUpperCase()}_[A-Z0-9_]+\\b`)).toEqual([])
    expect(findTrackedMatches(`${legacyBrand}-file|application/x-${legacyBrand}-`)).toEqual([])
    expect(findTrackedMatches(`\\b${legacyBrand[0]?.toUpperCase()}${legacyBrand.slice(1)}(PermissionMode|PermissionModeConfig|Event|TaskItem|KeyboardInput|ProductToolRuntimeState)\\b`)).toEqual([])
  })

  test('Given 公开文档 When 检查已淘汰产品描述 Then 不再出现私人构建或双 Runtime 旧文案', () => {
    expect(stalePublicDocumentPhrases()).toEqual([])
  })

  test('Given 开源分发配置 When 检查治理与许可证材料 Then 源码和桌面包都保留必要声明', () => {
    const requiredFiles = [
      'CONTRIBUTING.md',
      'SECURITY.md',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
      '.gitleaks.toml',
      'third-party-licenses/Apache-2.0.txt',
      'third-party-licenses/EPL-2.0-elkjs.txt',
      'third-party-licenses/LGPL-3.0.txt',
      'third-party-licenses/MIT-Lobe-Icons.txt',
      'third-party-licenses/MIT-Matt-Pocock-Skills.txt',
      'third-party-licenses/MIT-Motion.txt',
      'third-party-licenses/MIT-Pi.txt',
      'third-party-licenses/MIT-node-pty.txt',
      'third-party-licenses/OFL-1.1-Inter.txt',
    ]
    const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as { license?: string }
    const electronPackage = JSON.parse(readFileSync(resolve(repoRoot, 'apps/electron/package.json'), 'utf-8')) as { license?: string }
    const builderConfig = readFileSync(resolve(repoRoot, 'apps/electron/electron-builder.yml'), 'utf-8')
    const notice = readFileSync(resolve(repoRoot, 'NOTICE'), 'utf-8')
    const notices = readFileSync(resolve(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf-8')
    const securityPolicy = readFileSync(resolve(repoRoot, 'SECURITY.md'), 'utf-8')
    const menuSource = readFileSync(resolve(repoRoot, 'apps/electron/src/main/menu.ts'), 'utf-8')

    expect(requiredFiles.filter((path) => !existsSync(resolve(repoRoot, path)))).toEqual([])
    expect(rootPackage.license).toBe('AGPL-3.0-only')
    expect(electronPackage.license).toBe('AGPL-3.0-only')
    expect(builderConfig).toContain('from: ../../LICENSE')
    expect(builderConfig).toContain('from: ../../NOTICE')
    expect(builderConfig).toContain('from: ../../THIRD_PARTY_NOTICES.md')
    expect(builderConfig).toContain('from: ../../third-party-licenses')
    expect(notice).toContain('https://github.com/proma-ai/Proma')
    expect(securityPolicy).toContain('https://github.com/restflux/domi/security/advisories/new')
    expect(menuSource).toContain("https://github.com/restflux/domi")
    expect(`${securityPolicy}\n${menuSource}`).not.toContain('github.com/wloops/domi')
    for (const requiredNotice of ['Proma', 'Pi Agent Runtime', 'node-pty', 'Guizang PPT Skill', 'Skill Creator', 'Lobe Icons', 'Inter']) {
      expect(notices).toContain(requiredNotice)
    }
  })

  test('Given ADR 目录 When 检查编号与索引 Then 每个当前 ADR 编号唯一且进入导航', () => {
    const adrFiles = listMarkdownFilesUnder('docs/adr')
      .filter((path) => basename(path) !== 'README.md')
    const adrIds = adrFiles.map((path) => basename(path).match(/^(\d{4})-/u)?.[1] ?? '')
    const adrIndex = readFileSync(resolve(repoRoot, 'docs/adr/README.md'), 'utf-8')

    expect(adrIds.every((id) => id.length === 4)).toBe(true)
    expect(new Set(adrIds).size).toBe(adrIds.length)
    expect(adrFiles.filter((path) => !adrIndex.includes(`./${basename(path)}`))).toEqual([])
    expect(statSync(resolve(repoRoot, 'docs/README.md')).isFile()).toBe(true)
  })
})
