import * as React from 'react'
import { useTranslation } from 'react-i18next'
import '@/i18n'
import {
  Archive,
  ArchiveRestore,
  Code2,
  Copy,
  Flag,
  FolderOpen,
  FolderInput,
  MoreHorizontal,
  Images,
  Share2,
  Pencil,
  Pin,
  PinOff,
  SquareTerminal,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type {
  SessionHeaderMenuAction,
  SessionHeaderMenuEntry,
  SessionHeaderMenuSubmenuItem,
} from './session-header-menu-model.ts'

interface SessionHeaderMenuProps {
  entries: SessionHeaderMenuEntry[]
  onAction: (action: SessionHeaderMenuAction, openerId?: string) => void
}

function menuIcon(action: SessionHeaderMenuAction, label: string): React.ReactNode {
  switch (action) {
    case 'pin':
      return label.startsWith('取消') ? <PinOff /> : <Pin />
    case 'followUp':
      return <Flag />
    case 'sessionTree':
      return <Share2 />
    case 'gallery':
      return <Images />
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

/** 子菜单项图标：文件管理器 / 编辑器 / 终端 */
function subMenuItemIcon(kind: SessionHeaderMenuSubmenuItem['kind']): React.ReactNode {
  switch (kind) {
    case 'editor':
      return <Code2 />
    case 'terminal':
      return <SquareTerminal />
    case 'file-manager':
    default:
      return <FolderOpen />
  }
}

export function SessionHeaderMenu({ entries, onAction }: SessionHeaderMenuProps): React.ReactElement {
  const pendingTreeOpenRef = React.useRef(false)
  const handleCloseAutoFocus = (event: Event): void => {
    if (!pendingTreeOpenRef.current) return
    pendingTreeOpenRef.current = false
    // 先结束 DropdownMenu 的焦点恢复，再打开非模态会话树；否则还焦会被视为树外点击。
    event.preventDefault()
    onAction('sessionTree')
  }

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
      <DropdownMenuContent align="end" className="z-[9999] min-w-48 p-0.5" onCloseAutoFocus={handleCloseAutoFocus}>
        {entries.map((entry, index) => {
          if (entry.type === 'separator') {
            return <DropdownMenuSeparator key={`separator-${index}`} className="my-0.5" />
          }
          if (entry.type === 'submenu') {
            return (
              <DropdownMenuSub key={`submenu-${entry.action}`}>
                <DropdownMenuSubTrigger disabled={entry.disabled}>
                  {menuIcon(entry.action, entry.label)}
                  {entry.label}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="z-[9999] min-w-40 p-0.5">
                  {entry.items.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() => onAction(entry.action, item.id)}
                    >
                      {subMenuItemIcon(item.kind)}
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          }
          return (
            <DropdownMenuItem
              key={entry.action}
              disabled={entry.disabled}
              className={entry.destructive ? 'text-destructive focus:text-destructive' : undefined}
              onSelect={() => {
                if (entry.action === 'sessionTree') {
                  pendingTreeOpenRef.current = true
                  return
                }
                onAction(entry.action)
              }}
            >
              {menuIcon(entry.action, entry.label)}
              {entry.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface SessionRenameDialogProps {
  open: boolean
  title: string
  noun: string
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
  const { t } = useTranslation('chat')
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
          <DialogTitle>{t('rename', { noun })}</DialogTitle>
          <DialogDescription>{t('titleSyncDescription')}</DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={draft}
          maxLength={100}
          aria-label={t('titleLabel', { noun })}
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
            {t('cancel')}
          </Button>
          <Button type="button" disabled={!draft.trim() || saving} onClick={() => { void save() }}>
            {saving ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
