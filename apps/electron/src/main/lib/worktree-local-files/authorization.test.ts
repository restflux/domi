import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationStore } from './authorization.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

test('授权存储按 canonical 路径跨实例互斥，失败后可立即重试且不留下磁盘锁', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'domi-local-authorization-'))
  directories.push(directory)
  const first = new AuthorizationStore(join(directory, 'approval.json'))
  const second = new AuthorizationStore(join(directory, 'approval.json'))
  await first.withLock(async () => {
    await expect(second.withLock(async () => undefined)).rejects.toMatchObject({ code: 'operation_busy' })
  })
  await expect(first.withLock(async () => { throw new Error('操作失败') })).rejects.toThrow('操作失败')
  await expect(second.withLock(async () => 'ready')).resolves.toBe('ready')
})

test('重启遗留的磁盘锁文件不会阻止本机授权操作', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'domi-local-authorization-'))
  directories.push(directory)
  const path = join(directory, 'approval.json')
  await writeFile(`${path}.lock`, '')
  const store = new AuthorizationStore(path)
  await expect(store.withLock(async () => 'ready')).resolves.toBe('ready')
})
