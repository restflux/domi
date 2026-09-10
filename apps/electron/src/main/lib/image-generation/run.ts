import type { GeneratedImage, GenerationMetadata, GenerationResult } from './service'

export const IMAGE_GENERATION_TIMEOUT_MS = 600_000
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000

/** 仅主进程运行内使用；URL 可能带签名，不得序列化到消息或日志。 */
export interface PendingImageGeneration {
  images: Array<GeneratedImage | { url: string }>
  text: string[]
  metadata: GenerationMetadata
}

/** 仅用于已经脱敏的供应商响应错误。网络异常不能直接回显。 */
export class ImageResponseError extends Error {}

/** 已分类且可直接展示的图片任务状态，不应被桥接重新标成生成失败。 */
export class ImageTaskError extends Error {}

const UNKNOWN_RESULT = '服务端可能仍在处理，是否计费取决于供应商。本轮已停止新的生图提交，不要自动重试；如需再次生成，请结束本轮后由用户明确重新发送。'

function timedSignal(milliseconds: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** 一次用户请求共享一个实例，不能按模型、tool_call_id 或工具名称另建。 */
export class ImageGenerationRun {
  #busy = false
  #blocked = false
  #disposed = false
  #pending?: PendingImageGeneration
  #lifetime = new AbortController()

  /** 附件保存成功后才放行下一次生成；保存失败仍可取回原结果。 */
  acknowledgeResult(): void { this.#pending = undefined }

  dispose(): void {
    this.#disposed = true
    this.#lifetime.abort()
    this.#pending = undefined
  }

  async execute(
    produce: (signal: AbortSignal, markSubmitted: () => void) => Promise<PendingImageGeneration>,
    userSignal?: AbortSignal,
  ): Promise<GenerationResult> {
    if (this.#disposed) throw new ImageTaskError('本次生图运行已结束，请重新发送请求')
    if (this.#busy) throw new ImageTaskError('本轮已有生图任务正在执行，请等待其结果，不要重复提交')
    if (this.#blocked) throw new ImageTaskError(`上一次生图结果尚未确认。${UNKNOWN_RESULT}`)
    if (userSignal?.aborted) throw new ImageTaskError('图片任务已由用户取消，未提交新的生图请求')
    const cancellation = userSignal ? AbortSignal.any([userSignal, this.#lifetime.signal]) : this.#lifetime.signal
    this.#busy = true
    const recovering = Boolean(this.#pending)
    try {
      if (!this.#pending) {
        const signal = timedSignal(IMAGE_GENERATION_TIMEOUT_MS, cancellation)
        let submitted = false
        try {
          signal.throwIfAborted()
          const generated = await produce(signal, () => { submitted = true })
          signal.throwIfAborted()
          if (this.#disposed) throw new ImageTaskError('运行已结束')
          this.#pending = generated
        } catch (error) {
          this.#blocked = submitted
          const reason = cancellation.aborted ? '图片生成等待已由用户取消'
            : signal.aborted ? '图片生成等待已超时（10分钟）'
              : error instanceof ImageResponseError ? error.message : '图片生成请求中断，未能确认结果'
          throw new ImageTaskError(`${reason}。${submitted ? UNKNOWN_RESULT : '尚未提交生图请求。'}`)
        }
      }
      const pending = this.#pending
      // 每张图片独立计时；已下载部分留在运行内，重试不重复下载或重新生成。
      for (let index = 0; index < pending.images.length; index++) {
        const image = pending.images[index]!
        if ('data' in image) continue
        const signal = timedSignal(IMAGE_DOWNLOAD_TIMEOUT_MS, cancellation)
        try {
          signal.throwIfAborted()
          const url = new URL(image.url)
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ImageTaskError('无效地址')
          const response = await fetch(url.toString(), { signal, redirect: 'error' })
          if (!response.ok) throw new ImageTaskError('下载失败')
          const data = Buffer.from(await response.arrayBuffer()).toString('base64')
          signal.throwIfAborted()
          if (this.#disposed) throw new ImageTaskError('运行已结束')
          pending.images[index] = { data, mimeType: 'image/png' }
        } catch {
          const reason = cancellation.aborted ? '图片下载已由用户取消'
            : signal.aborted ? '图片下载超时（2分钟）' : '图片下载失败'
          throw new ImageTaskError(`${reason}。已收到生成结果，本轮再次调用生图工具只会取回原结果，不会重新生成或应用新的修改要求。结束本轮后无法恢复此下载缓存。`)
        }
      }
      if (userSignal?.aborted || this.#disposed) throw new ImageTaskError('图片任务已取消；已生成的结果未交付，不要重新生成')
      return {
        images: pending.images.filter((image): image is GeneratedImage => 'data' in image),
        text: [...pending.text, ...(recovering ? ['已取回上一次生成的图片，本次未重新生成或应用新的修改要求。'] : [])],
        metadata: pending.metadata,
      }
    } finally { this.#busy = false }
  }
}
