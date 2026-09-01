import { describe, expect, test } from 'bun:test'
import type { SkillTriggerEvent } from '@domi/shared'
import type { SkillTriggerRecorder } from '../skill-trigger-recorder'
import { recordSkillTriggerFromToolStart } from './pi-agent-adapter.ts'

function fakeRecorder(results: Array<{ path: string; toolCallId: string } | null>): SkillTriggerRecorder {
  return {
    record: (path: string, toolCallId: string) => {
      const matched = results.find((r) => r && r.path === path && r.toolCallId === toolCallId) ?? null
      if (!matched) return null
      return {
        sessionId: 's1',
        skillSlug: 'tdd',
        skillName: 'tdd',
        source: 'workspace',
        filePath: 'tdd/SKILL.md',
        toolCallId,
        timestamp: 1,
      }
    },
  }
}

describe('recordSkillTriggerFromToolStart', () => {
  test('Pi 原生小写 read 命中技能路径时记录并上浮', () => {
    const recorder = fakeRecorder([{ path: 'C:\\ws\\skills\\tdd\\SKILL.md', toolCallId: 'call-1' }])
    const emitted: SkillTriggerEvent[] = []
    const result = recordSkillTriggerFromToolStart(
      { skillTriggerRecorder: recorder, onSkillTrigger: (t) => emitted.push(t) },
      { toolName: 'read', toolCallId: 'call-1', args: { path: 'C:\\ws\\skills\\tdd\\SKILL.md' } },
    )
    expect(result?.skillSlug).toBe('tdd')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.toolCallId).toBe('call-1')
  })

  test('兼容展示层大写 Read 事件', () => {
    const recorder = fakeRecorder([{ path: 'C:\\ws\\skills\\tdd\\SKILL.md', toolCallId: 'call-display' }])
    const result = recordSkillTriggerFromToolStart(
      { skillTriggerRecorder: recorder },
      { toolName: 'Read', toolCallId: 'call-display', args: { path: 'C:\\ws\\skills\\tdd\\SKILL.md' } },
    )
    expect(result?.skillSlug).toBe('tdd')
  })

  test('Read 未命中技能路径时不记录不上浮', () => {
    const recorder = fakeRecorder([])
    const emitted: SkillTriggerEvent[] = []
    const result = recordSkillTriggerFromToolStart(
      { skillTriggerRecorder: recorder, onSkillTrigger: (t) => emitted.push(t) },
      { toolName: 'Read', toolCallId: 'call-2', args: { path: 'C:\\src\\main.ts' } },
    )
    expect(result).toBeNull()
    expect(emitted).toHaveLength(0)
  })

  test('非 Read 工具直接跳过', () => {
    const recorder = fakeRecorder([{ path: 'C:\\ws\\skills\\tdd\\SKILL.md', toolCallId: 'call-3' }])
    const emitted: SkillTriggerEvent[] = []
    const result = recordSkillTriggerFromToolStart(
      { skillTriggerRecorder: recorder, onSkillTrigger: (t) => emitted.push(t) },
      { toolName: 'Bash', toolCallId: 'call-3', args: { path: 'C:\\ws\\skills\\tdd\\SKILL.md' } },
    )
    expect(result).toBeNull()
    expect(emitted).toHaveLength(0)
  })

  test('path 非字符串时安全跳过', () => {
    const recorder = fakeRecorder([])
    const result = recordSkillTriggerFromToolStart(
      { skillTriggerRecorder: recorder },
      { toolName: 'Read', toolCallId: 'call-4', args: { path: 42 } },
    )
    expect(result).toBeNull()
  })

  test('未注入记录器时直接返回 null', () => {
    const result = recordSkillTriggerFromToolStart(
      {},
      { toolName: 'Read', toolCallId: 'call-5', args: { path: 'C:\\ws\\skills\\tdd\\SKILL.md' } },
    )
    expect(result).toBeNull()
  })
})
