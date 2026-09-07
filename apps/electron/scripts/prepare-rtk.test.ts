import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import manifest from '../rtk-manifest.json'
import { getRtkTarget, prepareRtk, verifyRtkDigest } from './prepare-rtk.ts'

describe('内置 RTK 构建资源', () => {
  test('Given 明确平台 When 选择资产 Then 固定版本且拒绝未知目标', () => {
    expect(manifest.version).toBe('0.48.0')
    expect(getRtkTarget('win32', 'x64')).toBe('win-x64')
    expect(() => getRtkTarget('darwin', 'arm64')).toThrow()
    expect(() => getRtkTarget('linux', 'ia32')).toThrow()
    expect(() => getRtkTarget('../win', 'x64')).toThrow()
  })
  test('Given 下载损坏 When 校验 Then 在解包前拒绝', () => {
    expect(() => verifyRtkDigest(Buffer.from('corrupt'), manifest.targets['win-x64'].archiveSha256)).toThrow('SHA-256')
  })
  test('Given 缓存已损坏且下载不匹配 When 准备 Then 不留下可打包的错误文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-rtk-build-'))
    try {
      let downloads = 0
      await expect(prepareRtk('win-x64', root, async () => { downloads++; return Buffer.from('corrupt') })).rejects.toThrow('SHA-256')
      expect(downloads).toBe(1)
      await expect(readFile(join(root, 'win-x64', 'rtk.exe'))).rejects.toThrow()
      await writeFile(join(root, 'win-x64', 'rtk.exe'), 'invalid cache')
      await expect(prepareRtk('win-x64', root, async () => Buffer.from('bad'))).rejects.toThrow('SHA-256')
      await expect(readFile(join(root, 'win-x64', 'rtk.exe'))).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
