import { describe, expect, test } from 'bun:test'
import {
  AGENT_WORKFLOW_DISPLAY_OPTIONS,
  EXECUTION_POLICY_DISPLAY_OPTIONS,
  getAgentWorkflowDisplay,
  getAgentWorkflowRuntimeDisplay,
  getExecutionPolicyDisplay,
} from './agent-control-display.ts'

describe('Agent control display model', () => {
  test('presents only Research and Execute as persistent user modes', () => {
    expect(AGENT_WORKFLOW_DISPLAY_OPTIONS.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: 'read-only', label: '研究' },
      { value: 'direct', label: '执行' },
    ])
    expect(getAgentWorkflowDisplay('read-only').description).toContain('仅执行本次')
    expect(getAgentWorkflowDisplay('plan-first').label).toBe('研究')
    expect(getAgentWorkflowDisplay('direct').description).toContain('关键宿主事务')
  })

  test('presents a temporary execution lease without changing persistent Research or Execute labels', () => {
    expect(getAgentWorkflowRuntimeDisplay('read-only', true)).toEqual({
      label: '本次执行',
      description: '当前任务已临时获得执行权限，任务结束后恢复研究模式。',
      kind: 'temporary-execute',
    })
    expect(getAgentWorkflowRuntimeDisplay('direct', true).label).toBe('执行')
    expect(getAgentWorkflowRuntimeDisplay('read-only', false).label).toBe('研究')
  })

  test('keeps legacy policy display only as a Full Access compatibility view', () => {
    expect(EXECUTION_POLICY_DISPLAY_OPTIONS.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: 'full-access', label: '完全访问' },
    ])
    expect(getExecutionPolicyDisplay('controlled')).toEqual(getExecutionPolicyDisplay('full-access'))
    expect(getExecutionPolicyDisplay('autonomous').description).toContain('没有 OS 沙箱')
  })
})
