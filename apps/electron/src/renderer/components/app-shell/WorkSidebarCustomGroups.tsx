import * as React from 'react'
import { Check, ChevronDown, ChevronRight, Hash, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type {
  WorkSidebarCustomGroup,
  WorkSidebarCustomGroupColor,
  WorkSidebarPreferences,
} from '../../../types'
import {
  assignSessionToCustomGroup,
  groupWorkSidebarSessions,
  toggleSessionInCustomGroup,
  type WorkSidebarSessionItem,
} from '@/lib/work-sidebar-groups'

const SESSION_DRAG_TYPE = 'application/x-domi-work-session'

interface GroupColorOption {
  value: WorkSidebarCustomGroupColor
  label: string
  dotClassName: string
  accentClassName: string
}

const GROUP_COLORS: readonly GroupColorOption[] = [
  { value: 'gray', label: '灰色', dotClassName: 'bg-zinc-500', accentClassName: 'bg-zinc-500' },
  { value: 'red', label: '红色', dotClassName: 'bg-rose-500', accentClassName: 'bg-rose-500' },
  { value: 'orange', label: '橙色', dotClassName: 'bg-amber-600', accentClassName: 'bg-amber-600' },
  { value: 'yellow', label: '黄色', dotClassName: 'bg-yellow-500', accentClassName: 'bg-yellow-500' },
  { value: 'green', label: '绿色', dotClassName: 'bg-emerald-500', accentClassName: 'bg-emerald-500' },
  { value: 'blue', label: '蓝色', dotClassName: 'bg-cyan-600', accentClassName: 'bg-cyan-600' },
  { value: 'purple', label: '紫色', dotClassName: 'bg-violet-500', accentClassName: 'bg-violet-500' },
]

function getGroupColor(color: WorkSidebarCustomGroupColor): GroupColorOption {
  return GROUP_COLORS.find((option) => option.value === color) ?? GROUP_COLORS[0]!
}

export interface WorkSidebarGroupTreeItem extends WorkSidebarSessionItem {
  session: WorkSidebarSessionItem['session'] & { title: string }
}

interface WorkSidebarCustomGroupsProps<T extends WorkSidebarGroupTreeItem> {
  preferences: WorkSidebarPreferences
  items: readonly T[]
  onChange: (updates: Partial<WorkSidebarPreferences>) => void
  renderItem: (item: T) => React.ReactNode
}

export function WorkSidebarCustomGroups<T extends WorkSidebarGroupTreeItem>({
  preferences,
  items,
  onChange,
  renderItem,
}: WorkSidebarCustomGroupsProps<T>): React.ReactElement {
  const [editingGroupId, setEditingGroupId] = React.useState<string | null>(null)
  const [editingName, setEditingName] = React.useState('')
  const [dragOverGroupId, setDragOverGroupId] = React.useState<string | null>(null)
  const grouped = React.useMemo(
    () => groupWorkSidebarSessions(items, preferences.customGroups),
    [items, preferences.customGroups],
  )

  const updateGroups = React.useCallback((customGroups: WorkSidebarCustomGroup[]): void => {
    onChange({ customGroups })
  }, [onChange])

  const updateGroup = React.useCallback((
    groupId: string,
    updates: Partial<Omit<WorkSidebarCustomGroup, 'id'>>,
  ): void => {
    updateGroups(preferences.customGroups.map((group) => (
      group.id === groupId ? { ...group, ...updates } : group
    )))
  }, [preferences.customGroups, updateGroups])

  const saveGroupName = React.useCallback((group: WorkSidebarCustomGroup): void => {
    const name = editingName.trim().slice(0, 80)
    if (name && name !== group.name) updateGroup(group.id, { name })
    setEditingGroupId(null)
  }, [editingName, updateGroup])

  const deleteGroup = React.useCallback((groupId: string): void => {
    updateGroups(preferences.customGroups.filter((group) => group.id !== groupId))
  }, [preferences.customGroups, updateGroups])

  const handleDrop = React.useCallback((event: React.DragEvent, groupId: string): void => {
    event.preventDefault()
    const sessionId = event.dataTransfer.getData(SESSION_DRAG_TYPE)
      || event.dataTransfer.getData('text/plain')
    setDragOverGroupId(null)
    if (!sessionId) return
    updateGroups(assignSessionToCustomGroup(preferences.customGroups, sessionId, groupId))
  }, [preferences.customGroups, updateGroups])

  const renderDraggableItem = React.useCallback((item: T): React.ReactElement => (
    <div
      key={item.session.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(SESSION_DRAG_TYPE, item.session.id)
        event.dataTransfer.setData('text/plain', item.session.id)
      }}
      onDragEnd={() => setDragOverGroupId(null)}
    >
      {renderItem(item)}
    </div>
  ), [renderItem])

  return (
    <div className="px-2 pb-2">
      {grouped.groups.map(({ group, items: groupItems }) => {
        const color = getGroupColor(group.color)
        const isDropTarget = dragOverGroupId === group.id
        return (
          <section
            key={group.id}
            className={cn('mb-2 rounded-lg transition-colors', isDropTarget && 'bg-foreground/[0.045]')}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDragOverGroupId(group.id)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverGroupId(null)
            }}
            onDrop={(event) => handleDrop(event, group.id)}
          >
            <div className="flex h-8 items-center gap-1 px-1">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      title="设置分组颜色"
                      className="flex items-center gap-0.5 rounded-md p-0.5 text-foreground/25 hover:bg-foreground/[0.04] hover:text-foreground/50"
                    >
                      <span className={cn('flex size-5 flex-shrink-0 items-center justify-center rounded-full text-white', color.dotClassName)}>
                        <Hash size={11} />
                      </span>
                      <ChevronDown size={10} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" sideOffset={4} className="w-40 p-1.5">
                  <div className="px-2 pb-1.5 text-[11px] font-medium text-foreground/35">分组颜色</div>
                  {GROUP_COLORS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => updateGroup(group.id, { color: option.value })}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-foreground/70 hover:bg-foreground/[0.055]"
                    >
                      <span className={cn('size-2.5 rounded-full', option.dotClassName)} />
                      <span className="flex-1 text-left">{option.label}</span>
                      <Check size={12} className={group.color === option.value ? 'text-foreground/55' : 'opacity-0'} />
                    </button>
                  ))}
                  <div className="my-1 h-px bg-border/50" />
                    <button
                      type="button"
                      onClick={() => {
                        setEditingGroupId(group.id)
                        setEditingName(group.name)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-foreground/70 hover:bg-foreground/[0.055]"
                    >
                      <Pencil size={12} />重命名
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteGroup(group.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 size={12} />删除分组
                    </button>
                  </PopoverContent>
                </Popover>
                {editingGroupId === group.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveGroupName(group)
                      if (event.key === 'Escape') setEditingGroupId(null)
                    }}
                    onBlur={() => saveGroupName(group)}
                    className="min-w-0 flex-1 border-b border-primary/50 bg-transparent text-[13px] outline-none"
                    maxLength={80}
                  />
                ) : (
                  <button
                    type="button"
                    title="双击重命名分组"
                    onDoubleClick={() => {
                      setEditingGroupId(group.id)
                      setEditingName(group.name)
                    }}
                    className="min-w-0 flex-1 truncate rounded-md px-1 py-1 text-left text-[13px] font-medium text-foreground/75 hover:bg-foreground/[0.04]"
                  >
                    {group.name}
                  </button>
                )}
              </div>

              <span className="min-w-5 rounded-full bg-foreground/[0.045] px-1.5 text-center text-[11px] tabular-nums text-foreground/35">
                {groupItems.length}
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title="管理分组会话"
                    className="flex size-6 items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.06] hover:text-foreground/65"
                  >
                    <Plus size={13} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={4} className="w-56 p-1.5">
                  <div className="px-2 pb-1.5 text-[11px] font-medium text-foreground/35">添加或移出会话</div>
                  <div className="max-h-64 overflow-y-auto">
                    {items.length === 0 ? (
                      <div className="px-2 py-3 text-center text-[11px] text-foreground/35">暂无可分组会话</div>
                    ) : items.map((item) => {
                      const selected = group.sessionIds.includes(item.session.id)
                      return (
                        <button
                          key={item.session.id}
                          type="button"
                          onClick={() => updateGroups(toggleSessionInCustomGroup(
                            preferences.customGroups,
                            item.session.id,
                            group.id,
                          ))}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-foreground/70 hover:bg-foreground/[0.055]"
                        >
                          <span className="min-w-0 flex-1 truncate text-left">{item.session.title}</span>
                          <Check size={12} className={selected ? 'text-foreground/55' : 'opacity-0'} />
                        </button>
                      )
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              <button
                type="button"
                title={group.collapsed ? '展开分组' : '收起分组'}
                onClick={() => updateGroup(group.id, { collapsed: !group.collapsed })}
                className="flex size-6 items-center justify-center rounded-md text-foreground/30 hover:bg-foreground/[0.06] hover:text-foreground/60"
              >
                <ChevronRight size={12} className={cn('transition-transform', !group.collapsed && 'rotate-90')} />
              </button>
            </div>

            {!group.collapsed && (
              <div className="relative ml-3.5 pl-2">
                <span className={cn('absolute bottom-0 left-[-1px] top-0 w-px', color.accentClassName)} />
                {groupItems.length > 0 ? (
                  <div className="flex flex-col gap-0.5">{groupItems.map(renderDraggableItem)}</div>
                ) : (
                  <div className={cn(
                    'my-1 rounded-md border border-dashed px-3 py-2 text-[11px] text-foreground/30',
                    isDropTarget && 'border-foreground/25 bg-foreground/[0.035] text-foreground/50',
                  )}>
                    新建任务，或拖拽到这里。
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })}

      {grouped.ungrouped.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5">
          {grouped.ungrouped.map(renderDraggableItem)}
        </div>
      )}
    </div>
  )
}
