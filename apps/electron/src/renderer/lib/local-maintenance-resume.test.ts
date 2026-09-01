import { describe, expect, test } from 'bun:test'
import {
  buildLocalMaintenanceContinuationPrompt,
  consumeQueuedLocalMaintenanceResume,
  dispatchLocalMaintenanceResume,
  getQueuedLocalMaintenanceResume,
} from './local-maintenance-resume.ts'

describe('Local maintenance continuation', () => {
  test('批准维修事务后生成自包含的立即执行提示，不要求用户再次发送继续', () => {
    const prompt = buildLocalMaintenanceContinuationPrompt({
      sessionId: 'session-1',
      requestId: 'request-1',
      transactionId: 'maintenance-1',
      goal: '只提交本任务文件并保留无关 Local 修改',
    })

    expect(prompt).toContain('maintenance-1')
    expect(prompt).toContain('只提交本任务文件并保留无关 Local 修改')
    expect(prompt).toContain('LocalMaintenanceStatus')
    expect(prompt).toContain('LocalMaintenanceWrite / LocalMaintenanceEdit / LocalMaintenanceBash')
    expect(prompt).toContain('CompleteLocalMaintenance')
    expect(prompt).toContain('不要再次请求开启维修事务')
  })

  test('续跑先进入持久队列，目标 AgentView 延迟挂载时仍可拉取且只消费匹配请求', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => { storage.set(key, value) },
        },
        dispatchEvent: () => true,
      },
    })
    try {
      const detail = {
        sessionId: 'delayed-session',
        requestId: 'request-delayed',
        transactionId: 'maintenance-delayed',
        goal: '延迟挂载后继续',
      }
      dispatchLocalMaintenanceResume(detail)
      expect(getQueuedLocalMaintenanceResume(detail.sessionId)).toEqual(detail)

      consumeQueuedLocalMaintenanceResume(detail.sessionId, 'other-request')
      expect(getQueuedLocalMaintenanceResume(detail.sessionId)).toEqual(detail)
      consumeQueuedLocalMaintenanceResume(detail.sessionId, detail.requestId)
      expect(getQueuedLocalMaintenanceResume(detail.sessionId)).toBeNull()
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })
})
