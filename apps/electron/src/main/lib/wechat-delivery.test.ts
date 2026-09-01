import { describe, expect, test } from 'bun:test'
import {
  assertWeChatSendMessageSucceeded,
  isRetryableWeChatDeliveryError,
  WeChatDeliveryError,
} from './wechat-delivery'

describe('微信可靠发送响应判定', () => {
  test('空对象和明确零响应都视为成功', () => {
    expect(() => assertWeChatSendMessageSucceeded({})).not.toThrow()
    expect(() => assertWeChatSendMessageSucceeded({ ret: 0 })).not.toThrow()
    expect(() => assertWeChatSendMessageSucceeded({ errcode: 0 })).not.toThrow()
  })

  test('HTTP 200 下明确非零业务码不能静默当作成功', () => {
    expect(() => assertWeChatSendMessageSucceeded({ ret: 40013, errmsg: 'invalid token' }))
      .toThrow('微信消息发送失败: 40013 invalid token')
    expect(() => assertWeChatSendMessageSucceeded({ ret: 0, errcode: 503, errmsg: 'busy' }))
      .toThrow('微信消息发送失败: 503 busy')
  })

  test('瞬时服务错误可重试，确定性参数错误立即失败', () => {
    let transient: unknown
    let permanent: unknown
    try {
      assertWeChatSendMessageSucceeded({ ret: 503, errmsg: 'busy' })
    } catch (error) {
      transient = error
    }
    try {
      assertWeChatSendMessageSucceeded({ ret: 40013, errmsg: 'invalid token' })
    } catch (error) {
      permanent = error
    }

    expect(transient).toBeInstanceOf(WeChatDeliveryError)
    expect(isRetryableWeChatDeliveryError(transient)).toBe(true)
    expect(isRetryableWeChatDeliveryError(permanent)).toBe(false)
    expect(isRetryableWeChatDeliveryError(new Error('network reset'))).toBe(true)
    expect(isRetryableWeChatDeliveryError(new Error('HTTP 503: busy'))).toBe(true)
    expect(isRetryableWeChatDeliveryError(new Error('HTTP 401: unauthorized'))).toBe(false)
  })
})
