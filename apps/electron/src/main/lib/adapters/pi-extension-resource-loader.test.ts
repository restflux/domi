import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { FileExtensionTrustStore } from './pi-extension-trust.ts'
import { createTrustedPiResourceLoader } from './pi-extension-resource-loader.ts'

const tempRoots: string[] = []
const executionFlags = globalThis as typeof globalThis & Record<string, unknown>

function makeFixture(name: string): {
  root: string
  projectRoot: string
  agentDir: string
  storePath: string
  extensionPath: string
  flag: string
} {
  const root = mkdtempSync(join(tmpdir(), 'domi-extension-loader-'))
  tempRoots.push(root)
  const projectRoot = join(root, 'project')
  const agentDir = join(root, 'agent')
  const extensionDir = join(projectRoot, '.pi', 'extensions')
  mkdirSync(extensionDir, { recursive: true })
  mkdirSync(agentDir)
  const extensionPath = join(extensionDir, `${name}.ts`)
  const flag = `__domi_${name}_${Date.now()}_${Math.random()}`
  writeFileSync(extensionPath, `globalThis[${JSON.stringify(flag)}] = true\nexport default function extension() {}\n`)
  return { root, projectRoot, agentDir, storePath: join(root, 'profile', 'extension-trust.json'), extensionPath, flag }
}

function createLoader(
  fixture: ReturnType<typeof makeFixture>,
  store: FileExtensionTrustStore,
  extensionFactories: NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionFactories']> = [],
) {
  return createTrustedPiResourceLoader(
    { DefaultResourceLoader },
    store,
    fixture.projectRoot,
    {
      cwd: fixture.projectRoot,
      agentDir: fixture.agentDir,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories,
    },
  )
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Pi ResourceLoader Extension Trust', () => {
  test('Given 项目中存在未授权扩展 When ResourceLoader reload Then 顶层代码不会求值', async () => {
    const fixture = makeFixture('untrusted')
    const store = new FileExtensionTrustStore(fixture.storePath)

    const loader = createLoader(fixture, store)
    await loader.reload()

    expect(executionFlags[fixture.flag]).toBeUndefined()
    expect(loader.getExtensions().extensions).toHaveLength(0)
  })

  test('Given 外部扩展已批准且摘要一致 When ResourceLoader reload Then 才求值并加载', async () => {
    const fixture = makeFixture('approved')
    const store = new FileExtensionTrustStore(fixture.storePath)
    store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath })

    const loader = createLoader(fixture, store)
    await loader.reload()

    expect(executionFlags[fixture.flag]).toBe(true)
    expect(loader.getExtensions().extensions).toHaveLength(1)
  })

  test('Given 已批准扩展内容变化 When ResourceLoader reload Then 变化后的顶层代码不会求值', async () => {
    const fixture = makeFixture('changed')
    const store = new FileExtensionTrustStore(fixture.storePath)
    store.approve({ projectRoot: fixture.projectRoot, path: fixture.extensionPath })
    writeFileSync(
      fixture.extensionPath,
      `globalThis[${JSON.stringify(fixture.flag)}] = 'changed-code-executed'\nexport default function extension() {}\n`,
    )

    const loader = createLoader(fixture, store)
    await loader.reload()

    expect(executionFlags[fixture.flag]).toBeUndefined()
    expect(loader.getExtensions().extensions).toHaveLength(0)
  })

  test('Given 没有外部 Extension trust When 提供 built-in inline factory Then factory 仍加载', async () => {
    const fixture = makeFixture('builtin')
    const builtInFlag = `${fixture.flag}_inline`
    const store = new FileExtensionTrustStore(fixture.storePath)

    const loader = createLoader(fixture, store, [() => {
      executionFlags[builtInFlag] = true
    }])
    await loader.reload()

    expect(executionFlags[fixture.flag]).toBeUndefined()
    expect(executionFlags[builtInFlag]).toBe(true)
    expect(loader.getExtensions().extensions).toHaveLength(1)
  })
})
