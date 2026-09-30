import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTerminalFontProfile } from './terminal-profile.ts'

describe('v2 交互终端继承系统 profile', () => {
  test('Given VS Code 用户配置，When 探测系统 profile，Then 返回用户字体、字号及来源', () => {
    const home = mkdtempSync(join(tmpdir(), 'domi-terminal-profile-'))
    try {
      const config = join(home, '.config', 'Code', 'User')
      mkdirSync(config, { recursive: true })
      writeFileSync(join(config, 'settings.json'), JSON.stringify({
        'terminal.integrated.fontFamily': 'Cascadia Code',
        'terminal.integrated.fontSize': 16,
      }))
      const result = resolveTerminalFontProfile({ settings: {}, env: { HOME: home, USERPROFILE: home } })
      expect(result).toMatchObject({ source: 'system', fontSize: 16 })
      expect(result.fontFamily.startsWith('Cascadia Code,')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Given Alacritty TOML/YAML 配置，When 探测字体，Then 通过已核许可证的解析器读取并容错', () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const home = mkdtempSync(join(tmpdir(), 'domi-terminal-profile-'))
    try {
      const config = join(home, '.config', 'alacritty')
      mkdirSync(config, { recursive: true })
      writeFileSync(join(config, 'alacritty.toml'), '[font.normal]\nfamily = "Iosevka"\n')
      expect(resolveTerminalFontProfile({ settings: {}, env: { HOME: home, USERPROFILE: home } }).fontFamily.startsWith('Iosevka,')).toBe(true)
      rmSync(join(config, 'alacritty.toml'))
      writeFileSync(join(config, 'alacritty.yml'), 'font:\n  normal:\n    family: "Fira Mono"\n')
      expect(resolveTerminalFontProfile({ settings: {}, env: { HOME: home, USERPROFILE: home } }).fontFamily.startsWith('Fira Mono,')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Given 超过 1 MiB 的用户配置，When 探测 profile，Then 跳过文件并使用 fallback', () => {
    const home = mkdtempSync(join(tmpdir(), 'domi-terminal-profile-'))
    try {
      const config = join(home, '.config', 'Code', 'User')
      mkdirSync(config, { recursive: true })
      writeFileSync(join(config, 'settings.json'), JSON.stringify({
        'terminal.integrated.fontFamily': `Oversized${'a'.repeat(1024 * 1024)}`,
      }))
      expect(resolveTerminalFontProfile({ settings: {}, env: { HOME: home, USERPROFILE: home } }).source).toBe('fallback')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Given 关闭继承，When 解析 profile，Then 不探测 HOME 而使用真实 fallback 来源', () => {
    const result = resolveTerminalFontProfile({
      settings: { terminalInheritSystemProfile: false },
      env: { HOME: '/nonexistent/terminal-profile' },
    })
    expect(result.source).toBe('fallback')
    expect(result.fontFamily).toContain('monospace')
  })
})
