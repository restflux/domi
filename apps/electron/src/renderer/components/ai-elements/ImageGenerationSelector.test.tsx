import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { ImageGenerationButton, ImageGenerationSelector } from './ImageGenerationSelector'
import { InputToolbarOverflow } from './InputToolbarOverflow'
import { TooltipProvider } from '../ui/tooltip'
import { ChannelImageGenerationConfig } from '../settings/ChannelImageGenerationConfig'
import { imageGenerationSelectionsAtom } from '../../atoms/image-generation-atoms'

test('活动生图按钮只保留图标，模型与渠道放在悬停信息', () => {
  const store = createStore()
  store.set(imageGenerationSelectionsAtom, { 'work:test': { channelId: 'channel', modelId: 'gpt-image-2.5-flare' } })
  const html = renderToStaticMarkup(<Provider store={store}><ImageGenerationButton scope="work:test" /></Provider>)
  expect(html).toContain('aria-label="调整生图参数"')
  expect(html).toContain('title="gpt-image-2.5-flare')
  expect(html).not.toContain('>gpt-image-2.5-flare<')
  expect(html).not.toContain('max-w-40')
})

test('未选生图时不常驻工具栏，弹层锚点仍挂载在菜单外以响应 /image', () => {
  const html = renderToStaticMarkup(<Provider store={createStore()}><ImageGenerationSelector scope="work:test" hideTrigger /></Provider>)
  expect(html).toContain('aria-hidden="true"')
  expect(html).toContain('tabindex="-1"')
  expect(html).not.toContain('aria-label="图片生成"')
  const work = readFileSync(resolve(import.meta.dir, '../agent/AgentView.tsx'), 'utf8')
  const chat = readFileSync(resolve(import.meta.dir, '../chat/ChatInput.tsx'), 'utf8')
  expect(work).toContain('<ImageGenerationSelector scope={`work:${sessionId}`} inputText={inputContent} hideTrigger />')
  expect(work.indexOf('<ImageGenerationSelector scope={`work:${sessionId}`}')).toBeLessThan(work.indexOf("key: 'model-presentation-preset'"))
  expect(work).toContain('onOpenImageGeneration: imageSelections[`work:${sessionId}`] ? undefined')
  expect(work).toContain("...(imageSelections[`work:${sessionId}`]\n                  ? [{ key: 'image-generation', node: <ImageGenerationButton")
  expect(chat).toContain('<ImageGenerationSelector scope={`chat:${conversationId}`} inputText={content} hideTrigger />')
  expect(chat.indexOf('<ImageGenerationSelector scope={`chat:${conversationId}`}')).toBeLessThan(chat.indexOf("key: 'model'"))
  expect(chat).toContain("...(imageSelections[`chat:${conversationId}`]\n      ? [{ key: 'image-generation', node: <ImageGenerationButton")
  expect(chat).toContain("key: 'image-generation-menu', menuOnly: true")
})

test('菜单动作先关闭外层弹层再打开独立生图面板', () => {
  const plus = readFileSync(resolve(import.meta.dir, 'composer-plus-menu.tsx'), 'utf8')
  const overflow = readFileSync(resolve(import.meta.dir, 'InputToolbarOverflow.tsx'), 'utf8')
  const chat = readFileSync(resolve(import.meta.dir, '../chat/ChatInput.tsx'), 'utf8')
  expect(plus).toContain('closeThen(openImageGeneration)')
  expect(plus).toContain('onCloseAutoFocus={handleCloseAutoFocus}')
  expect(plus).not.toContain('tools.imageGeneration}')
  expect(overflow).toContain('pendingMenuActionRef.current = it.onMenuSelect')
  expect(overflow).toContain('setPopoverOpen(false)')
  expect(overflow).toContain('onCloseAutoFocus={(event) => {')
  expect(overflow).toContain('event.preventDefault(); action()')
  expect(overflow).not.toContain('forceMount')
  expect(chat).toContain('onMenuSelect: () => setOpenImageScope(`chat:${conversationId}`)')
  const option = readFileSync(resolve(import.meta.dir, 'ImageOptionSelect.tsx'), 'utf8')
  expect(option).toContain('SelectContent className="z-[120]')
  expect(readFileSync(resolve(import.meta.dir, 'ImageGenerationSelector.tsx'), 'utf8')).toContain('PopoverContent side="top" align="start" className="z-[110]')
})

test('/image 空命令和无可用渠道时都有可见反馈，不丢弃输入或把命令送到普通模型', () => {
  const work = readFileSync(resolve(import.meta.dir, '../agent/AgentView.tsx'), 'utf8')
  const chat = readFileSync(resolve(import.meta.dir, '../chat/ChatView.tsx'), 'utf8')
  const selector = readFileSync(resolve(import.meta.dir, 'ImageGenerationSelector.tsx'), 'utf8')
  for (const source of [work, chat]) {
    expect(source).toContain("toast.info('请在 /image 后输入图片描述')")
    expect(source).toContain("toast.error(preferredImage ? '所选生图渠道或模型已不可用，请重新选择' : '请先在渠道设置中启用图片生成')")
  }
  expect(selector).toContain('if (!loaded || commandSeen[scope]) return')
  expect(selector).not.toContain('!channels.length) return')
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
