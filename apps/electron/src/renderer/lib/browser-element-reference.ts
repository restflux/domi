import type { BrowserSelectedElementReference } from '@domi/shared'
import type { QuotedSelection } from '@/atoms/preview-atoms'

export function createBrowserQuotedSelection(element: BrowserSelectedElementReference, capturedAt = Date.now()): QuotedSelection {
  const semanticLabel = element.name || element.text || element.role || element.tagName
  const sourceLabel = [element.pageTitle || '网页', element.role || element.tagName, semanticLabel]
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
    .join(' · ')
  return {
    text: element.text || element.name || `${element.role || element.tagName} 元素`,
    filePath: element.pageUrl,
    sourceType: 'browser-element',
    sourceLabel,
    browserElement: element,
    capturedAt,
  }
}
