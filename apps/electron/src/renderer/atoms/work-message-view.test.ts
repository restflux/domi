import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { workMessageViewAtom } from './work-message-view'

describe('Work 消息视图偏好', () => {
  test('默认 V1，可在当前窗口切换 V2 再切回 V1', () => {
    const store = createStore()
    expect(store.get(workMessageViewAtom)).toBe('v1')
    store.set(workMessageViewAtom, 'v2')
    expect(store.get(workMessageViewAtom)).toBe('v2')
    store.set(workMessageViewAtom, 'v1')
    expect(store.get(workMessageViewAtom)).toBe('v1')
  })
})
