import { describe, expect, test } from 'bun:test'
import { normalizeAgentExecutionSettings } from './index.ts'

describe('Agent execution settings migration', () => {
  test('Given missing settings When normalized Then new sessions default to Execute with Full Access', () => {
    expect(normalizeAgentExecutionSettings({})).toEqual({
      executionPolicy: 'full-access',
      workflow: 'direct',
    })
  })

  test('Given either legacy policy When normalized Then both collapse to Full Access', () => {
    for (const executionPolicy of ['controlled', 'autonomous', 'full-access'] as const) {
      expect(normalizeAgentExecutionSettings({ executionPolicy, workflow: 'direct' })).toEqual({
        executionPolicy: 'full-access',
        workflow: 'direct',
      })
    }
  })

  test('Given legacy Plan First When normalized Then it safely returns to persistent Research', () => {
    expect(normalizeAgentExecutionSettings({ permissionMode: 'plan' })).toEqual({
      executionPolicy: 'full-access',
      workflow: 'read-only',
    })
    expect(normalizeAgentExecutionSettings({ workflow: 'plan-first' })).toEqual({
      executionPolicy: 'full-access',
      workflow: 'read-only',
    })
  })

  test('Given Read Only is persisted When normalized Then Research remains persistent', () => {
    expect(normalizeAgentExecutionSettings({
      executionPolicy: 'controlled',
      workflow: 'read-only',
    })).toEqual({
      executionPolicy: 'full-access',
      workflow: 'read-only',
    })
  })

  test('Given legacy Pi tool profiles When normalized Then they map into the two persistent modes', () => {
    expect(normalizeAgentExecutionSettings({
      workflow: 'direct',
      piToolProfile: 'readOnly',
    })).toEqual({ executionPolicy: 'full-access', workflow: 'read-only' })
    expect(normalizeAgentExecutionSettings({
      workflow: 'plan-first',
      piToolProfile: 'noBash',
    })).toEqual({ executionPolicy: 'full-access', workflow: 'direct' })
    expect(normalizeAgentExecutionSettings({
      workflow: 'plan-first',
      piToolProfile: 'full',
    })).toEqual({ executionPolicy: 'full-access', workflow: 'read-only' })
  })

  test('Given normalized settings When normalized again Then migration is idempotent', () => {
    const once = normalizeAgentExecutionSettings({ executionPolicy: 'autonomous', workflow: 'plan-first' })
    expect(normalizeAgentExecutionSettings(once)).toEqual(once)
  })
})
