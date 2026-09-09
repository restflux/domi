import { parseQuotedSelectionRefs, type ParsedQuotedSelectionRef } from './quoted-selection'

/** 解析的附件引用 */
export interface AttachedFileRef {
  filename: string
  path: string
}

/** 解析的引用文件 */
export type QuotedFileRef = ParsedQuotedSelectionRef

/** 解析消息中的 <attached_files>、<quoted_file> 和 <quoted_context> 块，返回文件列表、引用列表和剩余文本 */
export function parseAttachedFiles(content: string): { files: AttachedFileRef[]; quotes: QuotedFileRef[]; text: string } {
  const parsedQuotes = parseQuotedSelectionRefs(content)
  const quotes: QuotedFileRef[] = parsedQuotes.quotes

  const regex = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>\n*/
  const match = content.match(regex)
  if (!match) {
    return { files: [], quotes, text: parsedQuotes.text }
  }

  const files: AttachedFileRef[] = []
  const lines = match[1]!.split('\n')
  for (const line of lines) {
    const lineMatch = line.match(/^-\s+(.+?):\s+(.+)$/)
    if (lineMatch) {
      files.push({ filename: lineMatch[1]!.trim(), path: lineMatch[2]!.trim() })
    }
  }

  const text = parsedQuotes.text.replace(regex, '').trim()
  return { files, quotes, text }
}

/** 判断文件是否为图片类型 */
export function isImageFile(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(filename)
}
