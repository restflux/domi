import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import type { ChatToolMeta } from '@domi/shared'

let tempHome: string
let config: typeof import('./chat-tool-config.ts')
let configPaths: typeof import('./config-paths.ts')
const originalHome = process.env.HOME
const originalDomiDev = process.env.DOMI_DEV

mock.module('electron', () => ({
  app: { isPackaged: true },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'domi-chat-tool-config-'))
  process.env.HOME = tempHome
  process.env.DOMI_DEV = '0'
  configPaths = await import('./config-paths.ts')
  config = await import('./chat-tool-config.ts')
})

beforeEach(() => {
  rmSync(join(tempHome, '.domi'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalDomiDev === undefined) delete process.env.DOMI_DEV
  else process.env.DOMI_DEV = originalDomiDev
  rmSync(tempHome, { recursive: true, force: true })
})

function customTool(httpConfig: NonNullable<ChatToolMeta['httpConfig']>): ChatToolMeta {
  return {
    id: 'custom-sample',
    name: 'Sample',
    description: 'sample',
    params: [],
    category: 'custom',
    executorType: 'http',
    httpConfig,
  }
}

describe('Chat 自定义 HTTP 配置', () => {
  test('Given plain sensitive header When adding tool Then reject before persistence', () => {
    expect(() => config.addCustomTool(customTool({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { Authorization: 'Bearer opaque-plain-value' },
    }))).toThrow('必须使用 {{credential.<key>}} 引用')
    expect(existsSync(configPaths.getChatToolsConfigPath())).toBe(false)
  })

  test('Given credential reference in URL When adding tool Then reject unsafe placement', () => {
    expect(() => config.addCustomTool(customTool({
      urlTemplate: 'https://example.com/api?api_key={{credential.apiKey}}',
      method: 'GET',
    }))).toThrow('凭据不能注入 URL')
  })

  test('Given credential references in header and body When adding tool Then metadata persists without secret', () => {
    config.addCustomTool(customTool({
      urlTemplate: 'https://example.com/api',
      method: 'POST',
      headers: { Authorization: 'Bearer {{credential.apiKey}}' },
      bodyTemplate: '{"clientSecret":"{{credential.clientSecret}}"}',
    }))

    const raw = readFileSync(configPaths.getChatToolsConfigPath(), 'utf-8')
    expect(raw).toContain('{{credential.apiKey}}')
    expect(raw).toContain('{{credential.clientSecret}}')
    expect(raw).not.toContain('opaque-secret-value')
  })

  test('Given unsafe tool was manually persisted When reading config Then runtime registry can still fail closed', () => {
    const filePath = configPaths.getChatToolsConfigPath()
    writeFileSync(filePath, JSON.stringify({
      toolStates: { 'custom-sample': { enabled: true } },
      toolCredentials: {},
      customTools: [customTool({
        urlTemplate: 'https://example.com/api',
        method: 'GET',
        headers: { Authorization: 'Bearer manually-persisted-secret' },
      })],
    }), 'utf-8')

    const stored = config.getChatToolsConfig()
    expect(stored.customTools).toHaveLength(1)
    expect(stored.customTools[0]?.httpConfig?.headers?.Authorization).toContain('manually-persisted-secret')
  })

  test('Given custom tool credential patch When updating one key Then existing keys remain intact', () => {
    config.addCustomTool(customTool({
      urlTemplate: 'https://example.com/api',
      method: 'POST',
      headers: { 'X-API-Key': '{{credential.apiKey}}' },
      bodyTemplate: '{"clientSecret":"{{credential.clientSecret}}"}',
    }))
    config.updateToolCredentials('custom-sample', {
      apiKey: 'first-value',
      clientSecret: 'keep-value',
    })

    config.updateToolCredentials('custom-sample', { apiKey: 'replacement-value' })

    expect(config.getToolCredentials('custom-sample')).toEqual({
      apiKey: 'replacement-value',
      clientSecret: 'keep-value',
    })
  })

  test('Given custom tool credentials When deleting tool Then state and credentials are removed', () => {
    config.addCustomTool(customTool({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { 'X-API-Key': '{{credential.apiKey}}' },
    }))
    config.updateToolCredentials('custom-sample', { apiKey: 'opaque-secret-value' })

    config.deleteCustomTool('custom-sample')

    const stored = config.getChatToolsConfig()
    expect(stored.customTools).toHaveLength(0)
    expect(stored.toolStates['custom-sample']).toBeUndefined()
    expect(stored.toolCredentials['custom-sample']).toBeUndefined()
  })
})
