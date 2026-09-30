import { afterEach, expect, test } from 'bun:test'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { sidePaneTerminalSessionRegistry as registry } from './ZCodeSessionRegistry.ts'

class TestElement {
  parentElement: TestElement | null = null
  children: TestElement[] = []
  style: Record<string, string> = {}
  appendChild(child: TestElement): TestElement {
    child.remove()
    this.children.push(child)
    child.parentElement = this
    return child
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    this.parentElement = null
  }
  setAttribute(): void {}
}

const originalDocument = globalThis.document
function installDocument(): void {
  const body = new TestElement()
  globalThis.document = { body, createElement: () => new TestElement() } as unknown as Document
}
function element(): HTMLDivElement { return new TestElement() as unknown as HTMLDivElement }
function entry(ownerSessionId: string, terminalId: string, dispose: () => void) {
  return {
    key: `${ownerSessionId}:${terminalId}`, terminalId, cwd: '/work', workspaceKey: ownerSessionId,
    hostEl: element(), term: {} as XTerm, fitAddon: {} as FitAddon, dispose,
  }
}
afterEach(() => {
  registry.clearForTest()
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
  else globalThis.document = originalDocument
})

test('切换 Work 会话只迁移 ZCode xterm 宿主 DOM，不销毁终端和 scrollback', () => {
  installDocument()
  const first = element()
  const second = element()
  let released = 0
  const instance = entry('owner-1', 'pty-1', () => { released++ })
  registry.register('owner-1:pty-1', instance)
  registry.attachDom('owner-1:pty-1', first)
  registry.detachDom('owner-1:pty-1', first)
  expect(released).toBe(0)
  registry.attachDom('owner-1:pty-1', second)
  expect(registry.get('owner-1:pty-1')).toBe(instance)
  expect(instance.hostEl.parentElement).toBe(second)
  expect(released).toBe(0)
})

test('关闭一个终端只销毁对应 owner 的 xterm 订阅，且不可重复注册泄漏旧资源', () => {
  installDocument()
  let released = 0
  const first = entry('owner-1', 'pty-1', () => { released++ })
  const other = entry('owner-2', 'pty-1', () => { released += 100 })
  registry.register('owner-1:pty-1', first)
  registry.register('owner-2:pty-1', other)
  expect(() => registry.register('owner-1:pty-1', entry('owner-1', 'pty-1', () => {}))).toThrow()
  registry.release('owner-1:pty-1')
  registry.release('owner-1:pty-1')
  expect(released).toBe(1)
  expect(registry.get('owner-2:pty-1')).toBe(other)
})

test('旧组件卸载不会偷走新挂载组件的终端 DOM', () => {
  installDocument()
  const first = element()
  const second = element()
  const instance = entry('owner-1', 'pty-1', () => {})
  registry.register('owner-1:pty-1', instance)
  registry.attachDom('owner-1:pty-1', first)
  registry.attachDom('owner-1:pty-1', second)
  registry.detachDom('owner-1:pty-1', first)
  expect(instance.hostEl.parentElement).toBe(second)
})
