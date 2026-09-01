/**
 * PromptSettings - Chat 与 Work 系统提示词管理设置页
 *
 * Chat 提示词作为对话 system message；多条启用的 Work 提示词按列表顺序追加到
 * Domi/Pi 的宿主规则之后，同时保持 Execution Policy、Workflow 和工具授权稳定。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Plus, Trash2, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
} from './primitives'
import {
  promptConfigAtom,
  selectedPromptIdAtom,
  selectedWorkPromptIdAtom,
} from '@/atoms/system-prompt-atoms'
import {
  BUILTIN_DEFAULT_ID,
  BUILTIN_WORK_PRODUCT_DELIVERY_ID,
} from '@domi/shared'
import type {
  SystemPrompt,
  SystemPromptCreateInput,
  SystemPromptScope,
  SystemPromptUpdateInput,
} from '@domi/shared'

const DEBOUNCE_DELAY = 500

export function PromptSettings(): React.ReactElement {
  const [config, setConfig] = useAtom(promptConfigAtom)
  const [selectedChatId, setSelectedChatId] = useAtom(selectedPromptIdAtom)
  const [selectedWorkId, setSelectedWorkId] = useAtom(selectedWorkPromptIdAtom)
  const [scope, setScope] = React.useState<SystemPromptScope>('chat')
  const [editName, setEditName] = React.useState('')
  const [editContent, setEditContent] = React.useState('')
  const [hoveredId, setHoveredId] = React.useState<string | null>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const scopedPrompts = React.useMemo(
    () => config.prompts.filter((prompt) => prompt.scope === scope),
    [config.prompts, scope],
  )
  const selectedId = scope === 'work' ? selectedWorkId : selectedChatId
  const setSelectedId = scope === 'work' ? setSelectedWorkId : setSelectedChatId
  const selectedPrompt = React.useMemo(
    () => scopedPrompts.find((prompt) => prompt.id === selectedId) ?? scopedPrompts[0],
    [scopedPrompts, selectedId],
  )

  React.useEffect(() => {
    window.electronAPI.getSystemPromptConfig().then((nextConfig) => {
      setConfig(nextConfig)
    }).catch(console.error)
  }, [setConfig])

  React.useEffect(() => {
    if (!selectedPrompt) return
    if (selectedPrompt.id !== selectedId) setSelectedId(selectedPrompt.id)
    setEditName(selectedPrompt.name)
    setEditContent(selectedPrompt.content)
  }, [selectedId, selectedPrompt, setSelectedId])

  const handleCreate = async (): Promise<void> => {
    const input: SystemPromptCreateInput = {
      name: scope === 'work' ? '自定义 Work 提示词' : '新 Chat 提示词',
      content: scope === 'work' ? selectedPrompt?.content ?? '' : '',
      scope,
    }
    try {
      const created = await window.electronAPI.createSystemPrompt(input)
      setConfig((previous) => ({
        ...previous,
        prompts: [...previous.prompts, created],
      }))
      setSelectedId(created.id)
    } catch (error) {
      console.error('[提示词设置] 创建失败:', error)
    }
  }

  const handleDelete = async (prompt: SystemPrompt): Promise<void> => {
    try {
      await window.electronAPI.deleteSystemPrompt(prompt.id)
      const fallbackId = prompt.scope === 'work'
        ? BUILTIN_WORK_PRODUCT_DELIVERY_ID
        : BUILTIN_DEFAULT_ID
      setConfig((previous) => ({
        ...previous,
        prompts: previous.prompts.filter((candidate) => candidate.id !== prompt.id),
        enabledWorkPromptIds: previous.enabledWorkPromptIds.filter((id) => id !== prompt.id),
        ...(prompt.scope === 'chat' && previous.defaultPromptId === prompt.id
          ? { defaultPromptId: fallbackId }
          : {}),
      }))
      if (selectedId === prompt.id) setSelectedId(fallbackId)
    } catch (error) {
      console.error('[提示词设置] 删除失败:', error)
    }
  }

  const handleSetChatDefault = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.setDefaultPrompt(id, 'chat')
      setConfig((previous) => ({ ...previous, defaultPromptId: id }))
    } catch (error) {
      console.error('[提示词设置] 设置 Chat 默认提示词失败:', error)
    }
  }

  const handleWorkActivation = async (id: string, enabled: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateWorkPromptActivation(id, enabled)
      setConfig((previous) => {
        const enabledIdSet = new Set(previous.enabledWorkPromptIds)
        if (enabled) enabledIdSet.add(id)
        else enabledIdSet.delete(id)
        return {
          ...previous,
          enabledWorkPromptIds: previous.prompts
            .filter((prompt) => prompt.scope === 'work' && enabledIdSet.has(prompt.id))
            .map((prompt) => prompt.id),
        }
      })
    } catch (error) {
      console.error('[提示词设置] 更新 Work 提示词状态失败:', error)
    }
  }

  const debounceSave = React.useCallback(
    (id: string, input: SystemPromptUpdateInput): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(async () => {
        try {
          const updated = await window.electronAPI.updateSystemPrompt(id, input)
          setConfig((previous) => ({
            ...previous,
            prompts: previous.prompts.map((prompt) => prompt.id === updated.id ? updated : prompt),
          }))
        } catch (error) {
          console.error('[提示词设置] 保存失败:', error)
        }
      }, DEBOUNCE_DELAY)
    },
    [setConfig],
  )

  const handleNameChange = (value: string): void => {
    setEditName(value)
    if (selectedPrompt && !selectedPrompt.isBuiltin) {
      debounceSave(selectedPrompt.id, { name: value })
    }
  }

  const handleContentChange = (value: string): void => {
    setEditContent(value)
    if (selectedPrompt && !selectedPrompt.isBuiltin) {
      debounceSave(selectedPrompt.id, { content: value })
    }
  }

  const handleAppendChange = async (enabled: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateAppendSetting(enabled)
      setConfig((previous) => ({ ...previous, appendDateTimeAndUserName: enabled }))
    } catch (error) {
      console.error('[提示词设置] 更新 Chat 附加信息失败:', error)
    }
  }

  return (
    <div className="space-y-6">
      <div
        className="inline-flex items-center gap-1 rounded-lg bg-muted/70 p-1"
        role="tablist"
        aria-label="提示词分类"
      >
        {([
          { value: 'chat', label: 'Chat 提示词' },
          { value: 'work', label: 'Work 提示词' },
        ] as const).map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={scope === option.value}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              scope === option.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setScope(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <SettingsSection
        title={scope === 'work' ? 'Work 系统提示词' : 'Chat 系统提示词'}
        description={scope === 'work'
          ? '勾选需要使用的规则；多条规则会按列表顺序共同追加到 Pi Agent 的系统提示词。'
          : '管理 Chat 模式的系统提示词；星标项是新对话默认选中的提示词。'}
        action={(
          <Button size="sm" onClick={handleCreate}>
            <Plus className="size-4 mr-1" />
            新建
          </Button>
        )}
      >
        <SettingsCard divided={false} className="p-0">
          <div className="divide-y divide-border/50">
            {scopedPrompts.map((prompt) => (
              <PromptListItem
                key={prompt.id}
                prompt={prompt}
                scope={scope}
                isSelected={prompt.id === selectedPrompt?.id}
                isDefault={scope === 'chat' && prompt.id === config.defaultPromptId}
                isEnabled={scope === 'work' && config.enabledWorkPromptIds.includes(prompt.id)}
                isHovered={prompt.id === hoveredId}
                onSelect={setSelectedId}
                onDelete={handleDelete}
                onSetChatDefault={handleSetChatDefault}
                onWorkActivationChange={handleWorkActivation}
                onHoverChange={setHoveredId}
              />
            ))}
          </div>
        </SettingsCard>
      </SettingsSection>

      {selectedPrompt && (
        <SettingsSection title="提示词内容">
          <SettingsCard divided={false} className="p-4 space-y-3">
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">名称</label>
              <Input
                value={editName}
                onChange={(event) => handleNameChange(event.target.value)}
                readOnly={selectedPrompt.isBuiltin}
                className={cn(selectedPrompt.isBuiltin && 'opacity-60 cursor-not-allowed')}
                maxLength={50}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">内容</label>
              <Textarea
                value={editContent}
                onChange={(event) => handleContentChange(event.target.value)}
                readOnly={selectedPrompt.isBuiltin}
                className={cn(
                  'min-h-[280px] resize-y',
                  selectedPrompt.isBuiltin && 'opacity-60 cursor-not-allowed',
                )}
                placeholder="输入系统提示词内容..."
              />
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {scope === 'chat' && (
        <SettingsSection title="Chat 附加信息">
          <SettingsCard>
            <SettingsToggle
              label="追加日期时间和用户名"
              description="在 Chat 提示词末尾自动追加当前日期时间和用户名"
              checked={config.appendDateTimeAndUserName}
              onCheckedChange={handleAppendChange}
            />
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  )
}

interface PromptListItemProps {
  prompt: SystemPrompt
  scope: SystemPromptScope
  isSelected: boolean
  isDefault: boolean
  isEnabled: boolean
  isHovered: boolean
  onSelect: (id: string) => void
  onDelete: (prompt: SystemPrompt) => void
  onSetChatDefault: (id: string) => void
  onWorkActivationChange: (id: string, enabled: boolean) => void
  onHoverChange: (id: string | null) => void
}

function PromptListItem({
  prompt,
  scope,
  isSelected,
  isDefault,
  isEnabled,
  isHovered,
  onSelect,
  onDelete,
  onSetChatDefault,
  onWorkActivationChange,
  onHoverChange,
}: PromptListItemProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors',
        isSelected ? 'bg-accent/50' : 'hover:bg-muted/50',
      )}
      onClick={() => onSelect(prompt.id)}
      onMouseEnter={() => onHoverChange(prompt.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      {scope === 'work' && (
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(event) => onWorkActivationChange(prompt.id, event.target.checked)}
          onClick={(event) => event.stopPropagation()}
          className="size-4 shrink-0 cursor-pointer accent-primary"
          aria-label={`${isEnabled ? '停用' : '启用'} ${prompt.name}`}
        />
      )}

      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="text-sm font-medium truncate">{prompt.name}</span>
        {prompt.isBuiltin && <span className="text-xs text-muted-foreground shrink-0">(内置)</span>}
        {isDefault && <Star className="size-3.5 text-amber-500 fill-amber-500 shrink-0" />}
      </div>

      <div className={cn(
        'flex items-center gap-1 shrink-0 transition-opacity',
        isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}>
        {scope === 'chat' && !isDefault && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(event) => {
              event.stopPropagation()
              onSetChatDefault(prompt.id)
            }}
            title="设为新对话默认提示词"
          >
            <Star className="size-3.5 text-muted-foreground" />
          </Button>
        )}
        {!prompt.isBuiltin && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation()
              onDelete(prompt)
            }}
            title="删除"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
