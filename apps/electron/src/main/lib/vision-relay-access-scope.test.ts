import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildVisionRelayAccessScope,
  filterStableVisionRelayAccessScope,
  isCanonicalVisionPathAuthorized,
  type VisionRelayPathGrant,
} from './vision-relay-access-scope'

const tempRoot = mkdtempSync(join(tmpdir(), 'domi-vision-scope-'))
const targetRoot = join(tempRoot, 'target')
const workbenchRoot = join(tempRoot, 'workbench')
const attachedRoot = join(tempRoot, 'assets')
const attachedFile = join(tempRoot, 'private', 'only-this.png')

beforeAll(() => {
  mkdirSync(targetRoot, { recursive: true })
  mkdirSync(workbenchRoot, { recursive: true })
  mkdirSync(attachedRoot, { recursive: true })
  mkdirSync(join(tempRoot, 'private'), { recursive: true })
  writeFileSync(attachedFile, 'image')
})

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

function grant(path: string): VisionRelayPathGrant {
  return { path, dev: 1, ino: 1 }
}

function actualGrant(path: string): VisionRelayPathGrant {
  const canonicalPath = realpathSync(path)
  const stats = lstatSync(canonicalPath)
  return { path: canonicalPath, dev: stats.dev, ino: stats.ino }
}

describe('Vision Relay access scope', () => {
  test('snapshots canonical target, workbench, explicit directory and exact-file identities', () => {
    const scope = buildVisionRelayAccessScope({
      targetRoot,
      sessionWorkbenchRoot: workbenchRoot,
      attachedDirectories: [attachedRoot, attachedRoot],
    })
    expect(scope.roots.map((item) => item.path)).toEqual([
      realpathSync(targetRoot),
      realpathSync(workbenchRoot),
      realpathSync(attachedRoot),
    ])
    expect(scope.files).toEqual([])
    expect(filterStableVisionRelayAccessScope(scope)).toEqual(scope)
  })

  test('authorizes descendants and exact files but not siblings or parent-directory expansion', () => {
    const scope = buildVisionRelayAccessScope({ targetRoot })
    scope.files.push(actualGrant(attachedFile))
    expect(isCanonicalVisionPathAuthorized(join(targetRoot, 'assets', 'screen.png'), scope)).toBe(true)
    expect(isCanonicalVisionPathAuthorized(attachedFile, scope)).toBe(true)
    expect(isCanonicalVisionPathAuthorized(join(tempRoot, 'private', 'secret.png'), scope)).toBe(false)
    expect(isCanonicalVisionPathAuthorized(`${targetRoot}-escape${join('', 'screen.png')}`, scope)).toBe(false)
  })

  test('a symlink or junction redirected after authorization cannot move the captured root', () => {
    const benign = join(tempRoot, 'benign-grant')
    const secret = join(tempRoot, 'secret-target')
    const link = join(tempRoot, 'directory-grant')
    mkdirSync(benign, { recursive: true })
    mkdirSync(secret, { recursive: true })
    writeFileSync(join(secret, 'secret.png'), 'secret')
    symlinkSync(benign, link, process.platform === 'win32' ? 'junction' : 'dir')
    const scope = buildVisionRelayAccessScope({ attachedDirectories: [link] })
    rmSync(link, { recursive: true, force: true })
    symlinkSync(secret, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(isCanonicalVisionPathAuthorized(realpathSync(join(link, 'secret.png')), filterStableVisionRelayAccessScope(scope))).toBe(false)
    } finally {
      rmSync(link, { recursive: true, force: true })
    }
  })

  test('identity replacement invalidates a previously captured exact-file grant', () => {
    const replaceable = join(tempRoot, 'private', 'replaceable.png')
    writeFileSync(replaceable, 'first')
    const scope = { roots: [], files: [actualGrant(replaceable)] }
    rmSync(replaceable)
    writeFileSync(replaceable, 'second')
    expect(filterStableVisionRelayAccessScope(scope).files).toHaveLength(0)
  })

  test('Windows comparison is case-insensitive and fails closed across drives and UNC roots', () => {
    const scope = {
      roots: [grant('C:\\Repo'), grant('\\\\server\\share\\assets')],
      files: [grant('E:\\downloads\\attached.png')],
    }
    expect(isCanonicalVisionPathAuthorized('c:\\repo\\IMAGE.PNG', scope, 'win32')).toBe(true)
    expect(isCanonicalVisionPathAuthorized('D:\\Repo\\image.png', scope, 'win32')).toBe(false)
    expect(isCanonicalVisionPathAuthorized('\\\\server\\share\\assets\\image.png', scope, 'win32')).toBe(true)
    expect(isCanonicalVisionPathAuthorized('\\\\server\\share2\\assets\\image.png', scope, 'win32')).toBe(false)
    expect(isCanonicalVisionPathAuthorized('E:\\downloads\\attached.png', scope, 'win32')).toBe(true)
    expect(isCanonicalVisionPathAuthorized('E:\\downloads\\password-backup.png', scope, 'win32')).toBe(false)
  })

  test('POSIX comparison remains case-sensitive', () => {
    const scope = { roots: [grant('/workspace/Repo')], files: [] }
    expect(isCanonicalVisionPathAuthorized('/workspace/Repo/image.png', scope, 'linux')).toBe(true)
    expect(isCanonicalVisionPathAuthorized('/workspace/repo/image.png', scope, 'linux')).toBe(false)
  })
})
