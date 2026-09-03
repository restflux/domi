import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeReleaseTag,
  readReleaseVersions,
  verifyReleaseVersion,
} from './verify-release-version'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRepo(rootVersion: string, electronVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), 'domi-release-version-'))
  tempRoots.push(root)
  mkdirSync(join(root, 'apps', 'electron'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: rootVersion }))
  writeFileSync(
    join(root, 'apps', 'electron', 'package.json'),
    JSON.stringify({
      version: electronVersion,
      homepage: 'https://github.com/restflux/domi',
    }),
  )
  return root
}

describe('normalizeReleaseTag', () => {
  test('accepts a v-prefixed semantic version tag', () => {
    expect(normalizeReleaseTag('v0.20.2')).toBe('0.20.2')
  })

  test('rejects tags that cannot identify a release version', () => {
    expect(() => normalizeReleaseTag('release-0.20.2')).toThrow('必须使用 v<semver>')
    expect(() => normalizeReleaseTag('v0.20')).toThrow('必须使用 v<semver>')
  })
})

describe('verifyReleaseVersion', () => {
  test('accepts matching package versions and release tag', () => {
    const repoRoot = createRepo('0.20.2', '0.20.2')

    expect(verifyReleaseVersion(repoRoot, 'v0.20.2')).toEqual({
      rootVersion: '0.20.2',
      electronVersion: '0.20.2',
      tagVersion: '0.20.2',
    })
  })

  test('rejects a root and Electron version mismatch', () => {
    const repoRoot = createRepo('0.20.2', '0.20.1')

    expect(() => verifyReleaseVersion(repoRoot)).toThrow('根项目版本 0.20.2 与 Electron 版本 0.20.1 不一致')
  })

  test('rejects a tag that differs from the package version', () => {
    const repoRoot = createRepo('0.20.2', '0.20.2')

    expect(() => verifyReleaseVersion(repoRoot, 'v0.20.1')).toThrow('Release tag v0.20.1 与应用版本 0.20.2 不一致')
  })

  test('rejects Electron metadata that cannot produce a Linux deb package', () => {
    const repoRoot = createRepo('0.20.2', '0.20.2')
    writeFileSync(
      join(repoRoot, 'apps', 'electron', 'package.json'),
      JSON.stringify({ version: '0.20.2' }),
    )

    expect(() => verifyReleaseVersion(repoRoot)).toThrow('Electron package.json 缺少有效 homepage')
  })

  test('can validate package manifests before a tag exists', () => {
    const repoRoot = createRepo('0.20.2', '0.20.2')

    expect(readReleaseVersions(repoRoot)).toEqual({
      rootVersion: '0.20.2',
      electronVersion: '0.20.2',
    })
    expect(verifyReleaseVersion(repoRoot)).toEqual({
      rootVersion: '0.20.2',
      electronVersion: '0.20.2',
      tagVersion: undefined,
    })
  })
})
