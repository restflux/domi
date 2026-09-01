import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileExtensionTrustStore } from './adapters/pi-extension-trust.ts'
import { PiExtensionTrustService } from './pi-extension-trust-service.ts'

const tempRoots: string[] = []

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'domi-extension-trust-service-'))
  tempRoots.push(root)
  const projectRoot = join(root, 'project')
  const otherProjectRoot = join(root, 'other-project')
  const extensionPath = join(root, 'extension.ts')
  mkdirSync(projectRoot)
  mkdirSync(otherProjectRoot)
  writeFileSync(extensionPath, 'export default function extension() {}\n')
  const store = new FileExtensionTrustStore(join(root, 'profile', 'extension-trust.json'))
  const service = new PiExtensionTrustService({
    store,
    picker: async () => extensionPath,
    workspaceResolver: (workspaceId) => {
      if (workspaceId === 'workspace-a') return { workspaceId, projectId: 'project-a', projectRoot }
      if (workspaceId === 'workspace-b') return { workspaceId, projectId: 'project-b', projectRoot: otherProjectRoot }
      return undefined
    },
    tokenFactory: () => 'opaque-candidate-token',
    now: () => 1_000,
  })
  return { projectRoot, extensionPath, store, service }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('PiExtensionTrustService', () => {
  test('Given renderer 只提交 workspace 与来源种类 When 主进程选择候选 Then 返回 opaque token 与摘要预览', async () => {
    const { extensionPath, service } = makeFixture()

    const candidate = await service.pickCandidate({ workspaceId: 'workspace-a', kind: 'file' })

    expect(candidate).toEqual({
      candidateToken: 'opaque-candidate-token',
      path: extensionPath,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      kind: 'file',
    })
  })

  test('Given preview 后源码变化 When approve Then 拒绝且 token 一次性失效', async () => {
    const { extensionPath, service, store, projectRoot } = makeFixture()
    const candidate = await service.pickCandidate({ workspaceId: 'workspace-a', kind: 'file' })
    expect(candidate).not.toBeNull()
    writeFileSync(extensionPath, 'export default function changed() {}\n')

    await expect(service.approve({
      workspaceId: 'workspace-a',
      candidateToken: candidate!.candidateToken,
    })).rejects.toThrow('候选内容已变化')
    await expect(service.approve({
      workspaceId: 'workspace-a',
      candidateToken: candidate!.candidateToken,
    })).rejects.toThrow('候选已失效')
    expect(store.resolveTrustedPaths(projectRoot)).toEqual([])
  })

  test('Given 候选绑定另一项目 When approve Then 拒绝跨项目授权', async () => {
    const { service } = makeFixture()
    const candidate = await service.pickCandidate({ workspaceId: 'workspace-a', kind: 'file' })

    await expect(service.approve({
      workspaceId: 'workspace-b',
      candidateToken: candidate!.candidateToken,
    })).rejects.toThrow('候选不属于当前项目')
  })

  test('Given 未知 workspace When pick/list/revoke Then 全部拒绝', async () => {
    const { service } = makeFixture()

    await expect(service.pickCandidate({ workspaceId: 'unknown', kind: 'file' })).rejects.toThrow('项目不存在')
    await expect(service.list({ workspaceId: 'unknown' })).rejects.toThrow('项目不存在')
    await expect(service.revoke({ workspaceId: 'unknown', extensionId: 'extension' })).rejects.toThrow('项目不存在')
  })

  test('Given 已批准候选 When list 后 revoke Then 授权立即移除', async () => {
    const { service } = makeFixture()
    const candidate = await service.pickCandidate({ workspaceId: 'workspace-a', kind: 'file' })
    const approved = await service.approve({
      workspaceId: 'workspace-a',
      candidateToken: candidate!.candidateToken,
    })

    expect(await service.list({ workspaceId: 'workspace-a' })).toEqual([
      expect.objectContaining({ extensionId: approved.extensionId, status: 'valid' }),
    ])
    await service.revoke({ workspaceId: 'workspace-a', extensionId: approved.extensionId })
    expect(await service.list({ workspaceId: 'workspace-a' })).toEqual([])
  })
})
