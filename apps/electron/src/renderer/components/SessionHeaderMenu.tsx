import * as React from 'react'
import {
  Archive,
  ArchiveRestore,
  Copy,
  Flag,
  FolderOpen,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type {
  SessionHeaderMenuAction,
  SessionHeaderMenuEntry,
} from './session-header-menu-model.ts'

interface SessionHeaderMenuProps {
  entries: SessionHeaderMenuEntry[]
  onAction: (action: SessionHeaderMenuAction) => void
}

function menuIcon(action: SessionHeaderMenuAction, label: string): React.ReactNode {
  switch (action) {
    case 'pin':
      return label.startsWith('取消') ? <PinOff /> : <Pin />
    case 'followUp':
      return <Flag />
    case 'rename':
      return <Pencil />
    case 'archive':
      return label.startsWith('取消') ? <ArchiveRestore /> : <Archive />
    case 'move':
      return <FolderInput />
    case 'openProject':
      return <FolderOpen />
    case 'copyPath':
    case 'copyId':
      return <Copy />
    case 'delete':
      return <Trash2 />
  }
}

export function SessionHeaderMenu({ entries, onAction }: SessionHeaderMenuProps): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="更多会话操作"
          title="更多会话操作"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[9999] min-w-48 p-0.5">
        {entries.map((entry, index) => entry.type === 'separator' ? (
          <DropdownMenuSeparator key={`separator-${index}`} className="my-0.5" />
        ) : (
          <DropdownMenuItem
            key={entry.action}
            disabled={entry.disabled}
            className={entry.destructive ? 'text-destructive focus:text-destructive' : undefined}
            onSelect={() => onAction(entry.action)}
          >
            {menuIcon(entry.action, entry.label)}
            {entry.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface SessionRenameDialogProps {
  open: boolean
  title: string
  noun: '会话' | '对话'
  onOpenChange: (open: boolean) => void
  onRename: (title: string) => Promise<void>
}

export function SessionRenameDialog({
  open,
  title,
  noun,
  onOpenChange,
  onRename,
}: SessionRenameDialogProps): React.ReactElement {
  const [draft, setDraft] = React.useState(title)
  const [saving, setSaving] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    setDraft(title)
    setSaving(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [open, title])

  const save = async (): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed || saving) return
    if (trimmed === title) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    try {
      await onRename(trimmed)
      onOpenChange(false)
    } catch {
      // 调用方负责展示具体错误；保留对话框便于用户修正或重试。
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>重命名{noun}</DialogTitle>
          <DialogDescription>标题会同步更新到标签页和侧边栏。</DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={draft}
          maxLength={100}
          aria-label={`${noun}标题`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            }
          }}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={!draft.trim() || saving} onClick={() => { void save() }}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
