export const BRIDGE_LONG_TASK_INITIAL_DELAY_MS = 45_000
export const BRIDGE_LONG_TASK_REPEAT_DELAY_MS = 120_000

export interface BridgeProgressScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

export interface BridgeProgressFeedbackOptions {
  initialDelayMs?: number
  repeatDelayMs?: number
  scheduler?: BridgeProgressScheduler
  onSendError?: (error: unknown) => void
}

type BridgeProgressStage = 'working' | 'generating_images' | 'uploading_results'
type AnnouncedStage = Exclude<BridgeProgressStage, 'working'>

const DEFAULT_SCHEDULER: BridgeProgressScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
}

function heartbeatMessage(): string {
  return '⏳ 仍在处理中...'
}

function stageMessage(stage: AnnouncedStage): string {
  return stage === 'generating_images'
    ? '🎨 正在生成图片...'
    : '📤 正在上传结果...'
}

/**
 * 微信、钉钉共用的轻量阶段反馈控制器。
 *
 * - 初始“Agent 处理中”由 Bridge 现有入口发送，本控制器只负责后续阶段。
 * - 阶段提示每轮只发一次；普通处理阶段保留低频心跳，进入生图后停止周期提示。
 * - stop 后，即使已有异步发送排队也会通过 generation 守卫跳过，避免串到下一轮。
 */
export class BridgeProgressFeedback {
  private readonly scheduler: BridgeProgressScheduler
  private readonly initialDelayMs: number
  private readonly repeatDelayMs: number
  private readonly onSendError: (error: unknown) => void
  private readonly announcedStages = new Set<AnnouncedStage>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private deliveryChain: Promise<void> = Promise.resolve()
  private stage: BridgeProgressStage = 'working'
  private active = false
  private paused = false
  private generation = 0

  constructor(
    private readonly send: (message: string) => Promise<void>,
    options: BridgeProgressFeedbackOptions = {},
  ) {
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER
    this.initialDelayMs = options.initialDelayMs ?? BRIDGE_LONG_TASK_INITIAL_DELAY_MS
    this.repeatDelayMs = options.repeatDelayMs ?? BRIDGE_LONG_TASK_REPEAT_DELAY_MS
    this.onSendError = options.onSendError ?? (() => {})
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.paused = false
    this.generation += 1
    this.scheduleHeartbeat(this.initialDelayMs)
  }

  announceImageGeneration(): Promise<void> {
    return this.announceStage('generating_images')
  }

  announceUploadingResults(): Promise<void> {
    return this.announceStage('uploading_results')
  }

  pauseForInteraction(): void {
    if (!this.active || this.paused) return
    this.paused = true
    this.cancelHeartbeat()
    this.generation += 1
  }

  resumeAfterInteraction(): void {
    if (!this.active || !this.paused) return
    this.paused = false
    this.generation += 1
    if (this.stage === 'working') this.scheduleHeartbeat(this.initialDelayMs)
  }

  prepareForFinalDelivery(): void {
    this.cancelHeartbeat()
    // 终态开始后丢弃尚未真正发送的旧阶段提示，但保持 active，允许紧接着发送上传提示。
    this.generation += 1
  }

  stop(): void {
    this.cancelHeartbeat()
    this.active = false
    this.paused = false
    this.generation += 1
  }

  private cancelHeartbeat(): void {
    if (!this.timer) return
    this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }

  private announceStage(stage: AnnouncedStage): Promise<void> {
    if (!this.active || this.paused || this.announcedStages.has(stage)) return this.deliveryChain
    this.stage = stage
    this.announcedStages.add(stage)
    if (stage === 'generating_images') this.cancelHeartbeat()
    return this.enqueue(stageMessage(stage))
  }

  private scheduleHeartbeat(delayMs: number): void {
    this.cancelHeartbeat()
    if (!this.active || this.paused || this.stage !== 'working') return
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null
      if (!this.active || this.paused || this.stage !== 'working') return
      void this.enqueue(heartbeatMessage())
      this.scheduleHeartbeat(this.repeatDelayMs)
    }, delayMs)
  }

  private enqueue(message: string): Promise<void> {
    const expectedGeneration = this.generation
    this.deliveryChain = this.deliveryChain.then(async () => {
      if (!this.active || this.paused || this.generation !== expectedGeneration) return
      try {
        await this.send(message)
      } catch (error) {
        this.onSendError(error)
      }
    })
    return this.deliveryChain
  }
}
