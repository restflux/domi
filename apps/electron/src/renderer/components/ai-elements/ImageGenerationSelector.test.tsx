import { expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { ImageGenerationSelector } from './ImageGenerationSelector'
import { InputToolbarOverflow } from './InputToolbarOverflow'
import { TooltipProvider } from '../ui/tooltip'
import { ChannelImageGenerationConfig } from '../settings/ChannelImageGenerationConfig'
import { imageGenerationSelectionsAtom } from '../../atoms/image-generation-atoms'

test('活动生图按钮只保留图标，模型与渠道放在悬停信息', () => {
  const store = createStore()
  store.set(imageGenerationSelectionsAtom, { 'work:test': { channelId: 'channel', modelId: 'gpt-image-2.5-flare' } })
  const html = renderToStaticMarkup(<Provider store={store}><ImageGenerationSelector scope="work:test" /></Provider>)
  expect(html).toContain('aria-label="调整生图参数"')
  expect(html).toContain('title="gpt-image-2.5-flare')
  expect(html).not.toContain('>gpt-image-2.5-flare<')
  expect(html).not.toContain('max-w-40')
})

test('加号菜单内的生图入口和其他操作使用同一行宽与文字列', () => {
  const html = renderToStaticMarkup(<Provider store={createStore()}><ImageGenerationSelector scope="work:test" menuRow /></Provider>)
  expect(html).toContain('composer-plus-item')
  expect(html).toContain('>图片生成</span>')
  expect(html).toContain('aria-label="图片生成"')
})

test('常驻更多项不会在工具栏初次测量时露出', () => {
  const html = renderToStaticMarkup(<TooltipProvider><InputToolbarOverflow items={[
    { key: 'normal', node: <button>普通工具</button> },
    { key: 'image', menuOnly: true, node: <button>生图隐藏项</button> },
  ]} /></TooltipProvider>)
  expect(html).toContain('普通工具')
  expect(html).toContain('更多工具')
  expect(html).not.toContain('生图隐藏项')
})

test('渠道模型逐项移除，协议不再使用原生下拉，可选地址默认收起', () => {
  const html = renderToStaticMarkup(<ChannelImageGenerationConfig provider="openai" value={{ protocol: 'openai-images', models: ['gpt-image-2.5-flare'] }} onChange={() => {}} />)
  expect(html).toContain('移除模型 gpt-image-2.5-flare')
  expect(html).toContain('添加模型')
  expect(html).toContain('使用独立图片接口地址')
  expect(html).not.toContain('逗号')
  // Radix 为表单兼容保留隐藏 select；可见入口必须为 combobox。
  expect(html).toContain('role="combobox"')
  expect(html).toContain('aria-label="接口协议"')
  expect(html).not.toContain('https://example.com/v1')
})

test('自定义渠道的必填图片地址直接显示，关闭生图不展开字段', () => {
  const html = renderToStaticMarkup(<ChannelImageGenerationConfig provider="custom" value={{ protocol: 'openai-images', models: ['custom-image'] }} onChange={() => {}} />)
  expect(html).toContain('图片接口根地址（必填）')
  expect(html).toContain('https://example.com/v1')
  const closed = renderToStaticMarkup(<ChannelImageGenerationConfig provider="openai" value={null} onChange={() => {}} />)
  expect(closed).not.toContain('接口协议')
  expect(closed).not.toContain('添加模型')
})
