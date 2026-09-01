interface CalculateImageFitZoomInput {
  imageWidth: number
  imageHeight: number
  containerWidth: number
  containerHeight: number
  horizontalPadding: number
  verticalPadding: number
}

/** 计算图片完整适配预览区域时的缩放比例，小图保持原始大小。 */
export function calculateImageFitZoom({
  imageWidth,
  imageHeight,
  containerWidth,
  containerHeight,
  horizontalPadding,
  verticalPadding,
}: CalculateImageFitZoomInput): number {
  if (imageWidth <= 0 || imageHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return 1
  }

  const availableWidth = Math.max(1, containerWidth - horizontalPadding)
  const availableHeight = Math.max(1, containerHeight - verticalPadding)
  return Math.min(1, availableWidth / imageWidth, availableHeight / imageHeight)
}
