import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { readFileSync } from 'node:fs'
import { prepareSideChatImages, sideChatImagesAtomFamily, sideChatComposerErrorAtomFamily, imagePreview, removeSentSideChatImages } from './side-chat-images'
import { sideChatSendInput } from './side-chat-behavior'
import { sideChatDraftAtomFamily, sideChatViewAtomFamily, sideChatOperationAtomFamily } from '@/atoms/side-chat-atoms'
import { sendSideChatDraft } from './side-chat-send'

const png = () => new File(['image'], '截图.png', { type: 'image/png' })
const read = async () => 'aW1hZ2U='

describe('侧聊图片输入', () => {
  test('选择和粘贴共享文件读取，重复图片名去重并准备预览', async () => {
    const images = await prepareSideChatImages([png(), png()], [], read)
    expect(images.map((image) => image.filename)).toEqual(['截图.png', '截图-1.png'])
    expect(imagePreview(images[0]!)).toBe('data:image/png;base64,aW1hZ2U=')
    expect(images[0]!.id).not.toBe(images[1]!.id)
  })
  test('仅图片发送不强制文字、不发送UI标识或路径，也不覆盖默认模型', async () => {
    const store = createStore()
    const images = await prepareSideChatImages([png()], [], read)
    const input = sideChatSendInput('parent', store.get(sideChatDraftAtomFamily('parent')), images)
    expect(input).toEqual({ parentSessionId: 'parent', message: '', images: [{ filename: '截图.png', mediaType: 'image/png', data: 'aW1hZ2U=' }] })
  })
  test('仅图片草稿真实提交一次；空草稿和重复提交不启动', async () => {
    const store = createStore()
    const parent = 'only-image'
    store.set(sideChatViewAtomFamily(parent), { parentSessionId: parent, sessionId: 'child', messages: [], isRunning: false })
    let calls = 0
    const send = async () => { calls += 1 }
    await sendSideChatDraft(store, parent, false, send)
    expect(calls).toBe(0)
    store.set(sideChatImagesAtomFamily(parent), await prepareSideChatImages([png()], [], read))
    await sendSideChatDraft(store, parent, false, async (payload) => {
      expect(payload.message).toBe('')
      expect(payload.images).toHaveLength(1)
      calls += 1
      await sendSideChatDraft(store, parent, false, send)
    })
    expect(calls).toBe(1)
    expect(store.get(sideChatImagesAtomFamily(parent))).toEqual([])
  })
  test('不接受非图片、空文件及超出本轮预算的批次', async () => {
    await expect(prepareSideChatImages([new File(['text'], 'a.txt', { type: 'text/plain' })], [], read)).rejects.toThrow('请选择')
    await expect(prepareSideChatImages([new File([], 'a.png', { type: 'image/png' })], [], read)).rejects.toThrow('请选择')
    await expect(prepareSideChatImages(Array.from({ length: 11 }, png), [], read)).rejects.toThrow('10')
    await expect(prepareSideChatImages([new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'a.png', { type: 'image/png' })], [], read)).rejects.toThrow('20MB')
  })
  test('发送成功只移除发送快照，不吞掉准备期间新增的图片', async () => {
    const sent = await prepareSideChatImages([png()], [], read)
    const later = await prepareSideChatImages([png()], sent, read)
    expect(removeSentSideChatImages([...sent, ...later], sent)).toEqual(later)
  })
  test('异步图片准备归属原父会话，侧聊关闭重开不影响草稿，错误互相隔离', async () => {
    const store = createStore()
    let complete!: (data: string) => void
    const sourceAtom = sideChatImagesAtomFamily('a')
    const pending = prepareSideChatImages([png()], [], () => new Promise((resolve) => { complete = resolve }))
    const other = sideChatImagesAtomFamily('b')
    complete('aW1hZ2U=')
    store.set(sourceAtom, await pending)
    store.set(sideChatComposerErrorAtomFamily('a'), '发送失败')
    expect(store.get(other)).toEqual([])
    expect(store.get(sideChatImagesAtomFamily('a'))).toHaveLength(1)
    expect(store.get(sideChatComposerErrorAtomFamily('b'))).toBe('')
    expect(store.get(sideChatDraftAtomFamily('a')).text).toBe('')
  })
  test('失败保留文字和图片，成功只清理提交快照，父会话切换不串用', async () => {
    const store = createStore()
    const parent = 'send-parent'
    const imagesAtom = sideChatImagesAtomFamily(parent)
    const draftAtom = sideChatDraftAtomFamily(parent)
    const images = await prepareSideChatImages([png()], [], read)
    store.set(imagesAtom, images)
    store.set(sideChatViewAtomFamily(parent), { parentSessionId: parent, sessionId: 'child', messages: [], isRunning: false })
    store.set(draftAtom, (current) => ({ ...current, text: '分析图片' }))
    await sendSideChatDraft(store, parent, false, async () => { throw new Error('不支持图片') })
    expect(store.get(imagesAtom)).toEqual(images)
    expect(store.get(draftAtom).text).toBe('分析图片')
    expect(store.get(sideChatOperationAtomFamily(parent)).sending).toBe(false)
    const later = await prepareSideChatImages([png()], images, read)
    await sendSideChatDraft(store, parent, false, async (payload) => {
      expect(payload.parentSessionId).toBe(parent)
      expect(payload.images).toHaveLength(1)
      store.set(imagesAtom, (current) => [...current, ...later])
      store.set(draftAtom, (current) => ({ ...current, text: '下一条问题' }))
    })
    expect(store.get(imagesAtom)).toEqual(later)
    expect(store.get(draftAtom).text).toBe('下一条问题')
    expect(store.get(sideChatImagesAtomFamily('other-parent'))).toEqual([])
    expect(store.get(sideChatViewAtomFamily(parent))?.isRunning).toBe(true)
  })
  test('回复已完成后迟到的发送确认不把侧聊重新标成运行中', async () => {
    const store = createStore()
    const parent = 'fast-complete'
    store.set(sideChatDraftAtomFamily(parent), (current) => ({ ...current, text: '问题' }))
    store.set(sideChatViewAtomFamily(parent), { parentSessionId: parent, sessionId: 'child', messages: [], isRunning: false })
    await sendSideChatDraft(store, parent, false, async () => {
      store.set(sideChatOperationAtomFamily(parent), (current) => ({ ...current, revision: current.revision + 1 }))
    })
    expect(store.get(sideChatViewAtomFamily(parent))?.isRunning).toBe(false)
  })
  test('组件保留图片选择与粘贴入口', () => {
    const source = readFileSync(new URL('./SideChatPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('onPasteFiles={(files) => void addImages(files)}')
    expect(source).toContain('type="file" multiple')
    expect(source).toContain('AttachmentPreviewItem')
    expect(source).not.toContain('onEditComplete=')
  })
})
