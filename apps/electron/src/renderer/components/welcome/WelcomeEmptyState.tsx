/**
 * WelcomeEmptyState — 对话/会话空状态引导
 *
 * 在没有会话时展示个性化时段问候。
 *
 * compact 形态用于新会话 Hero 布局：以自然高度渲染在输入框正上方，
 * 由外层 flex spacer 负责整体垂直居中；默认形态保持整屏居中。
 * Work/Chat 模式切换由左侧边栏承载，这里不再重复。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import '@/i18n'
import { cn } from '@/lib/utils'
import { userProfileAtom } from '@/atoms/user-profile'

/** 根据小时返回时段问候 key */
type GreetingKey = 'lateNight' | 'morning' | 'afternoon' | 'evening'

function getGreetingKey(hour: number): GreetingKey {
  if (hour < 6) return 'lateNight'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

export interface WelcomeEmptyStateProps {
  /** Hero 布局紧凑形态：自然高度、更紧凑的间距 */
  compact?: boolean
}

export function WelcomeEmptyState({ compact = false }: WelcomeEmptyStateProps): React.ReactElement {
  const { t } = useTranslation('welcome')
  const userProfile = useAtomValue(userProfileAtom)

  const hour = new Date().getHours()
  const greeting = t(getGreetingKey(hour))
  const displayName = userProfile.userName || t('user')

  return (
    <div
      data-welcome-empty-state={compact ? 'compact' : 'centered'}
      className={cn(
        'welcome-empty-state flex flex-col items-center px-4',
        compact ? 'pb-1' : 'flex h-full justify-center gap-6',
      )}
    >
      {/* 问候语 */}
      <h1
        className={cn(
          'font-semibold tracking-tight text-foreground',
          compact ? 'text-[32px]' : 'text-[26px]',
        )}
      >
        {t('greeting', { displayName, greeting })}
      </h1>
    </div>
  )
}
