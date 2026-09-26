import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const html = readFileSync(join(import.meta.dir, 'index.html'), 'utf-8')
const css = readFileSync(join(import.meta.dir, 'startup-splash.css'), 'utf-8')
const app = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf-8')
const repoRoot = join(import.meta.dir, '../../../..')
const startupScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1]

function launch(search = '', reducedMotion = false) {
  let now = 0
  let nextId = 0
  let removed = false
  let ready = false
  let dotCount = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const listeners = new Map<string, () => void>()
  const swarm = { appendChild: (_fragment: unknown) => {} }
  const splash = { remove: () => { removed = true } }
  const document = {
    getElementById: (id: string) => id === 'splash' ? splash : swarm,
    createDocumentFragment: () => ({ appendChild: (_dot: unknown) => { dotCount++ } }),
    createElement: () => ({ className: '', style: { setProperty: (_key: string, _value: string) => {} } }),
    documentElement: { setAttribute: (name: string) => { if (name === 'data-app-ready') ready = true } },
  }
  const window = {
    location: { search },
    matchMedia: (_query: string) => ({ matches: reducedMotion }),
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout: (id: number) => { timers.delete(id) },
    addEventListener: (name: string, callback: () => void) => { listeners.set(name, callback) },
  }
  runInNewContext(startupScript ?? '', { window, document, performance: { now: () => now }, URLSearchParams, Math })
  return {
    get ready() { return ready },
    get removed() { return removed },
    get timers() { return timers.size },
    get dotCount() { return dotCount },
    appReady: () => listeners.get('domi-app-ready')?.(),
    advance: (ms: number) => {
      const target = now + ms
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > target) break
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
      }
      now = target
    },
  }
}

test('首帧只显示 Domi 自有字标轮廓，并保留 Percho 黑白粒子开屏', () => {
  expect(html).toContain('id="splash" role="status" aria-label="Domi 正在启动"')
  expect(html).toContain('<svg class="sp-word" aria-hidden="true" viewBox="0 0 409 104"')
  expect(html).toContain('<image href="/assets/brand/domi-wordmark.png"')
  expect((html.match(/<image /g) ?? []).length).toBe(1)
  expect(html).not.toContain('domi-mark.png')
  expect(html).not.toContain('M30 45H601')
  expect(html).not.toContain('>cap</text>')
  expect(html).not.toContain('<div class="sp-word"')
  expect(html.indexOf('startup-splash.css')).toBeLessThan(html.indexOf('src="/main.tsx"'))
  expect(css).toContain('prefers-reduced-motion: reduce')
  expect(css).toContain('body:has(#splash) #root')
  expect(css).toContain('sp-wave-out 1.8s')
  expect(css).toContain('html.dark .sp-word')
  expect(css).not.toContain('#f04438')
  expect(app).toContain("if (!isLoading) window.dispatchEvent(new Event('domi-app-ready'))")
})

test('复用 Percho 开屏时保留 MIT 版权及许可证', () => {
  const notices = readFileSync(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf-8')
  const license = readFileSync(join(repoRoot, 'third-party-licenses/MIT-Percho.txt'), 'utf-8')
  expect(notices).toContain('Percho startup animation')
  expect(notices).toContain('MIT-Percho.txt')
  expect(license).toContain('Copyright (c) 2026 Jaxton07')
})

test('主窗口就绪后展示 64 个粒子至少 2.5 秒，再按原时序散场', () => {
  const scene = launch()
  expect(scene.dotCount).toBe(64)
  scene.advance(900)
  scene.appReady()
  scene.advance(1599)
  expect(scene.ready).toBe(false)
  scene.advance(1)
  expect(scene.ready).toBe(true)
  scene.advance(2400)
  expect(scene.removed).toBe(true)
  expect(scene.timers).toBe(0)
})

test('主窗口长时间未就绪时自动退出开屏', () => {
  const scene = launch()
  scene.advance(4500)
  expect(scene.ready).toBe(true)
  scene.advance(2400)
  expect(scene.removed).toBe(true)
})

test('减少动态效果时就绪后直接散场', () => {
  const scene = launch('', true)
  scene.appReady()
  scene.advance(0)
  expect(scene.ready).toBe(true)
  scene.advance(299)
  expect(scene.removed).toBe(false)
  scene.advance(1)
  expect(scene.removed).toBe(true)
})

test('辅助窗口不创建动画计时器，也不遮盖自己的 root', () => {
  const scene = launch('?window=planning')
  expect(scene.removed).toBe(true)
  expect(scene.dotCount).toBe(0)
  expect(scene.timers).toBe(0)
})
