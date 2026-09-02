import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Channel } from '@domi/shared'
import type { AgentSessionHandoffSynthesisDependencies } from './agent-session-handoff-synthesis.ts'

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => process.cwd() },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {}, dialog: {}, nativeImage: { createFromPath: () => ({}) }, nativeTheme: {},
  powerMonitor: {}, powerSaveBlocker: {}, screen: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}))

let synthesis: typeof import('./agent-session-handoff-synthesis.ts')
beforeAll(async () => {
  synthesis = await import('./agent-session-handoff-synthesis.ts')
})

const generated = `## 任务目标
完成跨项目交接
## 已完成工作
已实现入口
## 关键决定
不修改来源会话
## 当前状态
等待验证
## 剩余事项
运行测试
## 验证结果
尚未运行
## 重要文件
- src/a.ts
## 风险与注意事项
核对目标项目
## 原项目路径
D:/old，仅供参考，不作为新会话目标`

function channel(provider: Channel['provider'] = 'openai'): Channel {
  return {
    id: 'channel', name: 'Channel', provider, baseUrl: 'https://example.com', apiKey: 'encrypted',
    enabled: true, models: [{ id: 'model', name: 'Model', enabled: true }], createdAt: 1, updatedAt: 1,
  }
}

function dependencies(overrides: Partial<AgentSessionHandoffSynthesisDependencies> = {}): AgentSessionHandoffSynthesisDependencies {
  return {
    getChannel: () => channel(),
    resolveApiKey: async () => 'key',
    getProxyUrl: async () => undefined,
    generateCodex: async () => generated,
    generateProvider: async () => generated,
    ...overrides,
  }
}

describe('Agent session handoff synthesis', () => {
  test('普通渠道使用来源模型生成结构完整的交接内容', async () => {
    const calls: string[] = []
    const result = await synthesis.synthesizeAgentSessionHandoff({
      channelId: 'channel', modelId: 'model', evidence: '持久化会话证据',
    }, dependencies({
      generateProvider: async (input) => {
        calls.push(`${input.channelId}:${input.modelId}:${input.evidence}`)
        return generated
      },
    }))

    expect(result).toBe(generated)
    expect(calls).toEqual(['channel:model:持久化会话证据'])
    expect(synthesis.HANDOFF_SYNTHESIS_SYSTEM_PROMPT).toContain('只根据输入证据总结')
  })

  test('ChatGPT OAuth 渠道使用 Codex 文本请求，不读取普通 API Key', async () => {
    let apiKeyCalls = 0
    let codexCalls = 0
    const result = await synthesis.synthesizeAgentSessionHandoff({
      channelId: 'channel', modelId: 'model', evidence: '证据',
    }, dependencies({
      getChannel: () => channel('openai-codex'),
      resolveApiKey: async () => { apiKeyCalls += 1; return 'unused' },
      generateCodex: async () => { codexCalls += 1; return generated },
    }))

    expect(result).toBe(generated)
    expect(apiKeyCalls).toBe(0)
    expect(codexCalls).toBe(1)
  })

  test('AI 返回空内容或缺少必要部分时明确失败，不退回固定模板', async () => {
    await expect(synthesis.synthesizeAgentSessionHandoff({
      channelId: 'channel', modelId: 'model', evidence: '证据',
    }, dependencies({ generateProvider: async () => null }))).rejects.toThrow('AI 未生成可用的交接内容')

    await expect(synthesis.synthesizeAgentSessionHandoff({
      channelId: 'channel', modelId: 'model', evidence: '证据',
    }, dependencies({ generateProvider: async () => '## 任务目标\n只有目标' }))).rejects.toThrow('交接内容不完整')

    await expect(synthesis.synthesizeAgentSessionHandoff({
      channelId: 'channel', modelId: 'model', evidence: '证据',
    }, dependencies({
      generateProvider: async () => generated.replace('仅供参考，不作为新会话目标', '旧项目'),
    }))).rejects.toThrow('没有正确说明原项目路径用途')
  })
})
