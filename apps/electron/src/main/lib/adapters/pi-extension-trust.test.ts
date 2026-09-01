import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileExtensionTrustStore } from './pi-extension-trust.ts'

const tempRoots: string[] = []

function makeFixture(): { root: string; projectRoot: string; storePath: string; extensionPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'domi-extension-trust-'))
  tempRoots.push(root)
  const projectRoot = join(root, 'project')
  mkdirSync(projectRoot)
  const extensionPath = join(root, 'extension.ts')
  writeFileSync(extensionPath, 'export default function extension() {}\n')
  return { root, projectRoot, storePath: join(root, 'profile', 'extension-trust.json'), extensionPath }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Pi Extension Trust', () => {
  test('Given 未授权候选 When 解析可信路径 Then 不返回该路径', () => {
    const fixture = makeFixture()
    const store = new FileExtensionTrustStore(fixture.storePath)

    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([])
  })

  test('Given 用户批准本地扩展 When 内容摘要一致 Then 返回 canonical 可信路径', () => {
    const fixture = makeFixture()
    const store = new FileExtensionTrustStore(fixture.storePath)

    const approved = store.approve({
      projectRoot: fixture.projectRoot,
      path: fixture.extensionPath,
    })

    expect(approved.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([
      { extensionId: approved.extensionId, path: fixture.extensionPath },
    ])
  })

  test('Given 已批准扩展 When 文件内容改变 Then 旧授权失效', () => {
    const fixture = makeFixture()
    const store = new FileExtensionTrustStore(fixture.storePath)
    store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath })

    writeFileSync(fixture.extensionPath, 'globalThis.changedExtensionExecuted = true\n')

    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([])
  })

  test('Given 已批准扩展 When 内容变化或文件丢失 Then 列表在求值前显示 stale/missing', () => {
    const fixture = makeFixture()
    const store = new FileExtensionTrustStore(fixture.storePath)
    const approved = store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath })

    expect(store.list(fixture.projectRoot)).toEqual([expect.objectContaining({
      extensionId: approved.extensionId,
      path: fixture.extensionPath,
      digest: approved.digest,
      status: 'valid',
    })])

    writeFileSync(fixture.extensionPath, 'export default function changed() {}\n')
    expect(store.list(fixture.projectRoot)[0]?.status).toBe('stale')

    unlinkSync(fixture.extensionPath)
    expect(store.list(fixture.projectRoot)[0]?.status).toBe('missing')
  })

  test('Given 候选 preview When approve 前内容变化 Then 不写入授权', () => {
    const fixture = makeFixture()
    const store = new FileExtensionTrustStore(fixture.storePath)
    const preview = store.inspect({ projectRoot: fixture.projectRoot, path: fixture.extensionPath })
    writeFileSync(fixture.extensionPath, 'export default function changed() {}\n')

    expect(() => store.approve(
      { projectRoot: fixture.projectRoot, path: fixture.extensionPath },
      preview,
    )).toThrow('候选内容已变化')
    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([])
  })

  test('Given 已批准扩展 When 撤销当前项目授权 Then 不再返回该路径', () => {
    const fixture = makeFixture()
    const store = new FileExtensionTrustStore(fixture.storePath)
    const approved = store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath })

    store.revoke(fixture.projectRoot, approved.extensionId)

    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([])
  })

  test('Given canonical 路径别名 When 批准并从别名项目解析 Then 复用同一授权', () => {
    const fixture = makeFixture()
    const aliasRoot = join(fixture.root, 'alias')
    symlinkSync(fixture.root, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const store = new FileExtensionTrustStore(fixture.storePath)

    const approved = store.approve({
      projectRoot: join(aliasRoot, 'project'),
      path: join(aliasRoot, 'extension.ts'),
    })

    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([
      { extensionId: approved.extensionId, path: fixture.extensionPath },
    ])
  })

  test('Given trust store 损坏 When 解析可信路径 Then fail closed', () => {
    const fixture = makeFixture()
    mkdirSync(join(fixture.root, 'profile'))
    writeFileSync(fixture.storePath, '{not-json')
    const store = new FileExtensionTrustStore(fixture.storePath)

    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([])
    expect(() => store.list(fixture.projectRoot)).toThrow('Extension Trust 存储已损坏')
    expect(() => store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath }))
      .toThrow('Extension Trust 存储已损坏')
  })

  test('Given Pi 目录扩展 When 批准且目录内容一致 Then 返回目录路径', () => {
    const fixture = makeFixture()
    const directoryPath = join(fixture.root, 'directory-extension')
    mkdirSync(directoryPath)
    writeFileSync(join(directoryPath, 'index.ts'), 'export default function extension() {}\n')
    writeFileSync(join(directoryPath, 'helper.js'), 'export const value = 1\n')
    const store = new FileExtensionTrustStore(fixture.storePath)

    const approved = store.approve({ projectRoot: fixture.projectRoot, path: directoryPath })

    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([
      { extensionId: approved.extensionId, path: directoryPath },
    ])
    writeFileSync(join(directoryPath, 'helper.js'), 'export const value = 2\n')
    expect(store.resolveTrustedPaths(fixture.projectRoot)).toEqual([])
  })

  test('Given 两个目录的裸字段可产生相同拼接 When 批准 Then 长度 framing 生成不同摘要', () => {
    const fixture = makeFixture()
    const oneFilePath = join(fixture.root, 'one-file-extension')
    const twoFilePath = join(fixture.root, 'two-file-extension')
    mkdirSync(oneFilePath)
    mkdirSync(twoFilePath)
    writeFileSync(join(oneFilePath, 'index.ts'), 'base\0file\0z.ts\0tail')
    writeFileSync(join(twoFilePath, 'index.ts'), 'base')
    writeFileSync(join(twoFilePath, 'z.ts'), 'tail')
    const store = new FileExtensionTrustStore(fixture.storePath)

    const oneFile = store.approve({ projectRoot: fixture.projectRoot, path: oneFilePath })
    const twoFiles = store.approve({ projectRoot: fixture.projectRoot, path: twoFilePath })

    expect(oneFile.digest).not.toBe(twoFiles.digest)
  })

  test('Given 单文件候选导入相对或绝对源码 When 批准 Then fail closed', () => {
    const fixture = makeFixture()
    const store = new FileExtensionTrustStore(fixture.storePath)
    const disallowedSources = [
      "import './helper.ts'\nexport default function extension() {}\n",
      "const helper = await import('../helper.ts')\nexport default function extension() {}\n",
      "const source = './helper.ts'\nconst helper = await import(source)\nexport default function extension() {}\n",
      "const helper = await import /* comment */ ('./helper.ts')\nexport default function extension() {}\n",
      "const helper = require('C:\\\\private\\\\helper.cjs')\nmodule.exports = function extension() {}\n",
    ]

    for (const source of disallowedSources) {
      writeFileSync(fixture.extensionPath, source)
      expect(() => store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath }))
        .toThrow('单文件 Pi Extension')
    }
  })

  test('Given 单文件候选只导入 bare package When 批准 Then 允许自包含扩展', () => {
    const fixture = makeFixture()
    writeFileSync(
      fixture.extensionPath,
      "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'\nexport default function extension(_pi: ExtensionAPI) {}\n",
    )
    const store = new FileExtensionTrustStore(fixture.storePath)

    expect(store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath }).digest)
      .toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('Given 目录候选包含 junction When junction 指向候选外 Then 拒绝批准', () => {
    const fixture = makeFixture()
    const directoryPath = join(fixture.root, 'junction-extension')
    const externalDirectoryPath = join(fixture.root, 'external-source')
    mkdirSync(directoryPath)
    mkdirSync(externalDirectoryPath)
    writeFileSync(join(directoryPath, 'index.ts'), 'export default function extension() {}\n')
    writeFileSync(join(externalDirectoryPath, 'escaped.ts'), 'export const escaped = true\n')
    symlinkSync(externalDirectoryPath, join(directoryPath, 'escaped'), 'junction')
    const store = new FileExtensionTrustStore(fixture.storePath)

    expect(() => store.approve({ projectRoot: fixture.projectRoot, path: directoryPath }))
      .toThrow('不允许 symlink')
  })
})
