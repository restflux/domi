export interface WeChatSendMessageResponse {
  ret?: number
  errcode?: number
  errmsg?: string
}

/** 微信 iLink 已返回业务拒绝；retryable 用于区分瞬时服务错误与确定性参数/鉴权错误。 */
export class WeChatDeliveryError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'WeChatDeliveryError'
    this.retryable = retryable
  }
}

function isRetryableBusinessCode(code: number): boolean {
  return code === -1 || code === -2 || code === -3 || code === 429 || (code >= 500 && code < 600)
}

/**
 * iLink 某些成功响应是空对象，因此只有“明确出现且非零”的 ret/errcode 才判失败。
 * HTTP 200 不能代替业务成功判断。
 */
export function assertWeChatSendMessageSucceeded(
  response: WeChatSendMessageResponse,
  action = '消息发送',
): void {
  const code = response.ret != null && response.ret !== 0
    ? response.ret
    : response.errcode != null && response.errcode !== 0
      ? response.errcode
      : undefined
  if (code === undefined) return
  const detail = response.errmsg?.trim()
  throw new WeChatDeliveryError(
    `微信${action}失败: ${code}${detail ? ` ${detail}` : ''}`,
    isRetryableBusinessCode(code),
  )
}

export function isRetryableWeChatDeliveryError(error: unknown): boolean {
  if (error instanceof WeChatDeliveryError) return error.retryable
  if (!(error instanceof Error)) return true
  const httpStatus = /^HTTP (\d{3})\b/.exec(error.message)?.[1]
  if (!httpStatus) return true
  const status = Number(httpStatus)
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}
