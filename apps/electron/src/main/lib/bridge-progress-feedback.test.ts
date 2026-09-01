import { describe, expect, test } from 'bun:test'
import {
  BridgeProgressFeedback,
  type BridgeProgressScheduler,
} from './bridge-progress-feedback'

interface ScheduledJob {
  callback: () => void
  runAt: number
}

class FakeScheduler implements BridgeProgressScheduler {
  private now = 0
  private nextId = 1
  private readonly jobs = new Map<number, ScheduledJob>()

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++
    this.jobs.set(id, { callback, runAt: this.now + delayMs })
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.jobs.delete(handle as unknown as number)
  }

  advanceBy(ms: number): void {
    const target = this.now + ms
    while (true) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.runAt <= target)
        .sort((a, b) => a[1].runAt - b[1].runAt)[0]
      if (!next) break
      const [id, job] = next
      this.jobs.delete(id)
      this.now = job.runAt
      job.callback()
    }
    this.now = target
  }

  pendingCount(): number {
    return this.jobs.size
  }
}

async function flushDelivery(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createFeedback(messages: string[], scheduler: FakeScheduler): BridgeProgressFeedback {
  return new BridgeProgressFeedback(
    async (message) => { messages.push(message) },
    { scheduler, initialDelayMs: 100, repeatDelayMs: 200 },
  )
}

describe('BridgeProgressFeedback', () => {
  test('短任务完成前不发送额外提示', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    scheduler.advanceBy(99)
    feedback.stop()
    scheduler.advanceBy(500)
    await flushDelivery()

    expect(messages).toEqual([])
    expect(scheduler.pendingCount()).toBe(0)
  })

  test('长任务低频发送仍在处理中提示', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    scheduler.advanceBy(100)
    await flushDelivery()
    expect(messages).toEqual(['⏳ 仍在处理中...'])

    scheduler.advanceBy(199)
    await flushDelivery()
    expect(messages).toHaveLength(1)

    scheduler.advanceBy(1)
    await flushDelivery()
    expect(messages).toEqual(['⏳ 仍在处理中...', '⏳ 仍在处理中...'])
  })

  test('生图阶段只提示一次，持续等待也不发送周期心跳或提前提示上传', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    await feedback.announceImageGeneration()
    await feedback.announceImageGeneration()
    scheduler.advanceBy(1_000)
    await flushDelivery()

    expect(messages).toEqual(['🎨 正在生成图片...'])
    expect(messages).not.toContain('📤 正在上传结果...')
    expect(scheduler.pendingCount()).toBe(0)
  })

  test('生图阶段等待确认后恢复也不会重新启动通用心跳', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    await feedback.announceImageGeneration()
    feedback.pauseForInteraction()
    feedback.resumeAfterInteraction()
    scheduler.advanceBy(1_000)
    await flushDelivery()

    expect(messages).toEqual(['🎨 正在生成图片...'])
    expect(scheduler.pendingCount()).toBe(0)
  })

  test('上传提示在媒体发送前可等待完成且保持去重', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    await feedback.announceImageGeneration()
    scheduler.advanceBy(1_000)
    await flushDelivery()
    expect(messages).toEqual(['🎨 正在生成图片...'])

    feedback.prepareForFinalDelivery()
    await feedback.announceUploadingResults()
    await feedback.announceUploadingResults()

    expect(messages).toEqual(['🎨 正在生成图片...', '📤 正在上传结果...'])
  })

  test('进入最终交付时丢弃旧阶段排队，但允许上传提示', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    const pendingStage = feedback.announceImageGeneration()
    feedback.prepareForFinalDelivery()
    await feedback.announceUploadingResults()
    await pendingStage

    expect(messages).toEqual(['📤 正在上传结果...'])
    expect(scheduler.pendingCount()).toBe(0)
  })

  test('等待用户确认期间暂停心跳，回答后按新周期恢复', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    feedback.pauseForInteraction()
    scheduler.advanceBy(500)
    await flushDelivery()
    expect(messages).toEqual([])

    feedback.resumeAfterInteraction()
    scheduler.advanceBy(99)
    await flushDelivery()
    expect(messages).toEqual([])

    scheduler.advanceBy(1)
    await flushDelivery()
    expect(messages).toEqual(['⏳ 仍在处理中...'])
  })

  test('终态停止后清理定时器和排队提示', async () => {
    const scheduler = new FakeScheduler()
    const messages: string[] = []
    const feedback = createFeedback(messages, scheduler)

    feedback.start()
    const pending = feedback.announceImageGeneration()
    feedback.stop()
    scheduler.advanceBy(500)
    await pending
    await flushDelivery()

    expect(messages).toEqual([])
    expect(scheduler.pendingCount()).toBe(0)
  })

  test('连续两轮使用独立状态，不继承上一轮阶段和定时器', async () => {
    const scheduler = new FakeScheduler()
    const firstMessages: string[] = []
    const first = createFeedback(firstMessages, scheduler)
    first.start()
    await first.announceImageGeneration()
    first.stop()

    const secondMessages: string[] = []
    const second = createFeedback(secondMessages, scheduler)
    second.start()
    scheduler.advanceBy(100)
    await flushDelivery()

    expect(firstMessages).toEqual(['🎨 正在生成图片...'])
    expect(secondMessages).toEqual(['⏳ 仍在处理中...'])
  })
})
