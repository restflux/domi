import React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandLogo } from './brand-logo'
import { DefaultLogo, getModelLogo, getChannelLogo, getProviderLogo } from '../../lib/model-logo'

describe('品牌资源与主题呈现', () => {
  test('GPT 新旧版本、GPT-OSS、图片模型统一用 OpenAI 图标', () => {
    const logo = getProviderLogo('openai')
    for (const id of ['gpt-5.5', 'gpt-6-astra', 'gpt-oss-120b', 'gpt-image-2']) {
      expect(getModelLogo(id)).toBe(logo)
    }
  })
  test('未知模型仍回退 Domi，不借用渠道品牌', () => {
    expect(getModelLogo('private-model', 'openai')).toBe(DefaultLogo)
    expect(getModelLogo('claude-sonnet-5', 'openai')).toBe(getProviderLogo('anthropic'))
    expect(getChannelLogo({ provider: 'custom', baseUrl: 'https://relay.example/openai.com' })).toBe(DefaultLogo)
  })
  test('单色 SVG 深色反相，保留尺寸、alt 和调用方样式', () => {
    const html = renderToStaticMarkup(<BrandLogo src={getModelLogo('gpt-6-astra')} alt="GPT" className="size-4 rounded" />)
    expect(html).toContain('dark:invert')
    expect(html).toContain('size-4 rounded')
    expect(html).toContain('alt="GPT"')
    expect(html).not.toContain('https://')
  })
  test('彩色品牌、专用资源和 Domi 默认图标不反相', () => {
    for (const src of [getModelLogo('gemini-4'), getModelLogo('deepgemini-3'), DefaultLogo]) {
      const html = renderToStaticMarkup(<BrandLogo src={src} className="size-[35px]" />)
      expect(html).not.toContain('dark:invert')
      expect(html).toContain('size-[35px]')
      expect(html).toContain('alt=""')
    }
  })
})
