import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { computeSkillDirectoryHash } from './default-skill-lifecycle.ts'

const repoRoot = resolve(import.meta.dir, '../../../../..')
const textExtensions = new Set(['.md', '.ts', '.tsx', '.json'])

const activeRoots = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'README.md',
  'README.en.md',
  'docs/adr/0002-pi-only-agent-runtime.md',
  'apps/electron/default-skills',
  'apps/electron/resources/tutorial.md',
  'apps/electron/src',
  'packages/shared/src',
  'tutorial/tutorial-v2.md',
]

/**
 * Active files that intentionally retain CLAUDE.md references.
 *
 * Categories are limited to:
 * - the repository's legacy compatibility entry;
 * - safe migration/read-only fallback and deprecated API contracts;
 * - external repository standards that may still use CLAUDE.md;
 * - current user-facing migration documentation.
 *
 * Historical plans, research and release notes are not active product copy and are
 * outside this scan. Any new active reference must be classified here explicitly.
 */
const intentionalClaudeMdAllowlist = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'apps/electron/default-skills/code-review/SKILL.md',
  'apps/electron/default-skills/tdd/SKILL.md',
  'apps/electron/src/main/lib/adapters/pi-resource-loader-overrides.test.ts',
  'apps/electron/src/main/lib/adapters/pi-resource-loader-overrides.ts',
  'apps/electron/src/main/lib/agent-instruction-naming.test.ts',
  'apps/electron/src/main/lib/agent-prompt-builder.test.ts',
  'apps/electron/src/main/lib/agent-prompt-builder.ts',
  'apps/electron/src/main/lib/agent-workspace-manager.test.ts',
  'apps/electron/src/main/lib/agent-workspace-manager.ts',
  'apps/electron/src/main/lib/project-instruction-resolver.test.ts',
  'apps/electron/src/main/lib/project-instruction-resolver.ts',
  'apps/electron/src/renderer/components/agent-skills/WorkspaceMemoryTab.tsx',
  'docs/adr/0002-pi-only-agent-runtime.md',
  'packages/shared/src/types/agent.ts',
]

function extension(path: string): string {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index) : ''
}

function collectTextFiles(path: string): string[] {
  const absolutePath = resolve(repoRoot, path)
  const stat = statSync(absolutePath)
  if (stat.isFile()) return textExtensions.has(extension(absolutePath)) ? [absolutePath] : []
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return []
    return collectTextFiles(join(path, entry.name))
  })
}

function readSkillVersion(skillDir: string): string | undefined {
  const content = readFileSync(join(repoRoot, skillDir, 'SKILL.md'), 'utf-8')
  return content.match(/^version:\s*["']?([^"'\r\n]+)["']?$/m)?.[1]
}

describe('AGENTS.md 命名收口', () => {
  test('active product copy keeps every CLAUDE.md reference on an explicit compatibility allowlist', () => {
    const matches = activeRoots
      .flatMap(collectTextFiles)
      .filter((path) => readFileSync(path, 'utf-8').includes('CLAUDE.md'))
      .map((path) => relative(repoRoot, path).replaceAll('\\', '/'))
      .sort()

    expect(matches).toEqual([...intentionalClaudeMdAllowlist].sort())
  })

  test('Domi Coach and presentation examples use AGENTS.md as the primary instruction name', () => {
    const coach = readFileSync(join(repoRoot, 'apps/electron/default-skills/domi-coach/SKILL.md'), 'utf-8')
    const components = readFileSync(join(repoRoot, 'apps/electron/default-skills/guizang-ppt-skill/references/components.md'), 'utf-8')

    expect(coach).toContain('AGENTS.md 约束行为')
    expect(coach).not.toContain('CLAUDE.md')
    expect(components).toContain('AGENTS.md')
    expect(components).not.toContain('CLAUDE.md')
  })

  test('changed default Skills publish exact versioned hashes while retaining the previous baselines', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'apps/electron/default-skills/default-skills-manifest.json'), 'utf-8')) as {
      skills: Record<string, { version: string; currentHash: string; knownBaselineHashes: string[] }>
    }
    const expectations = [
      {
        slug: 'domi-coach',
        version: '1.0.11',
        previousHash: '7d94837a3158c9fa7edcc2320f4082ae4983ed4a9bc02a9cd7226d8cc41be1bc',
      },
      {
        slug: 'guizang-ppt-skill',
        version: '1.0.1',
        previousHash: '2f77838701f85ddc4e0806ca89a9b6fbe9e49b62651077b166edb18c1bf90c94',
      },
    ]

    for (const expected of expectations) {
      const skillDir = `apps/electron/default-skills/${expected.slug}`
      const entry = manifest.skills[expected.slug]
      expect(readSkillVersion(skillDir)).toBe(expected.version)
      expect(entry?.version).toBe(expected.version)
      expect(entry?.currentHash).toBe(computeSkillDirectoryHash(join(repoRoot, skillDir)))
      expect(entry?.knownBaselineHashes).toContain(expected.previousHash)
      expect(entry?.knownBaselineHashes).toContain(entry?.currentHash)
    }
  })
})
