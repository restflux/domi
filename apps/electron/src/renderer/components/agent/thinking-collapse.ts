interface ThinkingCollapseElement {
  readonly scrollHeight: number
}

interface ThinkingCollapseMeasurementInput {
  element: ThinkingCollapseElement | null
  isStreaming: boolean
  displayedContent: string
  finalContent: string
  lastMeasuredContent: string | null
  lineHeight: number
  lineThreshold?: number
  tolerance?: number
}

export interface ThinkingCollapseMeasurement {
  measuredContent: string
  shouldCollapse: boolean
}

/**
 * 只在平滑队列已追上权威 thinking 正文后读取一次布局。流式帧和结束后的排空帧
 * 都返回 undefined，避免每批 Markdown 更新同步触发 scrollHeight 强制布局。
 */
export function measureThinkingCollapse({
  element,
  isStreaming,
  displayedContent,
  finalContent,
  lastMeasuredContent,
  lineHeight,
  lineThreshold = 4,
  tolerance = 10,
}: ThinkingCollapseMeasurementInput): ThinkingCollapseMeasurement | undefined {
  if (
    isStreaming
    || !element
    || displayedContent !== finalContent
    || lastMeasuredContent === finalContent
  ) {
    return undefined
  }

  return {
    measuredContent: finalContent,
    shouldCollapse: element.scrollHeight > lineHeight * lineThreshold + tolerance,
  }
}
