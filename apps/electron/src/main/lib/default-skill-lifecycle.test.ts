import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  computeSkillDirectoryHash,
  copyManagedSkillDirectory,
  isUnmodifiedDefaultSkill,
  readDefaultSkillSourceMetadata,
  writeDefaultSkillSourceMetadata,
  recordDefaultSkillBaseline,
  replaceManagedSkillDirectory,
  type DefaultSkillsManifest,
} from './default-skill-lifecycle.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'domi-default-skill-lifecycle-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSkill(dir: string, version: string, body: string, extra = ''): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: sample\nversion: "${version}"\n---\n${body}\n`, 'utf-8')
  if (extra) {
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'references', 'guide.md'), extra, 'utf-8')
  }
}

describe('shipped default skill manifest', () => {
  test('tracks current baselines plus historical hashes needed for upgrades and retirement', () => {
    const bundledDir = resolve(import.meta.dir, '../../../default-skills')
    const manifest = JSON.parse(
      readFileSync(join(bundledDir, 'default-skills-manifest.json'), 'utf-8'),
    ) as DefaultSkillsManifest

    for (const [slug, entry] of Object.entries(manifest.skills)) {
      const skillDir = join(bundledDir, slug)
      if (existsSync(skillDir)) expect(computeSkillDirectoryHash(skillDir)).toBe(entry.currentHash)
      expect(entry.knownBaselineHashes).toContain(entry.currentHash)
    }
    expect(manifest.skills.tdd?.knownBaselineHashes).toContain('757f437599949572839565802145a955a859f8e2cfd09dc88833dab68dc795da')
    expect(manifest.skills.tdd?.knownBaselineHashes.length).toBeGreaterThanOrEqual(2)
    expect(manifest.skills.brainstorming?.knownBaselineHashes).toHaveLength(1)
    expect(manifest.skills['proma-coach']).toBeUndefined()
  })
})

describe('default skill baseline lifecycle', () => {
  test('Given identical text with LF or CRLF When hashing default Skills Then baseline hash stays cross-platform stable', () => {
    const lf = join(root, 'lf-skill')
    const crlf = join(root, 'crlf-skill')
    mkdirSync(lf, { recursive: true })
    mkdirSync(crlf, { recursive: true })
    writeFileSync(join(lf, 'SKILL.md'), '---\nname: sample\n---\nbody\n', 'utf-8')
    writeFileSync(join(crlf, 'SKILL.md'), '---\r\nname: sample\r\n---\r\nbody\r\n', 'utf-8')

    expect(computeSkillDirectoryHash(crlf)).toBe(computeSkillDirectoryHash(lf))
  })

  test('Given a managed CRLF copy with legacy raw-byte metadata When checking a normalized manifest Then it remains safe to upgrade', () => {
    const skillDir = join(root, 'legacy-crlf-managed')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\r\nname: sample\r\nversion: "1.0.0"\r\n---\r\nbody\r\n', 'utf-8')
    const rawHash = (() => {
      const hash = createHash('sha256')
      hash.update('file:SKILL.md\n')
      hash.update(readFileSync(join(skillDir, 'SKILL.md')))
      hash.update('\n')
      return hash.digest('hex')
    })()
    const normalizedHash = computeSkillDirectoryHash(skillDir)
    writeDefaultSkillSourceMetadata(skillDir, {
      slug: 'sample',
      version: '1.0.0',
      baselineHash: rawHash,
    })

    expect(rawHash).not.toBe(normalizedHash)
    expect(isUnmodifiedDefaultSkill(skillDir, [normalizedHash])).toBe(true)
  })

  test('Given managed copy When unchanged Then metadata baseline identifies it as safe to upgrade', () => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    writeSkill(source, '1.0.0', 'baseline', 'reference')
    const baselineHash = computeSkillDirectoryHash(source)

    copyManagedSkillDirectory(source, target, {
      slug: 'sample',
      version: '1.0.0',
      baselineHash,
    })

    expect(readDefaultSkillSourceMetadata(target)).toMatchObject({
      source: 'domi-builtin',
      slug: 'sample',
      version: '1.0.0',
      baselineHash,
    })
    expect(isUnmodifiedDefaultSkill(target)).toBe(true)
  })

  test('Given user edits any copied file When checking baseline Then it is protected', () => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    writeSkill(source, '1.0.0', 'baseline', 'reference')
    copyManagedSkillDirectory(source, target, {
      slug: 'sample',
      version: '1.0.0',
      baselineHash: computeSkillDirectoryHash(source),
    })

    writeFileSync(join(target, 'references', 'guide.md'), 'user customization', 'utf-8')

    expect(isUnmodifiedDefaultSkill(target)).toBe(false)
  })

  test('Given legacy copy without metadata When hash matches historical manifest Then it can migrate safely', () => {
    const legacy = join(root, 'legacy')
    writeSkill(legacy, '1.0.0', 'old baseline')
    const hash = computeSkillDirectoryHash(legacy)
    const manifest: DefaultSkillsManifest = { schemaVersion: 1, skills: {} }

    recordDefaultSkillBaseline(manifest, 'sample', '1.0.0', hash)

    expect(isUnmodifiedDefaultSkill(legacy, manifest.skills.sample?.knownBaselineHashes)).toBe(true)
    writeFileSync(join(legacy, 'SKILL.md'), 'user replacement', 'utf-8')
    expect(isUnmodifiedDefaultSkill(legacy, manifest.skills.sample?.knownBaselineHashes)).toBe(false)
  })

  test('Given safe managed copy When replacing Then new content and baseline metadata arrive together', () => {
    const oldSource = join(root, 'old-source')
    const newSource = join(root, 'new-source')
    const target = join(root, 'target')
    writeSkill(oldSource, '1.0.0', 'old')
    writeSkill(newSource, '1.1.0', 'new')
    copyManagedSkillDirectory(oldSource, target, {
      slug: 'sample',
      version: '1.0.0',
      baselineHash: computeSkillDirectoryHash(oldSource),
    })

    const newHash = computeSkillDirectoryHash(newSource)
    expect(replaceManagedSkillDirectory(newSource, target, {
      slug: 'sample',
      version: '1.1.0',
      baselineHash: newHash,
    })).toBe(true)

    expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toContain('new')
    expect(readDefaultSkillSourceMetadata(target)?.baselineHash).toBe(newHash)
    expect(isUnmodifiedDefaultSkill(target)).toBe(true)
  })

  test('Given source copy fails When replacing Then original target remains untouched', () => {
    const target = join(root, 'target')
    writeSkill(target, '1.0.0', 'keep me')

    expect(replaceManagedSkillDirectory(join(root, 'missing-source'), target, {
      slug: 'sample',
      version: '2.0.0',
      baselineHash: 'missing',
    })).toBe(false)
    expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toContain('keep me')
    expect(existsSync(target)).toBe(true)
  })
})
