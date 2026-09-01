import { describe, expect, test } from 'bun:test'
import {
  resolveWorkActivityNotificationNavigation,
  shouldPresentWorkActivityToast,
} from './work-activity-notification-presentation'

describe('Work Activity 通知呈现', () => {
  test('单项通知点击打开宿主指定的原会话', () => {
    expect(resolveWorkActivityNotificationNavigation(
      { type: 'session', rootSessionId: 'root-a' },
      [{ id: 'root-a', title: '实现通知系统' }],
    )).toEqual({ type: 'session', sessionId: 'root-a', title: '实现通知系统' })
  })

  test('完成汇总点击进入完整工作动态', () => {
    expect(resolveWorkActivityNotificationNavigation({ type: 'work_activity' }, [])).toEqual({ type: 'work_activity' })
  })

  test('系统通知不在 Renderer 重复显示 Toast', () => {
    const notification = {
      notification: {
        kind: 'attention' as const,
        title: '需要关注',
        body: '等待回答',
        target: { type: 'session' as const, rootSessionId: 'root-a' },
        soundType: 'permissionRequest' as const,
        playSound: true,
      },
    }
    expect(shouldPresentWorkActivityToast({ channel: 'system', ...notification })).toBe(false)
    expect(shouldPresentWorkActivityToast({ channel: 'toast', ...notification })).toBe(true)
  })
})
