import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const preferences = readFileSync(resolve(import.meta.dir, 'ui-preferences.ts'), 'utf8')
const settings = readFileSync(resolve(import.meta.dir, '../components/settings/GeneralSettings.tsx'), 'utf8')
const sidebar = readFileSync(resolve(import.meta.dir, '../components/app-shell/LeftSidebar.tsx'), 'utf8')

test('会话悬浮预览默认开启，旧版关闭值不再覆盖默认状态，设置页不再展示开关', () => {
  expect(preferences).toContain('sessionHoverPreviewEnabledAtom = atom<boolean>(true)')
  expect(preferences).not.toContain('settings.sessionHoverPreviewEnabled')
  expect(settings).not.toContain('label="会话悬浮预览"')
  expect(settings).not.toContain('updateSessionHoverPreviewEnabled')
  expect(sidebar).toContain('useAtomValue(sessionHoverPreviewEnabledAtom)')
})
