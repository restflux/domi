import { describe, expect, test } from 'bun:test'
import {
  buildGitAttributionPromptSection,
  isGitAttributionEnabled,
} from './agent-git-attribution.ts'

describe('Domi Git/PR 归因隔离', () => {
  test('Given 旧配置启用了 Proma 推广 When 解析 Domi 策略 Then 始终关闭', () => {
    expect(isGitAttributionEnabled(true)).toBe(false)
    expect(isGitAttributionEnabled({ enabled: true })).toBe(false)
  })

  // SDK sidecar attribution migration was removed with the Pi-only runtime cut.

  test('Given Agent 构建提交或 PR When 注入提示 Then 明确禁止产品推广标识', () => {
    const prompt = buildGitAttributionPromptSection(true)

    expect(prompt).toContain('Domi 不在用户仓库中添加产品推广归因')
    expect(prompt).not.toContain('必须附加 Proma 标识')
  })
})
