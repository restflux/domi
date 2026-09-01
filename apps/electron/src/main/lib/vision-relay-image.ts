import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import sharp from 'sharp'
import type { VisionRelayAccessScope } from './vision-relay-access-scope'
import { filterStableVisionRelayAccessScope, isCanonicalVisionPathAuthorized } from './vision-relay-access-scope'

export const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_VISION_IMAGE_PIXELS = 20_000_000
export const MAX_VISION_IMAGE_EDGE = 8_192
const DEFAULT_IMAGE_TIMEOUT_MS = 10_000

const SUPPORTED_IMAGE_FORMATS: Record<string, 'png' | 'jpeg' | 'gif' | 'webp'> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
}

export type VisionRelayImageErrorCode =
  | 'VISION_FILE_NOT_AUTHORIZED'
  | 'VISION_UNSUPPORTED_IMAGE'
  | 'VISION_IMAGE_TOO_LARGE'
  | 'VISION_IMAGE_TIMEOUT'
  | 'VISION_ABORTED'

export class VisionRelayImageError extends Error {
  constructor(readonly code: VisionRelayImageErrorCode, message: string) {
    super(message)
    this.name = 'VisionRelayImageError'
  }
}

export interface NormalizedVisionImage {
  filename: string
  mediaType: 'image/png' | 'image/jpeg'
  data: Buffer
  width: number
  height: number
  animatedFirstFrame: boolean
  /** 由本地规范化阶段生成的有界质量提示，不包含图片内容。 */
  warnings: string[]
}

export function buildVisionImageWarnings(input: {
  width: number
  height: number
  animatedFirstFrame: boolean
  transparentBackgroundNormalized: boolean
}): string[] {
  const warnings: string[] = []
  const longEdge = Math.max(input.width, input.height)
  const shortEdge = Math.min(input.width, input.height)
  if (shortEdge > 0 && longEdge / shortEdge >= 4) {
    warnings.push('图片为超长截图，整图分析可能遗漏小字；建议裁剪问题区域。')
  }
  if (shortEdge < 256 || input.width * input.height < 160_000) {
    warnings.push('图片分辨率较低，实体识别或 OCR 可能不准确。')
  }
  if (input.animatedFirstFrame) warnings.push('动画图片仅分析第一帧。')
  if (input.transparentBackgroundNormalized) {
    warnings.push('透明背景已合成为中性背景，以提高视觉模型识别稳定性。')
  }
  return warnings
}

function safeVisionFilename(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'image'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new VisionRelayImageError('VISION_ABORTED', '视觉请求已取消。')
}

export function validateVisionImageDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new VisionRelayImageError('VISION_UNSUPPORTED_IMAGE', '图片尺寸无效。')
  }
  if (width > MAX_VISION_IMAGE_EDGE || height > MAX_VISION_IMAGE_EDGE || width * height > MAX_VISION_IMAGE_PIXELS) {
    throw new VisionRelayImageError('VISION_IMAGE_TOO_LARGE', '图片尺寸或总像素超过视觉助手限制。')
  }
}

async function withImageTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cancel: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new VisionRelayImageError('VISION_IMAGE_TIMEOUT', '图片解码超时。'))
      cancel()
    }, timeoutMs)
    if (signal) {
      abortListener = () => {
        reject(new VisionRelayImageError('VISION_ABORTED', '视觉请求已取消。'))
        cancel()
      }
      signal.addEventListener('abort', abortListener, { once: true })
    }
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortListener) signal.removeEventListener('abort', abortListener)
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function sameFileIdentity(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

export async function normalizeAuthorizedVisionImage(input: {
  imagePath: string
  scope: VisionRelayAccessScope
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<NormalizedVisionImage> {
  throwIfAborted(input.signal)
  if (!input.imagePath?.trim()) {
    throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '未提供图片路径。')
  }

  const requestedPath = resolve(input.imagePath)
  let resolvedPath: string
  let pathStats: Stats
  try {
    const firstResolvedPath = realpathSync(requestedPath)
    const firstStats = lstatSync(firstResolvedPath)
    resolvedPath = realpathSync(requestedPath)
    pathStats = lstatSync(resolvedPath)
    if (!sameCanonicalPath(firstResolvedPath, resolvedPath) || !sameFileIdentity(firstStats, pathStats)) {
      throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '图片路径在授权检查期间发生变化。')
    }
  } catch (error) {
    if (error instanceof VisionRelayImageError) throw error
    throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '图片不存在、不可读取或不在授权范围。')
  }

  const stableScope = filterStableVisionRelayAccessScope(input.scope)
  if (!isCanonicalVisionPathAuthorized(resolvedPath, stableScope)) {
    throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '图片不在当前 Session Target 或显式附件授权范围内。')
  }

  const sourceExtension = extname(resolvedPath).toLowerCase()
  const expectedFormat = SUPPORTED_IMAGE_FORMATS[sourceExtension]
  if (!expectedFormat) {
    throw new VisionRelayImageError('VISION_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG、GIF 和 WebP 图片。')
  }

  let descriptor: number | undefined
  let sourceData: Buffer
  try {
    if (!pathStats.isFile()) {
      throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '视觉助手只能读取常规图片文件。')
    }
    if (pathStats.size <= 0 || pathStats.size > MAX_VISION_IMAGE_BYTES) {
      throw new VisionRelayImageError('VISION_IMAGE_TOO_LARGE', '图片必须大于 0 字节且不超过 10MB。')
    }
    descriptor = openSync(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const openedStats = fstatSync(descriptor)
    if (!openedStats.isFile() || !sameFileIdentity(openedStats, pathStats)) {
      throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '图片在读取期间发生变化，已拒绝外发。')
    }
    sourceData = readFileSync(descriptor)
    const finalResolvedPath = realpathSync(requestedPath)
    const finalStats = lstatSync(finalResolvedPath)
    if (sourceData.length !== openedStats.size
      || !sameCanonicalPath(finalResolvedPath, resolvedPath)
      || !sameFileIdentity(openedStats, finalStats)
      || !isCanonicalVisionPathAuthorized(finalResolvedPath, filterStableVisionRelayAccessScope(input.scope))) {
      throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '图片或其路径在读取期间发生变化，已拒绝外发。')
    }
  } catch (error) {
    if (error instanceof VisionRelayImageError) throw error
    throw new VisionRelayImageError('VISION_FILE_NOT_AUTHORIZED', '无法安全读取图片。')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }

  throwIfAborted(input.signal)
  try {
    const timeoutMs = input.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS
    const image = sharp(sourceData, {
      animated: false,
      limitInputPixels: MAX_VISION_IMAGE_PIXELS,
      failOn: 'warning',
    }).timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) })
    const cancel = () => image.destroy()
    const metadata = await withImageTimeout(image.metadata(), timeoutMs, input.signal, cancel)
    if (!metadata.width || !metadata.height || metadata.format !== expectedFormat) {
      throw new VisionRelayImageError('VISION_UNSUPPORTED_IMAGE', '文件扩展名与完整解码出的图片格式不一致。')
    }
    validateVisionImageDimensions(metadata.width, metadata.height)
    const animatedFirstFrame = (metadata.pages ?? 1) > 1
    const outputPng = sourceExtension === '.png'
    const alphaStats = outputPng && metadata.hasAlpha === true
      ? await withImageTimeout(image.stats(), timeoutMs, input.signal, cancel)
      : undefined
    const transparentBackgroundNormalized = alphaStats?.isOpaque === false
    image.rotate()
    const outputResult = outputPng
      ? await withImageTimeout(
          (transparentBackgroundNormalized ? image.flatten({ background: '#7f7f7f' }) : image)
            .png({ compressionLevel: 9, adaptiveFiltering: true })
            .toBuffer({ resolveWithObject: true }),
          timeoutMs,
          input.signal,
          cancel,
        )
      : await withImageTimeout(
          image.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true }),
          timeoutMs,
          input.signal,
          cancel,
        )
    throwIfAborted(input.signal)
    const output = outputResult.data
    if (output.length <= 0 || output.length > MAX_VISION_IMAGE_BYTES) {
      throw new VisionRelayImageError('VISION_IMAGE_TOO_LARGE', '安全重编码后的图片超过 10MB。')
    }
    validateVisionImageDimensions(outputResult.info.width, outputResult.info.height)
    return {
      filename: `${safeVisionFilename(basename(resolvedPath, sourceExtension))}.${outputPng ? 'png' : 'jpg'}`,
      mediaType: outputPng ? 'image/png' : 'image/jpeg',
      data: output,
      width: outputResult.info.width,
      height: outputResult.info.height,
      animatedFirstFrame,
      warnings: buildVisionImageWarnings({
        width: outputResult.info.width,
        height: outputResult.info.height,
        animatedFirstFrame,
        transparentBackgroundNormalized,
      }),
    }
  } catch (error) {
    if (error instanceof VisionRelayImageError) throw error
    throw new VisionRelayImageError('VISION_UNSUPPORTED_IMAGE', '图片无法安全解码或重新编码。')
  }
}
