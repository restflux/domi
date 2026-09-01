/**
 * ComposerPlusMenu — 输入框左下角「+」聚合菜单
 *
 * 聚合引用文件(@) / 命令与 Skill(/) / 使用 MCP(#) / 引用会话(&) 四个 mention 入口：
 * 点选后向编辑器光标处插入对应触发符，由既有的 suggestion 弹窗接管后续选择，
 * 与键盘直接敲 @ / # & 完全同一路径。快捷符号保留为高级用法，不再作为唯一入口。
 *
 * 时序约束（勿"优化"掉）：插入动作不在 onSelect 里直接执行，而是记录到
 * pendingCharRef，等 Radix 关闭流程走到 onCloseAutoFocus（正要把焦点还原到
 * 触发按钮）时 preventDefault 拦下焦点还原、同步聚焦编辑器并插触发符。
 * 若用固定 setTimeout 猜时机：Radix 退出动画下焦点还原落点不定，一旦落在
 * 插入之后编辑器失焦，suggestion 弹窗的 blur 守护会立刻杀掉刚弹出的面板
 * （表现为闪一下就关）。onCloseAutoFocus 是确定性的"关闭完成"时点，无竞态。
 */

import * as React from 'react'
import { AtSign, Command, Hash, MessagesSquare, Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'

const MENU_ITEMS = [
  { char: '@', label: '引用文件', icon: AtSign },
  { char: '/', label: '命令与 Skill', icon: Command },
  { char: '#', label: '使用 MCP', icon: Hash },
  { char: '&', label: '引用会话', icon: MessagesSquare },
] as const

export interface ComposerPlusMenuProps {
  onInsertTrigger?: (char: string) => void
  disabled?: boolean
}

export function ComposerPlusMenu({ onInsertTrigger, disabled = false }: ComposerPlusMenuProps): React.ReactElement {
  // 待插入的触发符：onSelect 记录，菜单关闭时在 onCloseAutoFocus 中消费；
  // Esc/点击外部关闭时不设置，走默认焦点还原。
  const pendingCharRef = React.useRef<string | null>(null)

  const handleCloseAutoFocus = (event: Event): void => {
    const char = pendingCharRef.current
    if (!char) return
    event.preventDefault()
    pendingCharRef.current = null
    onInsertTrigger?.(char)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={inputToolbarButtonClass}
          disabled={disabled}
          aria-label="插入引用或调用"
          title="插入引用或调用"
        >
          <Plus className="size-[17px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="z-[9999] min-w-56" onCloseAutoFocus={handleCloseAutoFocus}>
        {MENU_ITEMS.map(({ char, label, icon: Icon }) => (
          <DropdownMenuItem key={char} onSelect={() => { pendingCharRef.current = char }} className="gap-2.5 py-1.5">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-xs font-medium leading-4">{label}</span>
            </span>
            {/* 触发符提示：保留符号触发的可发现性 */}
            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground">
              {char}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
