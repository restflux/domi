import { describe, expect, test } from 'bun:test'
import { calculateImageFitZoom } from './image-preview-zoom.ts'

describe('calculateImageFitZoom', () => {
  test('横向大图按可用宽度完整适配预览区域', () => {
    expect(calculateImageFitZoom({
      imageWidth: 2000,
      imageHeight: 1000,
      containerWidth: 1000,
      containerHeight: 800,
      horizontalPadding: 32,
      verticalPadding: 64,
    })).toBeCloseTo(0.484)
  })

  test('纵向大图按可用高度完整适配预览区域', () => {
    expect(calculateImageFitZoom({
      imageWidth: 800,
      imageHeight: 1600,
      containerWidth: 1000,
      containerHeight: 800,
      horizontalPadding: 32,
      verticalPadding: 64,
    })).toBeCloseTo(0.46)
  })

  test('小图保持原始大小，避免默认放大失真', () => {
    expect(calculateImageFitZoom({
      imageWidth: 400,
      imageHeight: 240,
      containerWidth: 1000,
      containerHeight: 800,
      horizontalPadding: 32,
      verticalPadding: 64,
    })).toBe(1)
  })

  test('超大图片允许缩小到 10% 以下以完整展示', () => {
    expect(calculateImageFitZoom({
      imageWidth: 12000,
      imageHeight: 8000,
      containerWidth: 800,
      containerHeight: 600,
      horizontalPadding: 32,
      verticalPadding: 64,
    })).toBeCloseTo(0.064)
  })
})
