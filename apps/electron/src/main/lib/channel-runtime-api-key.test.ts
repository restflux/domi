import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { serializeCodexCredentials } from '@domi/shared'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalDomiDev = process.env.DOMI_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeChannels(channels: unknown[]): void {
  const configDir = join(tempHome, '.domi')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'channels.json'),
    JSON.stringify({ version: 2, channels }),
    'utf-8',
  )
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'domi-channel-runtime-key-'))
  process.env.HOME = tempHome
  process.env.DOMI_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.domi'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalDomiDev === undefined) {
    delete process.env.DOMI_DEV
  } else {
    process.env.DOMI_DEV = originalDomiDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('渠道运行时认证解析', () => {
  test('Given ChatGPT OAuth 渠道 When 解析运行时 key Then 返回 access token 而不是凭据 JSON', async () => {
    writeChannels([
      {
        id: 'codex-channel',
        name: 'ChatGPT',
        provider: 'openai-codex',
        baseUrl: '',
        apiKey: serializeCodexCredentials({
          access: 'oauth-access-token',
          refresh: 'oauth-refresh-token',
          expires: Date.now() + 3_600_000,
        }),
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('codex-channel'))
      .resolves.toBe('oauth-access-token')
  })

  test('Given 凭据自动刷新或手动替换 When 更新渠道 Then 只在手动替换时轮换 credentialVersion', () => {
    writeChannels([
      {
        id: 'codex-channel', name: 'ChatGPT', provider: 'openai-codex', baseUrl: '',
        apiKey: serializeCodexCredentials({ access: 'old-access', refresh: 'refresh', expires: Date.now() + 3_600_000, accountId: 'account-1' }),
        models: [], enabled: true, createdAt: 1, updatedAt: 1,
      },
    ])
    const migrated = channelManager.getChannelById('codex-channel')
    expect(migrated?.credentialVersion).toBeTruthy()

    channelManager.persistCodexOAuthCredentials('codex-channel', {
      access: 'new-access', refresh: 'refresh', expires: Date.now() + 7_200_000, accountId: 'account-1',
    })
    expect(channelManager.getChannelById('codex-channel')?.credentialVersion).toBe(migrated?.credentialVersion)

    channelManager.updateChannel('codex-channel', { apiKey: serializeCodexCredentials({ access: 'other', refresh: 'other-refresh', expires: Date.now() + 3_600_000, accountId: 'account-2' }) })
    expect(channelManager.getChannelById('codex-channel')?.credentialVersion).not.toBe(migrated?.credentialVersion)
  })

  test('Given 普通渠道 When 解析运行时 key Then 返回解密后的 API Key', async () => {
    writeChannels([
      {
        id: 'api-key-channel',
        name: 'Anthropic',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'plain-api-key',
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('api-key-channel'))
      .resolves.toBe('plain-api-key')
  })
})
