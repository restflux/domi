#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface PackageManifest {
  version?: string
  homepage?: string
}

export interface ReleaseVersions {
  rootVersion: string
  electronVersion: string
}

export interface VerifiedReleaseVersion extends ReleaseVersions {
  tagVersion?: string
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function readPackageVersion(manifest: PackageManifest, label: string): string {
  const version = manifest.version?.trim()
  if (!version || !SEMVER_PATTERN.test(version)) {
    throw new Error(`${label} package.json 缺少有效 semver 版本`)
  }
  return version
}

function assertElectronHomepage(manifest: PackageManifest): void {
  const homepage = manifest.homepage?.trim()
  if (!homepage) throw new Error('Electron package.json 缺少有效 homepage')
  try {
    const url = new URL(homepage)
    if (url.protocol !== 'https:') throw new Error('invalid protocol')
  } catch {
    throw new Error('Electron package.json 缺少有效 homepage')
  }
}

export function normalizeReleaseTag(tag: string): string {
  const normalized = tag.trim()
  if (!normalized.startsWith('v')) {
    throw new Error(`Release tag ${normalized || '<empty>'} 必须使用 v<semver> 格式`)
  }
  const version = normalized.slice(1)
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Release tag ${normalized} 必须使用 v<semver> 格式`)
  }
  return version
}

export function readReleaseVersions(repoRoot: string): ReleaseVersions {
  const rootManifest = readPackageManifest(resolve(repoRoot, 'package.json'))
  const electronManifest = readPackageManifest(resolve(repoRoot, 'apps/electron/package.json'))
  assertElectronHomepage(electronManifest)
  return {
    rootVersion: readPackageVersion(rootManifest, '根项目'),
    electronVersion: readPackageVersion(electronManifest, 'Electron'),
  }
}

export function verifyReleaseVersion(repoRoot: string, tag?: string): VerifiedReleaseVersion {
  const versions = readReleaseVersions(repoRoot)
  if (versions.rootVersion !== versions.electronVersion) {
    throw new Error(
      `根项目版本 ${versions.rootVersion} 与 Electron 版本 ${versions.electronVersion} 不一致`,
    )
  }

  const tagVersion = tag ? normalizeReleaseTag(tag) : undefined
  if (tagVersion && tagVersion !== versions.rootVersion) {
    throw new Error(`Release tag v${tagVersion} 与应用版本 ${versions.rootVersion} 不一致`)
  }

  return { ...versions, tagVersion }
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, '..')
  const tag = process.argv[2]
  const result = verifyReleaseVersion(repoRoot, tag)
  const tagMessage = result.tagVersion ? `，tag v${result.tagVersion}` : ''
  console.log(`[release-version] ✓ Domi ${result.rootVersion}${tagMessage}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(`[release-version] ✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
