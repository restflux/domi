import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import '@/i18n'
import type { RewindUndoState } from '@domi/shared'

interface RewindUndoBannerProps {
  state: RewindUndoState | null
  inProgress: boolean
  onUndo: () => void
}

export function RewindUndoBanner({ state, inProgress, onUndo }: RewindUndoBannerProps): React.ReactElement | null {
  const { t } = useTranslation('work')
  if (!state?.exists) return null
  const fileCount = state.filesChanged.length
  const unavailable = !state.available
  return (
    <div
      className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-foreground/80"
      role="status"
      data-testid="rewind-undo-banner"
    >
      <RotateCcw className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {unavailable
          ? t('rewindUnavailable', { error: state.error ?? t('stateChanged') })
          : t('rewindSuccess', { files: fileCount > 0 ? t('affectedFiles', { count: fileCount }) : '' })}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-1 font-medium text-amber-700 transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-amber-300"
        disabled={inProgress || unavailable}
        onClick={onUndo}
      >
        {inProgress ? t('undoing') : t('undoRewind')}
      </button>
    </div>
  )
}
