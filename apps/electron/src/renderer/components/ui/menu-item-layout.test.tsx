import { describe, expect, test } from 'bun:test'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Pin } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextMenu, ContextMenuItem } from './context-menu.tsx'
import { DropdownMenu, DropdownMenuItem } from './dropdown-menu.tsx'

interface RenderMenuItemOptions {
  className?: string
  disabled?: boolean
}

function renderMenuItems(options: RenderMenuItemOptions = {}): string[] {
  // SSR 不渲染 Portal，直接挂载 Radix Content 来验证真实菜单项的最终样式。
  return [
    renderToStaticMarkup(
      <ContextMenu>
        <ContextMenuPrimitive.Content forceMount>
          <ContextMenuItem {...options}><Pin />置顶会话</ContextMenuItem>
        </ContextMenuPrimitive.Content>
      </ContextMenu>,
    ),
    renderToStaticMarkup(
      <DropdownMenu open>
        <DropdownMenuPrimitive.Content forceMount>
          <DropdownMenuItem {...options}><Pin />置顶会话</DropdownMenuItem>
        </DropdownMenuPrimitive.Content>
      </DropdownMenu>,
    ),
  ]
}

function getItemClasses(html: string): string[] {
  const item = html.match(/<div\b(?=[^>]*role="menuitem")[^>]*>/)?.[0]
  expect(item).toBeDefined()
  const classes = item?.match(/class="([^"]*)"/)?.[1]
  if (!classes) throw new Error('未找到菜单项样式')
  return classes.replaceAll('&amp;', '&').replaceAll('&gt;', '>').split(' ')
}

describe('普通菜单项图标布局', () => {
  test('Given 两种菜单入口 When 使用默认菜单项 Then 图标文字间距、尺寸和防压缩行为一致', () => {
    for (const html of renderMenuItems()) {
      const classes = getItemClasses(html)
      expect(classes).toContain('gap-2')
      expect(classes).toContain('[&>svg]:size-4')
      expect(classes).toContain('[&>svg]:shrink-0')
      expect(html).toContain('置顶会话')
    }
  })

  test('Given 会话菜单指定紧凑图标 When 渲染两个入口 Then 覆盖默认图标尺寸但保留间距', () => {
    for (const html of renderMenuItems({ className: 'text-xs py-1 [&>svg]:size-3.5' })) {
      const classes = getItemClasses(html)
      expect(classes).toContain('[&>svg]:size-3.5')
      expect(classes).not.toContain('[&>svg]:size-4')
      expect(classes).toContain('gap-2')
      expect(classes).toContain('[&>svg]:shrink-0')
      expect(classes).toContain('text-xs')
      expect(classes).toContain('py-1')
    }
  })

  test('Given 禁用菜单项 When 渲染两个入口 Then 保留禁用语义与图标布局', () => {
    for (const html of renderMenuItems({ disabled: true })) {
      expect(html).toContain('aria-disabled="true"')
      expect(getItemClasses(html)).toContain('gap-2')
      expect(getItemClasses(html)).toContain('data-[disabled]:pointer-events-none')
    }
  })
})
