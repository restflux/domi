import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ImageGenerationInfo } from './ImageGenerationInfo'

test('图片结果显示实际模型参数，重复结果去重，旧图片不新增空标签', () => {
  expect(renderToStaticMarkup(createElement(ImageGenerationInfo, { results: [] }))).toBe('')
  const metadata = { model: 'gpt-image-2.5-flare', protocol: 'openai-images' as const, quality: 'max' as const, size: '1024x1024', numberOfImages: 2 }
  const html = renderToStaticMarkup(createElement(ImageGenerationInfo, { results: [metadata, metadata] }))
  expect(html).toContain('gpt-image-2.5-flare · 1024x1024 · max')
  expect(html.split('gpt-image-2.5-flare')).toHaveLength(2)
})
