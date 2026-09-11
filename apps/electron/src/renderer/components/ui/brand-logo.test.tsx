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
  test('GLM 使用 Z.ai，智谱渠道和其他家族保留智谱标志', () => {
    const logo = getModelLogo('glm-5.2')
    expect(logo).toContain('zai.svg')
    expect(getModelLogo('zai-org/GLM-5.2')).toBe(logo)
    expect(getModelLogo('chatglm4')).toBe(logo)
    expect(logo).not.toBe(getProviderLogo('zhipu'))
    expect(getModelLogo('cogview-4')).toBe(getProviderLogo('zhipu'))
    expect(getChannelLogo({ provider: 'zhipu-coding', baseUrl: 'https://open.bigmodel.cn' })).toBe(getProviderLogo('zhipu'))
    expect(renderToStaticMarkup(<BrandLogo src={logo} />)).toContain('dark:invert')
  })
  test('混元缩写及官方命名空间复用对应家族图标', () => {
    expect(getModelLogo('Hy3')).toBe(getModelLogo('hunyuan-turbo'))
    expect(getModelLogo('tencent/Hy4-preview')).toBe(getModelLogo('hunyuan-turbo'))
    expect(getModelLogo('Hy3')).not.toBe(DefaultLogo)
    expect(getModelLogo('ByteDance-Seed/Seed-OSS-36B-Instruct')).toBe(getModelLogo('doubao-seed-2'))
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
    for (const src of [getModelLogo('gemini-4'), getModelLogo('deepgemini-3'), getModelLogo('minimax-m3'), getModelLogo('Hy4-preview'), DefaultLogo]) {
      const html = renderToStaticMarkup(<BrandLogo src={src} className="size-[35px]" />)
      expect(html).not.toContain('dark:invert')
      expect(html).toContain('size-[35px]')
      expect(html).toContain('alt=""')
    }
  })
})
