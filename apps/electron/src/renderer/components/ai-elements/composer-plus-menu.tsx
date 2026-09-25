/**
 * ComposerPlusMenu — 输入框左下角「+」入口。
 * 默认保留引用菜单；浅色现代 Work 还可在同一入口查找附件、语音与呈现设置。
 * 引用触发符必须等菜单关闭并阻止焦点回到「+」后再插入，否则 suggestion 会被 blur 关闭。
 */

import * as React from 'react'
import { Activity, AtSign, Check, ChevronDown, Command, FileText, FolderOpen, Hash, MessagesSquare, MicIcon, Plus, SlidersHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { toggleVoiceDictation, useVoiceDictationStatus } from './speech-button'

const MENU_ITEMS = [
  { char: '@', label: '引用文件', icon: AtSign },
  { char: '&', label: '引用会话', icon: MessagesSquare },
  { char: '/', label: '命令与 Skill', icon: Command },
  { char: '#', label: '使用 MCP', icon: Hash },
] as const

interface ComposerPlusTools {
  onAttachFile: () => void
  onAttachDirectory: () => void
  onOpenSessionStatus: () => void
  minimalPresetEnabled: boolean
  presetDisabled: boolean
  onSetPreset: (preset: 'standard' | 'minimal') => void
  imageGeneration?: React.ReactNode
}

export interface ComposerPlusMenuProps {
  onInsertTrigger?: (char: string) => void
  onSideChat?: () => void
  disabled?: boolean
  /** 默认浅色 Work 的次级工具；执行方式继续在输入框上直接可见。 */
  tools?: ComposerPlusTools
}

export function ComposerPlusMenu({ onInsertTrigger, onSideChat, disabled = false, tools }: ComposerPlusMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [presetExpanded, setPresetExpanded] = React.useState(false)
  const pendingActionRef = React.useRef<(() => void) | null>(null)
  const pendingCharRef = React.useRef<string | null>(null)
  const voiceStatus = useVoiceDictationStatus()
  const voiceActive = voiceStatus.status === 'recording' || voiceStatus.status === 'connecting' || voiceStatus.status === 'stopping'

  const handleCloseAutoFocus = (event: Event): void => {
    const char = pendingCharRef.current
    const action = pendingActionRef.current
    pendingCharRef.current = null
    pendingActionRef.current = null
    setPresetExpanded(false)
    if (!char && !action) return
    event.preventDefault()
    if (char) onInsertTrigger?.(char)
    else action?.()
  }

  const closeThen = (action: () => void): void => {
    pendingActionRef.current = action
    setOpen(false)
  }

  if (tools) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`${inputToolbarButtonClass} relative`}
            disabled={disabled}
            aria-label="更多输入工具"
            title="更多输入工具"
          >
            <Plus className="size-[17px]" />
            {voiceActive && <span aria-label="正在听写" role="status" className="absolute right-0 top-0 size-1.5 rounded-full bg-destructive" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="z-[9999] max-h-[min(68vh,30rem)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto p-1.5" onCloseAutoFocus={handleCloseAutoFocus}>
          <div className="composer-plus-group-label">添加内容</div>
          <button type="button" className="composer-plus-item" onClick={() => closeThen(tools.onAttachFile)}><FileText /><span>添加文件</span></button>
          <button type="button" className="composer-plus-item" onClick={() => closeThen(tools.onAttachDirectory)}><FolderOpen /><span>添加文件夹</span></button>
          {tools.imageGeneration}
          <button type="button" className="composer-plus-item" onClick={() => closeThen(() => { void toggleVoiceDictation() })}>
            <MicIcon /><span>{voiceActive ? '停止语音输入' : '语音输入'}</span>
          </button>
          <div className="composer-plus-group-label">引用与调用</div>
          {MENU_ITEMS.map(({ char, label, icon: Icon }) => (
            <button
              key={char}
              type="button"
              className="composer-plus-item"
              onClick={() => { pendingCharRef.current = char; setOpen(false) }}
            >
              <Icon /><span>{label}</span><span className="composer-plus-hint">{char}</span>
            </button>
          ))}
          <div className="composer-plus-group-label">会话与设置</div>
          {onSideChat && <button type="button" className="composer-plus-item" onClick={() => closeThen(onSideChat)}><MessagesSquare /><span>打开侧边聊天</span></button>}
          <button type="button" className="composer-plus-item" onClick={() => closeThen(tools.onOpenSessionStatus)}><Activity /><span>会话状态</span></button>
          <button
            type="button"
            className="composer-plus-item"
            aria-expanded={presetExpanded}
            disabled={tools.presetDisabled}
            onClick={() => setPresetExpanded((expanded) => !expanded)}
          >
            <SlidersHorizontal /><span>模型呈现</span>
            <span className="composer-plus-hint flex items-center gap-1">{tools.minimalPresetEnabled ? '极简' : '标准'}<ChevronDown className={`size-3 transition-transform ${presetExpanded ? 'rotate-180' : ''}`} /></span>
          </button>
          {presetExpanded && (
            <div className="composer-plus-presets">
              <button type="button" className="composer-plus-item" title="完整提示词与全量工具" onClick={() => closeThen(() => tools.onSetPreset('standard'))}>
                <span>标准</span>{!tools.minimalPresetEnabled && <Check />}
              </button>
              <button type="button" className="composer-plus-item" title="固定提示词与精简工具，权限与门禁不变" onClick={() => closeThen(() => tools.onSetPreset('minimal'))}>
                <span>极简</span>{tools.minimalPresetEnabled && <Check />}
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    )
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
        {onSideChat && (
          <DropdownMenuItem className="gap-2.5 py-1.5" onSelect={() => { pendingActionRef.current = onSideChat }}>
            <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium leading-4">打开侧边聊天</span>
          </DropdownMenuItem>
        )}
        {MENU_ITEMS.map(({ char, label, icon: Icon }) => (
          <DropdownMenuItem key={char} onSelect={() => { pendingCharRef.current = char }} className="gap-2.5 py-1.5">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col"><span className="text-xs font-medium leading-4">{label}</span></span>
            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground">{char}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
