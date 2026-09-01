/**
 * DOMI_IMAGE_ATTACHMENT 标记解析
 *
 * 生图 MCP 工具（gpt-image / nano-banana）会在工具结果文本中嵌入
 * `[DOMI_IMAGE_ATTACHMENT:{"localPath":...,"filename":...,"mediaType":...}]`
 * 标记供前端渲染内联缩略图。本模块负责把标记从文本中剥离并转为结构化数据。
 *
 * 纯函数、零依赖，便于单测；解析失败的标记原样保留（不 crash、不吞内容）。
 */

export interface ImageAttachmentMarker {
  localPath: string
  filename: string
  mediaType: string
}

export interface ExtractedImageMarkers {
  /** 剥离标记后的文本 */
  cleanText: string
  /** 按出现顺序提取的附件标记 */
  markers: ImageAttachmentMarker[]
}

const MARKER_PREFIX = '[DOMI_IMAGE_ATTACHMENT:'

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() || 'image'
}

/** 从 JSON 对象起点查找字符串感知的配对 `}`；支持字符串内的 `]` / `}` 与转义引号 */
function findJsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * 从文本中提取图片附件标记
 *
 * - 合法且字段完整的标记 → 剥离并收集到 markers
 * - JSON 损坏或字段缺失的标记 → 原样保留在文本中
 */
export function extractImageAttachmentMarkers(text: string): ExtractedImageMarkers {
  if (!text.includes(MARKER_PREFIX)) return { cleanText: text, markers: [] }

  const markers: ImageAttachmentMarker[] = []
  const output: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    const markerStart = text.indexOf(MARKER_PREFIX, cursor)
    if (markerStart === -1) {
      output.push(text.slice(cursor))
      break
    }

    output.push(text.slice(cursor, markerStart))
    const jsonStart = markerStart + MARKER_PREFIX.length
    const jsonEnd = findJsonObjectEnd(text, jsonStart)
    if (jsonEnd === -1 || text[jsonEnd + 1] !== ']') {
      // 无法确定完整边界，保留剩余文本并终止，避免误吞普通内容。
      output.push(text.slice(markerStart))
      break
    }

    const markerEnd = jsonEnd + 2
    const raw = text.slice(markerStart, markerEnd)
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
        localPath?: unknown
        filename?: unknown
        mediaType?: unknown
      }
      if (typeof parsed.localPath === 'string' && parsed.localPath && typeof parsed.mediaType === 'string') {
        markers.push({
          localPath: parsed.localPath,
          filename: typeof parsed.filename === 'string' && parsed.filename ? parsed.filename : basenameOf(parsed.localPath),
          mediaType: parsed.mediaType,
        })
      } else {
        output.push(raw)
      }
    } catch {
      output.push(raw)
    }
    cursor = markerEnd
  }

  return { cleanText: output.join('').replace(/\n{3,}/g, '\n\n').trim(), markers }
}
