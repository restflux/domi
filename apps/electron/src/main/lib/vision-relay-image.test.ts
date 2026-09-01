import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { buildVisionRelayAccessScope } from './vision-relay-access-scope'
import {
  buildVisionImageWarnings,
  normalizeAuthorizedVisionImage,
  validateVisionImageDimensions,
  VisionRelayImageError,
} from './vision-relay-image'

const root = mkdtempSync(join(tmpdir(), 'domi-vision-relay-image-'))
const outside = mkdtempSync(join(tmpdir(), 'domi-vision-relay-outside-'))
const pngPath = join(root, 'screen.png')
const jpegPath = join(root, 'photo.jpg')
const rotatedJpegPath = join(root, 'rotated.jpg')
const opaquePngPath = join(root, 'opaque.png')
const opaqueAlphaPngPath = join(root, 'opaque-alpha.png')
const longPngPath = join(root, 'long.png')
const fakePath = join(root, 'fake.png')
const outsidePath = join(outside, 'secret.png')

beforeAll(async () => {
  await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } })
    .png()
    .toFile(pngPath)
  await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 120, g: 100, b: 80 } } })
    .jpeg()
    .toFile(jpegPath)
  await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 200, g: 30, b: 20 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(rotatedJpegPath)
  await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toFile(opaquePngPath)
  await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
    .png()
    .toFile(opaqueAlphaPngPath)
  await sharp({ create: { width: 200, height: 1200, channels: 3, background: { r: 240, g: 240, b: 240 } } })
    .png()
    .toFile(longPngPath)
  writeFileSync(fakePath, 'not an image', 'utf-8')
  await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toFile(outsidePath)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const scope = () => buildVisionRelayAccessScope({ targetRoot: root })

describe('Vision Relay image normalization', () => {
  test('authorized PNG is fully decoded and re-encoded as metadata-free PNG', async () => {
    const image = await normalizeAuthorizedVisionImage({ imagePath: pngPath, scope: scope() })
    expect(image.mediaType).toBe('image/png')
    expect(image.filename).toBe('screen.png')
    expect(image.width).toBe(64)
    expect(image.height).toBe(32)
    const metadata = await sharp(image.data).metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.hasAlpha).toBe(false)
    expect(image.warnings).toContain('透明背景已合成为中性背景，以提高视觉模型识别稳定性。')
  })

  test('opaque PNG remains lossless without a transparency warning', async () => {
    const image = await normalizeAuthorizedVisionImage({ imagePath: opaquePngPath, scope: scope() })
    const pixel = await sharp(image.data).raw().toBuffer()
    expect([...pixel.subarray(0, 3)]).toEqual([10, 20, 30])
    expect(image.warnings).not.toContain('透明背景已合成为中性背景，以提高视觉模型识别稳定性。')
    const alphaImage = await normalizeAuthorizedVisionImage({ imagePath: opaqueAlphaPngPath, scope: scope() })
    expect((await sharp(alphaImage.data).metadata()).hasAlpha).toBe(true)
    expect(alphaImage.warnings).not.toContain('透明背景已合成为中性背景，以提高视觉模型识别稳定性。')
  })

  test('applies EXIF orientation before stripping metadata and reports output dimensions', async () => {
    expect((await sharp(rotatedJpegPath).metadata()).orientation).toBe(6)
    const image = await normalizeAuthorizedVisionImage({ imagePath: rotatedJpegPath, scope: scope() })
    const metadata = await sharp(image.data).metadata()
    expect(image.width).toBe(40)
    expect(image.height).toBe(80)
    expect(metadata.width).toBe(40)
    expect(metadata.height).toBe(80)
    expect(metadata.orientation).toBeUndefined()
  })

  test('adds bounded local warnings for long, low-resolution, and animated-first-frame risks', async () => {
    const longImage = await normalizeAuthorizedVisionImage({ imagePath: longPngPath, scope: scope() })
    expect(longImage.warnings).toContain('图片为超长截图，整图分析可能遗漏小字；建议裁剪问题区域。')
    const lowResolution = await normalizeAuthorizedVisionImage({ imagePath: opaquePngPath, scope: scope() })
    expect(lowResolution.warnings).toContain('图片分辨率较低，实体识别或 OCR 可能不准确。')
    expect(buildVisionImageWarnings({ width: 800, height: 600, animatedFirstFrame: true, transparentBackgroundNormalized: false }))
      .toContain('动画图片仅分析第一帧。')
  })

  test('authorized JPEG is decoded and re-encoded as JPEG', async () => {
    const image = await normalizeAuthorizedVisionImage({ imagePath: jpegPath, scope: scope() })
    expect(image.mediaType).toBe('image/jpeg')
    expect(image.filename).toBe('photo.jpg')
    expect((await sharp(image.data).metadata()).format).toBe('jpeg')
  })

  test('file outside exact roots is rejected before provider access', async () => {
    await expect(normalizeAuthorizedVisionImage({ imagePath: outsidePath, scope: scope() }))
      .rejects.toMatchObject({ code: 'VISION_FILE_NOT_AUTHORIZED' })
  })

  test('extension spoofing is rejected after full decode', async () => {
    await expect(normalizeAuthorizedVisionImage({ imagePath: fakePath, scope: scope() }))
      .rejects.toMatchObject({ code: 'VISION_UNSUPPORTED_IMAGE' })
  })

  test('oversized raw files are rejected before decoding', async () => {
    const huge = join(root, 'huge.png')
    writeFileSync(huge, Buffer.alloc(10 * 1024 * 1024 + 1))
    await expect(normalizeAuthorizedVisionImage({ imagePath: huge, scope: scope() }))
      .rejects.toMatchObject({ code: 'VISION_IMAGE_TOO_LARGE' })
  })

  test('dimension policy rejects pixel bombs and excessive edges', () => {
    expect(() => validateVisionImageDimensions(5000, 5000)).toThrow(VisionRelayImageError)
    expect(() => validateVisionImageDimensions(9000, 100)).toThrow(VisionRelayImageError)
    expect(() => validateVisionImageDimensions(4096, 4096)).not.toThrow()
  })

  test('already aborted requests fail without reading the image', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(normalizeAuthorizedVisionImage({ imagePath: pngPath, scope: scope(), signal: abort.signal }))
      .rejects.toMatchObject({ code: 'VISION_ABORTED' })
  })
})
