import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRtkOriginalStore } from './rtk-original-store.ts'

const root = mkdtempSync(join(tmpdir(), 'domi-rtk-store-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
function fixture(name: string) {
  const session = join(root, name)
  mkdirSync(session)
  return { session, save: createRtkOriginalStore(session) }
}

describe('RTK 原文存储绑定', () => {
  test('Given 绑定工作台 When 保存 Then 原文保留在该工作台且不会覆盖文件', async () => {
    const { session, save } = fixture('normal')
    const first = await save('raw content')
    const second = await save('second')
    expect(first.startsWith(join(session, 'rtk-output'))).toBe(true)
    expect(first).not.toBe(second)
    expect(readFileSync(first, 'utf8')).toBe('raw content')
  })
  test('Given 绑定后工作台被 junction/symlink 替换 When 保存 Then 不写替代目标', async () => {
    const { session, save } = fixture('replaced-root')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    renameSync(session, `${session}-old`)
    symlinkSync(outside, session, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(save('secret raw')).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  })
  test('Given 已有输出目录被替换 When 保存 Then 拒绝新目录身份', async () => {
    const { session, save } = fixture('replaced-output')
    await save('first')
    const output = join(session, 'rtk-output')
    renameSync(output, `${output}-old`)
    mkdirSync(output)
    await expect(save('secret raw')).rejects.toThrow()
    expect(readdirSync(output)).toEqual([])
  })
  test('Given 原文达到上限 When 保存 Then 拒绝而不删除旧证据', async () => {
    const { session, save } = fixture('quota')
    const output = join(session, 'rtk-output')
    mkdirSync(output)
    for (let i = 0; i < 256; i++) writeFileSync(join(output, `${i}.txt`), 'evidence')
    await expect(save('new')).rejects.toThrow('上限')
    expect(readdirSync(output)).toHaveLength(256)
  })
})
