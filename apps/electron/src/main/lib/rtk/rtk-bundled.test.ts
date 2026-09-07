import { afterEach, describe, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { findBundledRtk, findRtkExecutable, RTK_SUPPORTED_VERSION } from './rtk-bundled.ts'
import { runRtkProcess } from './rtk-process.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'domi-bundled-rtk-'))
  roots.push(root)
  const dir = join(root, 'rtk')
  await mkdir(dir)
  return { root, dir }
}

describe('内置 RTK 定位', () => {
  test('Given 资源缺失/损坏/架构不支持 When 查找 Then 不回退系统安装', async () => {
    const { dir } = await fixture()
    expect(await findBundledRtk(dir, 'win32', 'x64')).toBeUndefined()
    await writeFile(join(dir, 'rtk.exe'), 'not the official executable')
    expect(await findBundledRtk(dir, 'win32', 'x64')).toBeUndefined()
    expect(await findBundledRtk(dir, 'linux', 'ia32')).toBeUndefined()
  })
  test('Given 资源目录是 junction 或 symlink When 查找 Then 不执行外部目标', async () => {
    const { root, dir } = await fixture()
    const link = join(root, 'redirect')
    await symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await findBundledRtk(link, 'win32', 'x64')).toBeUndefined()
  })
})

const smoke = process.env.DOMI_RTK_SMOKE === '1' ? describe : describe.skip
smoke('内置 RTK 无系统安装闭环', () => {
  test('Given PATH 不含 RTK When 使用应用资源 Then 能运行 0.48.0；损坏后拒绝使用', async () => {
    const source = await findRtkExecutable()
    expect(source).toBeDefined()
    expect(source!.replaceAll('\\', '/')).toContain('/vendor/rtk/')
    const { dir } = await fixture()
    const destination = join(dir, process.platform === 'win32' ? 'rtk.exe' : 'rtk')
    await copyFile(source!, destination)
    const oldPath = process.env.PATH
    process.env.PATH = ''
    try {
      const executable = await findBundledRtk(dir)
      expect(executable).toBe(destination)
      expect((await runRtkProcess(executable!, ['--version'])).trim()).toBe(`rtk ${RTK_SUPPORTED_VERSION}`)
      await writeFile(destination, 'corrupt')
      expect(await findBundledRtk(dir)).toBeUndefined()
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
    }
    expect(await findBundledRtk(resolve(dir, '../missing'))).toBeUndefined()
  })
})
