import { describe, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

interface PackContext { electronPlatformName: string; arch: number; packager: { info: { appDir: string } }; appOutDir: string }
const preserve = createRequire(import.meta.url)('./preserve-rtk-after-pack.cjs') as (context: PackContext) => Promise<void>

test('Given 未支持的 Windows 打包架构 When afterPack Then 阻止错误资源交付', async () => {
  await expect(preserve({ electronPlatformName: 'win32', arch: 3, packager: { info: { appDir: '' } }, appOutDir: '' })).rejects.toThrow('架构')
})
const smoke = process.env.DOMI_RTK_SMOKE === '1' && process.platform === 'win32' ? describe : describe.skip
smoke('签名资源恢复官方 RTK', () => {
  test('Given transformer 改写 RTK When afterPack Then 恢复官方原件并拒绝损坏源', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-rtk-sign-'))
    const sourceDir = join(root, 'vendor/rtk/win-x64')
    const outputDir = join(root, 'out/resources/rtk')
    try {
      await mkdir(sourceDir, { recursive: true })
      await mkdir(outputDir, { recursive: true })
      const original = resolve(import.meta.dir, '../vendor/rtk/win-x64/rtk.exe')
      const source = join(sourceDir, 'rtk.exe')
      const destination = join(outputDir, 'rtk.exe')
      await copyFile(original, source)
      await writeFile(destination, 'simulated Authenticode transformer output')
      const context = { electronPlatformName: 'win32', arch: 1, packager: { info: { appDir: root } }, appOutDir: join(root, 'out') }
      await preserve(context)
      expect((await readFile(destination)).equals(await readFile(original))).toBe(true)
      await writeFile(source, 'corrupt source')
      await expect(preserve(context)).rejects.toThrow('SHA-256')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
