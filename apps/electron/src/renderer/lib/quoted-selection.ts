import type { QuotedSelection } from '@/atoms/preview-atoms'
import type { QuotedSelectionSourceType } from '@/atoms/preview-atoms'

export interface ParsedQuotedSelectionRef {
  path: string
  filename: string
  sourceType: QuotedSelectionSourceType
  label?: string
}

export const SELECTION_ACTION_POPOVER_SELECTOR = '[data-selection-action-popover]'

const QUOTED_FILE_REGEX = /<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g
const QUOTED_CONTEXT_REGEX = /<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g
const BROWSER_ELEMENT_REGEX = /<browser_element[^>]*>[\s\S]*?<\/browser_element>\n*/g

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function sanitizeQuotedText(value: string): string {
  return value
    .replace(/<\/quoted_file>/gi, '</quoted_file_>')
    .replace(/<\/quoted_context>/gi, '</quoted_context_>')
    .replace(/<\/browser_element>/gi, '</browser_element_>')
}

export function buildQuotedSelectionBlock(quotedSelection: QuotedSelection): string {
  const safeText = sanitizeQuotedText(quotedSelection.text)

  if (quotedSelection.sourceType === 'browser-element' && quotedSelection.browserElement) {
    const element = quotedSelection.browserElement
    const safeLabel = escapeXmlAttribute(quotedSelection.sourceLabel ?? element.pageTitle ?? element.pageUrl)
    const safeUrl = escapeXmlAttribute(element.pageUrl)
    const safePageId = escapeXmlAttribute(element.pageId)
    const safeTitle = escapeXmlAttribute(element.pageTitle)
    const safeTag = escapeXmlAttribute(element.tagName)
    const safeRole = escapeXmlAttribute(element.role ?? '')
    const safeName = escapeXmlAttribute(element.name ?? '')
    const safeHref = escapeXmlAttribute(element.href ?? '')
    return `<browser_element source="browser-element" label="${safeLabel}" content_trust="untrusted-web-content" page_url="${safeUrl}" page_title="${safeTitle}" page_id="${safePageId}" navigation_epoch="${element.navigationEpoch}" tag="${safeTag}" role="${safeRole}" name="${safeName}" href="${safeHref}" truncated="${element.truncated}">\n${escapeXmlText(safeText)}\n</browser_element>\n\n`
  }

  if (quotedSelection.sourceType && quotedSelection.sourceType !== 'file') {
    const safeSource = escapeXmlAttribute(quotedSelection.sourceType)
    const safeLabel = escapeXmlAttribute(quotedSelection.sourceLabel ?? quotedSelection.filePath)
    const safeMessageId = escapeXmlAttribute(quotedSelection.messageId ?? '')
    const safeRole = escapeXmlAttribute(quotedSelection.messageRole ?? '')
    return `<quoted_context source="${safeSource}" label="${safeLabel}" message_id="${safeMessageId}" role="${safeRole}">\n${safeText}\n</quoted_context>\n\n`
  }

  const safePath = escapeXmlAttribute(quotedSelection.filePath)
  return `<quoted_file path="${safePath}">\n${safeText}\n</quoted_file>\n\n`
}

function normalizeContextSourceType(value: string | undefined): QuotedSelectionSourceType {
  if (value === 'scratch-pad') return 'scratch-pad'
  if (value === 'browser-element') return 'browser-element'
  return 'agent-history'
}

export function parseQuotedSelectionRefs(content: string): { quotes: ParsedQuotedSelectionRef[]; text: string } {
  const quotes: ParsedQuotedSelectionRef[] = []

  let quoteMatch: RegExpExecArray | null
  QUOTED_FILE_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_FILE_REGEX.exec(content)) !== null) {
    const pathMatch = quoteMatch[0].match(/path="([^"]*)"/)
    if (!pathMatch) continue
    const filePath = decodeXmlAttribute(pathMatch[1]!)
    quotes.push({
      path: filePath,
      filename: filePath.split('/').pop() ?? filePath,
      sourceType: 'file',
    })
  }

  BROWSER_ELEMENT_REGEX.lastIndex = 0
  while ((quoteMatch = BROWSER_ELEMENT_REGEX.exec(content)) !== null) {
    const labelMatch = quoteMatch[0].match(/label="([^"]*)"/)
    const urlMatch = quoteMatch[0].match(/page_url="([^"]*)"/)
    const label = labelMatch ? decodeXmlAttribute(labelMatch[1]!) : '网页元素'
    const pageUrl = urlMatch ? decodeXmlAttribute(urlMatch[1]!) : label
    quotes.push({
      path: pageUrl,
      filename: label,
      sourceType: 'browser-element',
      label,
    })
  }

  QUOTED_CONTEXT_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_CONTEXT_REGEX.exec(content)) !== null) {
    const labelMatch = quoteMatch[0].match(/label="([^"]*)"/)
    const sourceMatch = quoteMatch[0].match(/source="([^"]*)"/)
    const label = labelMatch ? decodeXmlAttribute(labelMatch[1]!) : 'Agent 历史'
    const sourceType = normalizeContextSourceType(sourceMatch ? decodeXmlAttribute(sourceMatch[1]!) : 'agent-history')
    quotes.push({
      path: label,
      filename: label,
      sourceType,
      label,
    })
  }

  const text = content
    .replace(QUOTED_FILE_REGEX, '')
    .replace(QUOTED_CONTEXT_REGEX, '')
    .replace(BROWSER_ELEMENT_REGEX, '')
    .trim()

  return { quotes, text }
}
