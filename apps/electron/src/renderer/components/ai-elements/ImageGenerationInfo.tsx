import type { ImageGenerationResultMetadata } from '@domi/shared'

/** 仅展示已完成请求的实际参数，不读取当前输入框选择。 */
export function ImageGenerationInfo({ results }: { results: ImageGenerationResultMetadata[] }): React.ReactElement | null {
  if (!results.length) return null
  const labels = [...new Set(results.map((result) => [
    result.model,
    result.size && result.size !== 'auto' ? result.size : undefined,
    result.aspectRatio && result.aspectRatio !== 'auto' ? result.aspectRatio : undefined,
    result.imageSize && result.imageSize !== 'auto' ? result.imageSize : undefined,
    result.quality && result.quality !== 'auto' ? result.quality : undefined,
  ].filter(Boolean).join(' · ')))]
  return <div className="mt-1 space-y-1 text-xs text-muted-foreground">{labels.map((label) => <p key={label}>{label}</p>)}</div>
}
