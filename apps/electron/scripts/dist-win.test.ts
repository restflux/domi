import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDistWinPlan, parseDistWinArgs, preservePreviousFastArtifacts } from './dist-win'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const context = {
  appDir: 'D:/repo/apps/electron',
  electronBuilderPath: 'D:/repo/node_modules/.bin/electron-builder.exe',
  rceditPath: 'C:/electron-builder/Cache/winCodeSign/123/rcedit-x64.exe',
  version: '1.2.3',
  productName: 'Domi',
  description: 'Domi personal coding workbench - Electron App',
  copyright: 'Copyright © 2024-2026 Erlich Liu',
}

const fastOptions = { mode: 'fast' as const, dryRun: false, full: false, parallel: true, noAsar: false }
const unsignedOptions = { mode: 'unsigned' as const, dryRun: false, full: false, parallel: true, noAsar: false }
const releaseOptions = { mode: 'release' as const, dryRun: false, full: false, parallel: true, noAsar: false }

describe('parseDistWinArgs', () => {
  test('defaults to the safer release channel', () => {
    expect(parseDistWinArgs([])).toEqual({
      mode: 'release',
      dryRun: false,
      full: false,
      parallel: true,
      noAsar: false,
    })
  })

  test('selects the fast local channel explicitly', () => {
    expect(parseDistWinArgs(['--fast', '--dry-run'])).toEqual({
      mode: 'fast',
      dryRun: true,
      full: false,
      parallel: true,
      noAsar: false,
    })
  })

  test('selects the unsigned public release channel explicitly', () => {
    expect(parseDistWinArgs(['--unsigned', '--dry-run'])).toEqual({
      mode: 'unsigned',
      dryRun: true,
      full: false,
      parallel: true,
      noAsar: false,
    })
  })

  test('parses full / no-parallel / no-asar flags', () => {
    expect(parseDistWinArgs(['--fast', '--full', '--no-parallel', '--no-asar'])).toEqual({
      mode: 'fast',
      dryRun: false,
      full: true,
      parallel: false,
      noAsar: true,
    })
  })

  test('rejects conflicting channels', () => {
    expect(() => parseDistWinArgs(['--fast', '--release'])).toThrow('只能选择一个')
    expect(() => parseDistWinArgs(['--unsigned', '--release'])).toThrow('只能选择一个')
  })
})

describe('createDistWinPlan', () => {
  test('fast channel uses isolated output, executable editing fallback and store compression', () => {
    const plan = createDistWinPlan(fastOptions, context)

    expect(plan.outputDir.replaceAll('\\', '/')).toEndWith('/out/fast')
    expect(plan.steps.map((step) => step.id)).toEqual([
      'build',
      'sync-runtime-deps',
      'package-unpacked',
      'edit-executable',
      'package-nsis',
    ])

    const unpacked = plan.steps.find((step) => step.id === 'package-unpacked')!
    expect(unpacked.args).toContain('--config.win.signAndEditExecutable=false')

    const edit = plan.steps.find((step) => step.id === 'edit-executable')!
    expect(edit.command).toBe(context.rceditPath)
    expect(edit.args).toContain('--set-icon')
    expect(edit.args).toContain('--set-file-version')
    expect(edit.args).toContain('1.2.3')

    const nsis = plan.steps.find((step) => step.id === 'package-nsis')!
    expect(nsis.args).toContain('--config.compression=store')
    expect(nsis.args).toContain('--config.win.signAndEditExecutable=false')
  })

  test('fast channel defaults to asar and incremental sync, parallel build', () => {
    const plan = createDistWinPlan(fastOptions, context)

    const build = plan.steps.find((step) => step.id === 'build')!
    expect(build.args).toEqual(['run', 'build:parallel'])

    const sync = plan.steps.find((step) => step.id === 'sync-runtime-deps')!
    expect(sync.args).toEqual(['run', 'sync:runtime-deps', '--incremental'])

    const unpacked = plan.steps.find((step) => step.id === 'package-unpacked')!
    expect(unpacked.args.some((arg) => arg.includes('asar=false'))).toBe(false)
    expect(plan.asarMode).toBe(true)
  })

  test('fast channel honors --no-asar and --no-parallel overrides', () => {
    const plan = createDistWinPlan({ ...fastOptions, noAsar: true, parallel: false }, context)

    const build = plan.steps.find((step) => step.id === 'build')!
    expect(build.args).toEqual(['run', 'build'])

    const unpacked = plan.steps.find((step) => step.id === 'package-unpacked')!
    expect(unpacked.args).toContain('--config.asar=false')
    expect(plan.asarMode).toBe(false)
  })

  test('unsigned channel keeps release compression while avoiding the signing toolchain', () => {
    const plan = createDistWinPlan(unsignedOptions, context)

    expect(plan.outputDir.replaceAll('\\', '/')).toEndWith('/out')
    expect(plan.steps.map((step) => step.id)).toEqual([
      'build',
      'sync-runtime-deps',
      'package-unpacked',
      'edit-executable',
      'package-nsis',
    ])

    const packageUnpacked = plan.steps.find((step) => step.id === 'package-unpacked')!
    const packageNsis = plan.steps.find((step) => step.id === 'package-nsis')!
    expect(packageUnpacked.args).toContain('--config.win.signAndEditExecutable=false')
    expect(packageNsis.args).toContain('--config.win.signAndEditExecutable=false')
    expect(packageNsis.args.some((arg) => arg.includes('compression=store'))).toBe(false)
    expect(packageNsis.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
    expect(plan.asarMode).toBe(true)
  })

  test('release channel keeps Electron Builder standard edit and signing behavior', () => {
    const plan = createDistWinPlan(releaseOptions, { ...context, rceditPath: undefined })

    expect(plan.outputDir.replaceAll('\\', '/')).toEndWith('/out')
    expect(plan.steps.map((step) => step.id)).toEqual([
      'build',
      'sync-runtime-deps',
      'package-release',
    ])

    const sync = plan.steps.find((step) => step.id === 'sync-runtime-deps')!
    expect(sync.args).toEqual(['run', 'sync:runtime-deps'])

    const release = plan.steps.at(-1)!
    expect(release.args).toContain('--win')
    expect(release.args).toContain('--x64')
    expect(release.args.slice(-2)).toEqual(['--publish', 'never'])
    expect(release.args.some((arg) => arg.includes('signAndEditExecutable=false'))).toBe(false)
    expect(release.args.some((arg) => arg.includes('compression=store'))).toBe(false)
    expect(plan.asarMode).toBe(true)
  })

  test('channels that manually edit the executable fail early without rcedit', () => {
    expect(() => createDistWinPlan(fastOptions, { ...context, rceditPath: undefined })).toThrow(
      '未找到 rcedit-x64.exe',
    )
    expect(() => createDistWinPlan(unsignedOptions, { ...context, rceditPath: undefined })).toThrow(
      '未找到 rcedit-x64.exe',
    )
  })

  test('keeps only the immediately previous fast installer archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-win-'))
    tempRoots.push(root)
    const outputDir = join(root, 'out', 'fast')
    const historyRoot = join(root, 'out', 'fast-history')
    const olderArchiveDir = join(historyRoot, '2026-09-01T00-00-00-000Z')
    mkdirSync(outputDir, { recursive: true })
    mkdirSync(olderArchiveDir, { recursive: true })
    writeFileSync(join(olderArchiveDir, 'Domi Setup 1.2.2.exe'), 'older installer')
    const previousArtifactPath = join(outputDir, 'Domi Setup 1.2.3.exe')
    const previousBlockmapPath = `${previousArtifactPath}.blockmap`
    const currentArtifactPath = join(outputDir, 'Domi Setup 1.2.4.exe')
    writeFileSync(previousArtifactPath, 'previous installer')
    writeFileSync(previousBlockmapPath, 'previous blockmap')

    const archiveDir = preservePreviousFastArtifacts(outputDir, currentArtifactPath)

    expect(archiveDir).toBeDefined()
    expect(existsSync(previousArtifactPath)).toBe(false)
    expect(existsSync(previousBlockmapPath)).toBe(false)
    expect(existsSync(olderArchiveDir)).toBe(false)
    expect(readFileSync(join(archiveDir!, 'Domi Setup 1.2.3.exe'), 'utf8')).toBe('previous installer')
    expect(readFileSync(join(archiveDir!, 'Domi Setup 1.2.3.exe.blockmap'), 'utf8')).toBe('previous blockmap')
  })

  test('prunes old fast archives even when there is no installer to archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-win-'))
    tempRoots.push(root)
    const outputDir = join(root, 'out', 'fast')
    const historyRoot = join(root, 'out', 'fast-history')
    const olderArchiveDir = join(historyRoot, '2026-09-01T00-00-00-000Z')
    const latestArchiveDir = join(historyRoot, '2026-09-02T00-00-00-000Z')
    mkdirSync(outputDir, { recursive: true })
    mkdirSync(olderArchiveDir, { recursive: true })
    mkdirSync(latestArchiveDir, { recursive: true })

    const archiveDir = preservePreviousFastArtifacts(outputDir, join(outputDir, 'Domi Setup 1.2.4.exe'))

    expect(archiveDir).toBeUndefined()
    expect(existsSync(olderArchiveDir)).toBe(false)
    expect(existsSync(latestArchiveDir)).toBe(true)
  })
})
