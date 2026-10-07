import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ReadonlyCodemodeButton } from './ReadonlyCodemodeToggle.tsx'

function render(props: Partial<Parameters<typeof ReadonlyCodemodeButton>[0]> = {}) {
  return renderToStaticMarkup(<TooltipProvider><ReadonlyCodemodeButton enabled={false} pending={false} running={false} onToggle={() => {}} {...props} /></TooltipProvider>)
}

test('默认关闭及开启状态有可访问的切换语义，不展示开发过程说明', () => {
  expect(render()).toContain('aria-label="只读 Codemode：已关闭"')
  expect(render()).toContain('aria-pressed="false"')
  expect(render({ enabled: true })).toContain('aria-label="只读 Codemode：已开启"')
  expect(render({ enabled: true })).toContain('aria-pressed="true"')
})

test('运行中仍允许改变下一轮选择，并明确当前运行不变', () => {
  const html = render({ running: true })
  expect(html).not.toContain('disabled=""')
  expect(html).toContain('当前运行不变，修改在下次运行生效')
})

test('保存中禁用；极简预设不能开启，旧选择可关闭且显示暂停原因', () => {
  expect(render({ pending: true })).toContain('disabled=""')
  expect(render({ unavailableReason: 'minimal-preset' })).toContain('disabled=""')
  const paused = render({ enabled: true, unavailableReason: 'minimal-preset' })
  expect(paused).toContain('只读 Codemode：已暂停')
  expect(paused).toContain('切回标准预设')
  expect(paused).not.toContain('disabled=""')
})
