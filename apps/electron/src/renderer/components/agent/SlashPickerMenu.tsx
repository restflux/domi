/**
 * SlashPickerMenu — `/` 命令子菜单通用弹层（/workflow、/reasoning、/fork 共用）。
 *
 * 以 Dialog 形式列出选项；支持完整键盘导航：
 * - 打开时聚焦当前选中项（activeValue 匹配）或第一个可用项
 * - ↑/↓ 在选项间移动焦点（跳过 disabled，到达边界停止），Home/End 跳首尾
 * - Enter/Space 由原生 button 激活；Esc 由 Dialog 默认关闭
 *
 * 导航逻辑抽为纯函数 movePickerFocusIndex，列表渲染抽为 SlashPickerMenuList
 * （纯展示，可用 renderToStaticMarkup 测试）。
 */
import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { handleOptionalDialogCloseAutoFocus } from '@/lib/dialog-focus'
import { cn } from '@/lib/utils'

export interface SlashPickerOption {
  value: string
  label: string
  description?: string
  icon?: LucideIcon
  disabled?: boolean
  /** 危险项（如 Full Access）显示警告色。 */
  danger?: boolean
}

interface SlashPickerMenuProps {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  options: SlashPickerOption[]
  /** 当前选中值（用于勾选标记与初始聚焦）。 */
  activeValue?: string
  onSelect: (value: string) => void
  /** Dialog 任意关闭路径完成后恢复指定焦点。 */
  restoreFocusOnClose?: () => void
}

/**
 * 计算方向键移动后的目标索引：跳过 disabled 项，到达边界停止。
 * 当前索引不合法（-1 或指向 disabled）时先回退到最近可用项。
 */
export function movePickerFocusIndex(
  current: number,
  delta: number,
  options: readonly SlashPickerOption[],
): number {
  if (options.length === 0) return -1
  let next = current
  for (let step = 0; step < options.length; step += 1) {
    next += delta
    if (next < 0 || next >= options.length) return current
    if (!options[next]?.disabled) return next
  }
  return current
}

/** 第一个可用项索引；无可用项返回 -1。 */
export function firstEnabledPickerIndex(options: readonly SlashPickerOption[]): number {
  return options.findIndex((option) => !option.disabled)
}

/** 最后一个可用项索引；无可用项返回 -1。 */
export function lastEnabledPickerIndex(options: readonly SlashPickerOption[]): number {
  for (let i = options.length - 1; i >= 0; i -= 1) {
    if (!options[i]?.disabled) return i
  }
  return -1
}

interface SlashPickerMenuListProps {
  title: string
  options: SlashPickerOption[]
  activeValue?: string
  /** 当前键盘焦点索引（-1 表示无）。 */
  focusIndex: number
  listboxId: string
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onSelect: (value: string) => void
  onFocusOption: (index: number) => void
  optionRef: (el: HTMLButtonElement | null, index: number) => void
}

/** 纯展示列表（listbox）；键盘事件与焦点状态由父组件管理。 */
export function SlashPickerMenuList({
  title,
  options,
  activeValue,
  focusIndex,
  listboxId,
  onKeyDown,
  onSelect,
  onFocusOption,
  optionRef,
}: SlashPickerMenuListProps): React.ReactElement {
  return (
    <div
      id={listboxId}
      className="flex flex-col gap-1 py-1"
      role="listbox"
      aria-label={title}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const Icon = option.icon
        const active = option.value === activeValue
        const focused = index === focusIndex
        return (
          <button
            key={option.value}
            ref={(el) => optionRef(el, index)}
            type="button"
            role="option"
            id={`${listboxId}-option-${index}`}
            aria-selected={active}
            disabled={option.disabled}
            onFocus={() => onFocusOption(index)}
            onClick={() => {
              if (option.disabled) return
              onSelect(option.value)
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
              'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
              focused && 'bg-accent/70',
              active && 'bg-accent/60',
            )}
          >
            {Icon ? <Icon className={cn('size-4 flex-shrink-0', option.danger ? 'text-destructive' : 'text-muted-foreground')} /> : null}
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate font-medium', option.danger && 'text-destructive')}>{option.label}</span>
              {option.description ? (
                <span className="block truncate text-[11px] text-muted-foreground/70">{option.description}</span>
              ) : null}
            </span>
            {active ? <Check className="size-4 flex-shrink-0 text-primary" /> : null}
          </button>
        )
      })}
    </div>
  )
}

export function SlashPickerMenu({
  title,
  open,
  onOpenChange,
  options,
  activeValue,
  onSelect,
  restoreFocusOnClose,
}: SlashPickerMenuProps): React.ReactElement {
  const optionRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  const [focusIndex, setFocusIndex] = React.useState(-1)
  const listboxId = React.useId()

  const setOptionRef = React.useCallback((el: HTMLButtonElement | null, index: number): void => {
    optionRefs.current[index] = el
  }, [])

  // 打开时聚焦 activeValue 匹配项（跳过 disabled）或第一个可用项。
  React.useEffect(() => {
    if (!open) return
    const activeIndex = options.findIndex((option) => !option.disabled && option.value === activeValue)
    const initial = activeIndex >= 0 ? activeIndex : firstEnabledPickerIndex(options)
    setFocusIndex(initial)
    const frame = requestAnimationFrame(() => {
      if (initial >= 0) optionRefs.current[initial]?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, activeValue, options])

  // focusIndex 变化时聚焦对应按钮（方向键移动后）。
  React.useEffect(() => {
    if (!open || focusIndex < 0) return
    optionRefs.current[focusIndex]?.focus()
  }, [focusIndex, open])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setFocusIndex((current) => movePickerFocusIndex(current, 1, options))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setFocusIndex((current) => movePickerFocusIndex(current, -1, options))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setFocusIndex(firstEnabledPickerIndex(options))
    } else if (event.key === 'End') {
      event.preventDefault()
      setFocusIndex(lastEnabledPickerIndex(options))
    }
  }, [options])

  const handleSelect = React.useCallback((value: string): void => {
    onOpenChange(false)
    onSelect(value)
  }, [onOpenChange, onSelect])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm"
        onCloseAutoFocus={(event) => handleOptionalDialogCloseAutoFocus(event, restoreFocusOnClose)}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <SlashPickerMenuList
          title={title}
          options={options}
          activeValue={activeValue}
          focusIndex={focusIndex}
          listboxId={listboxId}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onFocusOption={setFocusIndex}
          optionRef={setOptionRef}
        />
      </DialogContent>
    </Dialog>
  )
}
