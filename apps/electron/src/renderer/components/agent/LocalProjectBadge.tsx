import type * as React from 'react'
import type { LocalProjectRootStatus } from '@domi/shared'
import { HardDrive } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LocalProjectBadgeProps {
  projectRootPath?: string | null
  projectRootStatus?: LocalProjectRootStatus
  variant?: 'badge' | 'icon'
  className?: string
}

const UNAVAILABLE_STATUS_LABELS: Record<Exclude<LocalProjectRootStatus, 'available'>, string> = {
  missing: '本地项目根目录已被删除',
  not_directory: '本地项目根路径不再是文件夹',
  unavailable: '本地项目根目录无法访问',
}

export function LocalProjectBadge({
  projectRootPath,
  projectRootStatus,
  variant = 'badge',
  className,
}: LocalProjectBadgeProps): React.ReactElement | null {
  if (!projectRootPath) return null

  const isUnavailable = projectRootStatus !== undefined && projectRootStatus !== 'available'
  const label = isUnavailable ? '根目录不可用' : '本地项目'
  const title = isUnavailable ? UNAVAILABLE_STATUS_LABELS[projectRootStatus] : projectRootPath

  if (variant === 'icon') {
    return (
      <span
        role="img"
        aria-label={label}
        title={title}
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] transition-colors',
          isUnavailable
            ? 'bg-destructive/10 text-destructive'
            : 'text-muted-foreground/55 group-hover/project:text-muted-foreground/80',
          className,
        )}
      >
        <HardDrive size={11} aria-hidden="true" />
      </span>
    )
  }

  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-0 text-[10px] font-medium leading-4',
        isUnavailable ? 'bg-destructive/10 text-destructive' : 'bg-secondary text-muted-foreground',
        className,
      )}
    >
      {label}
    </span>
  )
}
