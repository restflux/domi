import { describe, expect, test } from 'bun:test'
import type { FileAccessOptions } from '@domi/shared'
import {
  resolvePreviewReadPath,
  type PreviewPathAccess,
  type PreviewPathResolverDependencies,
} from './preview-read-path-resolver'

function createHarness(options: {
  targetPath?: string | null
  basenamePath?: string | null
  legacyPaths?: Record<string, string | null>
  candidatePath?: string | null
  authorized?: boolean
} = {}) {
  const calls: string[] = []
  const access: PreviewPathAccess = {
    async resolveLegacyAbsolutePreviewPath(filePath) {
      calls.push(`legacy:${filePath}`)
      return options.legacyPaths?.[filePath] ?? null
    },
    usesSessionTargetPathSpace(value) {
      return value?.sessionId === 'pi-session'
        && value.pathSpace !== 'session-workbench'
        && value.pathSpace !== 'session-local-project'
    },
    async resolveRelative(_sessionId, filePath) {
      calls.push(`target:${filePath}`)
      return options.targetPath ?? null
    },
    async resolveUniquePreviewBasename(_sessionId, fileName) {
      calls.push(`basename:${fileName}`)
      return options.basenamePath ?? null
    },
  }
  const dependencies: PreviewPathResolverDependencies = {
    async resolveCandidatePath(filePath, basePaths) {
      calls.push(`candidate:${filePath}:${basePaths?.join('|') ?? ''}`)
      return options.candidatePath ?? null
    },
    async authorizeResolvedPath(filePath) {
      calls.push(`authorize:${filePath}`)
      return options.authorized ?? false
    },
  }
  return { access, dependencies, calls }
}

describe('resolvePreviewReadPath', () => {
  test('Given an implicit Active Pi path When Session Target misses it Then an authorized legacy candidate may supply the read-only preview', async () => {
    const candidate = 'C:/domi/session/.context/plan/implementation.md'
    const harness = createHarness({
      candidatePath: candidate,
      legacyPaths: { [candidate]: candidate },
    })
    const access: FileAccessOptions = {
      sessionId: 'pi-session',
      candidateBasePaths: ['C:/domi/session'],
    }

    await expect(resolvePreviewReadPath(
      '.context/plan/implementation.md',
      access,
      harness.access,
      harness.dependencies,
    )).resolves.toBe(candidate)
    expect(harness.calls).toEqual([
      'legacy:.context/plan/implementation.md',
      'target:.context/plan/implementation.md',
      'candidate:.context/plan/implementation.md:C:/domi/session',
      `legacy:${candidate}`,
    ])
  })

  test('Given a stale absolute history path When the exact file is gone Then a same-name candidate cannot silently replace it', async () => {
    const harness = createHarness({ candidatePath: 'C:/domi/session/report.md' })

    await expect(resolvePreviewReadPath(
      'X:/old/report.md',
      { sessionId: 'pi-session', candidateBasePaths: ['C:/domi/session'] },
      harness.access,
      harness.dependencies,
    )).resolves.toBeNull()
    expect(harness.calls).toEqual([
      'legacy:X:/old/report.md',
      'target:X:/old/report.md',
    ])
  })

  test('Given an explicit Session Target path When the target misses it Then candidate bases cannot override the declared path space', async () => {
    const harness = createHarness({ candidatePath: 'C:/domi/session/secret.md' })

    await expect(resolvePreviewReadPath(
      'missing.md',
      { sessionId: 'pi-session', pathSpace: 'session-target', candidateBasePaths: ['C:/domi/session'] },
      harness.access,
      harness.dependencies,
    )).resolves.toBeNull()
    expect(harness.calls).toEqual([
      'legacy:missing.md',
      'target:missing.md',
    ])
  })

  test('Given an implicit Active Pi path When the target contains it Then Session Target wins over legacy candidates', async () => {
    const targetPath = 'D:/checkout/docs/readme.md'
    const harness = createHarness({ targetPath, candidatePath: 'C:/domi/session/docs/readme.md' })

    await expect(resolvePreviewReadPath(
      'docs/readme.md',
      { sessionId: 'pi-session', candidateBasePaths: ['C:/domi/session'] },
      harness.access,
      harness.dependencies,
    )).resolves.toBe(targetPath)
    expect(harness.calls).toEqual([
      'legacy:docs/readme.md',
      'target:docs/readme.md',
    ])
  })

  test('Given an implicit Active Pi bare filename When the target has one unique match Then that target file is previewed', async () => {
    const basenamePath = 'D:/checkout/docs/report.md'
    const harness = createHarness({ basenamePath, candidatePath: 'C:/domi/session/report.md' })

    await expect(resolvePreviewReadPath(
      'report.md',
      { sessionId: 'pi-session', candidateBasePaths: ['C:/domi/session'] },
      harness.access,
      harness.dependencies,
    )).resolves.toBe(basenamePath)
    expect(harness.calls).toEqual([
      'legacy:report.md',
      'target:report.md',
      'basename:report.md',
    ])
  })

  test('Given a non-Session-Target path When a candidate resolves Then the normal session authorization still decides access', async () => {
    const candidate = 'D:/attached/report.md'
    const harness = createHarness({ candidatePath: candidate, authorized: true })

    await expect(resolvePreviewReadPath(
      'report.md',
      { sessionId: 'claude-session', candidateBasePaths: ['D:/attached'] },
      harness.access,
      harness.dependencies,
    )).resolves.toBe(candidate)
    expect(harness.calls).toContain(`authorize:${candidate}`)
  })
})
