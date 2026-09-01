/**
 * WorkWelcomeEmptyState — Work 新会话启动面板
 *
 * 面板独占 Header 与 Composer 之间的可用区域，因此欢迎内容始终按真实剩余空间居中。
 * 任务入口只负责预填 Composer，不会自动发送。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertTriangle, ClipboardList, Sparkles, Telescope, type LucideIcon } from 'lucide-react'
import { userProfileAtom } from '@/atoms/user-profile'
import { WelcomeWatermark } from './WelcomeWatermark'

export interface WorkWelcomeAction {
  id: string
  title: string
  description: string
  prompt: string
  icon: LucideIcon
  iconClassName: string
  iconSurfaceClassName: string
}

export const WORK_WELCOME_ACTIONS: WorkWelcomeAction[] = [
  {
    id: 'orient',
    title: '梳理项目脉络',
    description: '找到入口、依赖关系与关键路径',
    prompt: '帮我梳理这个项目的入口、核心模块和关键依赖',
    icon: Telescope,
    iconClassName: 'text-sky-500',
    iconSurfaceClassName: 'bg-sky-500/10',
  },
  {
    id: 'deliver',
    title: '把想法落成改动',
    description: '从需求拆解到实现与验证',
    prompt: '帮我把这个想法拆解并实现成可验证的改动',
    icon: Sparkles,
    iconClassName: 'text-violet-500',
    iconSurfaceClassName: 'bg-violet-500/10',
  },
  {
    id: 'diagnose',
    title: '找出异常根因',
    description: '复现问题并修正最早出错的环节',
    prompt: '帮我复现这个问题，定位根因并完成修复',
    icon: AlertTriangle,
    iconClassName: 'text-orange-500',
    iconSurfaceClassName: 'bg-orange-500/10',
  },
  {
    id: 'organize',
    title: '收拢当前工作',
    description: '审查改动、整理计划或形成待办',
    prompt: '帮我审查并整理当前工作，给出清晰的下一步',
    icon: ClipboardList,
    iconClassName: 'text-emerald-500',
    iconSurfaceClassName: 'bg-emerald-500/10',
  },
]

function getGreeting(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export interface WorkWelcomeEmptyStateProps {
  onPickPrompt: (prompt: string) => void
}

export function WorkWelcomeEmptyState({ onPickPrompt }: WorkWelcomeEmptyStateProps): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const displayName = userProfile.userName || '用户'
  const greeting = getGreeting(new Date().getHours())

  return (
    <div
      data-work-welcome-empty-state="true"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8"
    >
      <WelcomeWatermark placement="centered" />
      <div className="relative z-10 flex w-full max-w-[44rem] flex-col items-center gap-7">
        <h1 className="text-center text-[30px] font-semibold tracking-tight text-foreground">
          {displayName}，{greeting}
        </h1>
        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          {WORK_WELCOME_ACTIONS.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => onPickPrompt(action.prompt)}
                className="group flex items-start gap-3.5 rounded-2xl bg-card/75 p-4 text-left shadow-sm ring-1 ring-border/50 backdrop-blur-sm transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:bg-accent/65 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${action.iconSurfaceClassName}`}>
                  <Icon className={`size-4 ${action.iconClassName}`} aria-hidden="true" />
                </span>
                <span className="min-w-0 pt-0.5">
                  <span className="block text-sm font-medium text-foreground/90 group-hover:text-foreground">
                    {action.title}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {action.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
