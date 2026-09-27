import * as React from 'react'
import { Check, ChevronDown, FolderOpen, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx'

export interface SessionLocationOption {
  value: string
  label: string
}

export function filterSessionLocationOptions(options: readonly SessionLocationOption[], query: string): SessionLocationOption[] {
  const text = query.trim().toLocaleLowerCase()
  return text ? options.filter((option) => option.label.toLocaleLowerCase().includes(text)) : [...options]
}

interface SessionLocationPickerProps {
  kind: 'project' | 'branch'
  currentLabel: string
  selectedValue: string | null
  options: SessionLocationOption[]
  onSelect: (value: string) => void
  onOpenLocalProject?: () => void
  disabled?: boolean
  loading?: boolean
}

/** 未绑定会话的项目 / 分支共用选择器；菜单固定向输入框上方展开。 */
export function SessionLocationPicker({
  kind,
  currentLabel,
  selectedValue,
  options,
  onSelect,
  onOpenLocalProject,
  disabled = false,
  loading = false,
}: SessionLocationPickerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const searchRef = React.useRef<HTMLInputElement>(null)
  const project = kind === 'project'
  const filteredOptions = filterSessionLocationOptions(options, query)

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery('') }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={project ? '选择项目' : '选择分支'}
          aria-expanded={open}
          className={cn(
            'flex h-8 max-w-48 items-center gap-1 rounded-md bg-transparent px-2 text-xs transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50',
            project ? 'font-semibold' : 'text-muted-foreground',
          )}
        >
          {project ? <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" /> : <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />}
          <span className="truncate">{currentLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top" sideOffset={8} align="start" avoidCollisions={false}
        onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus() }}
        className="w-64 max-w-[calc(100vw-2rem)] p-1 shadow-lg"
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={searchRef}
            value={query}
            onValueChange={setQuery}
            placeholder={project ? '搜索项目…' : '搜索分支…'}
            aria-label={project ? '搜索项目' : '搜索分支'}
          />
          <CommandList className="max-h-[min(45vh,280px)]">
            {loading ? <p role="status" className="px-3 py-3 text-xs text-muted-foreground">正在读取…</p> : (
              <>
                <CommandEmpty>{project ? '没有匹配的项目' : '没有匹配的分支'}</CommandEmpty>
                {filteredOptions.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => { setOpen(false); setQuery(''); onSelect(option.value) }}
                    className="gap-2 text-xs"
                  >
                    <Check className={cn('size-3.5', selectedValue === option.value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                    <span className="truncate">{option.label}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
        {onOpenLocalProject ? (
          <button
            type="button"
            disabled={disabled}
            className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-border/50 px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 disabled:opacity-50"
            onClick={() => { setOpen(false); setQuery(''); onOpenLocalProject() }}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            从本地打开项目…
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
