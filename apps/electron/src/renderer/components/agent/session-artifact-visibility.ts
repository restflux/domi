import type { GeneratedImageItem, SessionProjectArtifact } from '@domi/shared'

const DELIVERABLE_EXTENSIONS = new Set([
  'md', 'mdx', 'markdown',
  'html', 'htm',
  'pdf', 'txt', 'rtf',
  'doc', 'docx', 'odt',
  'ppt', 'pptx', 'odp',
  'xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif',
])

export const SESSION_ARTIFACTS_DEFAULT_EXPANDED = false

export function toggleSessionArtifactsExpanded(expanded: boolean): boolean {
  return !expanded
}

export function isVisibleSessionDeliverable(relativePath: string): boolean {
  const filename = relativePath.split('/').pop()?.toLowerCase() ?? ''
  const extensionIndex = filename.lastIndexOf('.')
  if (extensionIndex <= 0 || extensionIndex === filename.length - 1) return false
  return DELIVERABLE_EXTENSIONS.has(filename.slice(extensionIndex + 1))
}

/** 只保留用户可直接查看的交付文件，并避免 generated-images 与画廊重复展示。 */
export function filterVisibleSessionProjectArtifacts(
  artifacts: readonly SessionProjectArtifact[],
  generatedImages: readonly GeneratedImageItem[],
): SessionProjectArtifact[] {
  const generatedProjectNames = new Set(
    generatedImages
      .filter((image) => image.source === 'agent-workspace')
      .map((image) => image.filename.toLowerCase()),
  )
  return artifacts.filter((artifact) => (
    isVisibleSessionDeliverable(artifact.relativePath)
    && (!artifact.relativePath.startsWith('generated-images/')
      || !generatedProjectNames.has(artifact.name.toLowerCase()))
  ))
}
