import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentSessionManager = typeof import('./agent-session-manager')
type AgentSessionContextPrompt = typeof import('./agent-session-context-prompt')

let manager: AgentSessionManager
let contextPrompt: AgentSessionContextPrompt
let tempHome: string
const originalHome = process.env.HOME
const originalDomiDev = process.env.DOMI_DEV
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function jsonl(rows: string[]): string {
  return rows.join('\n') + '\n'
}

function writeAgentSessionJsonl(sessionId: string, rows: string[]): void {
  const dir = join(tempHome, '.domi', 'agent-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(rows), 'utf-8')
}

function writeAgentSessionsIndex(sessions: Array<{
  id: string
  title: string
  workspaceId: string
  agentRuntime?: 'pi' | 'claude'
  permissionMode?: string
  executionPolicy?: string
  workflow?: string
  piToolProfile?: 'full' | 'noBash' | 'readOnly'
  sessionTarget?: { kind: 'unselected' | 'local' }
  createdAt: number
  updatedAt: number
}>, version = 2): void {
  const dir = join(tempHome, '.domi')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version, sessions }), 'utf-8')
}

function writeAgentWorkspacesIndex(workspaces: Array<{
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
}>): void {
  const dir = join(tempHome, '.domi')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-workspaces.json'), JSON.stringify({ version: 2, workspaces }), 'utf-8')
}

function createIndexedSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `会话 ${index}`,
    workspaceId: 'workspace-a',
    createdAt: index,
    updatedAt: index,
  }))
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'domi-agent-session-manager-'))
  process.env.HOME = tempHome
  process.env.DOMI_DEV = '0'
  delete process.env.CLAUDE_CONFIG_DIR
  manager = await import('./agent-session-manager')
  contextPrompt = await import('./agent-session-context-prompt')
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
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }
  manager?.setReleasePiSessionLifecycleForTesting(undefined)
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
})

describe('Agent 会话 JSONL 读取', () => {
  test('Given 会话 JSONL 混入损坏行 When 读取 SDKMessage Then 跳过坏行并保留其它消息', () => {
    writeAgentSessionJsonl('session-with-bad-line', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null }),
      '{ 这不是合法 JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '仍然可读' }] }, parent_tool_use_id: null }),
    ])

    const messages = manager.getAgentSessionSDKMessages('session-with-bad-line')

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  test('Given a valid rewind target When transcript truncation is prepared Then commit and rollback are reversible', () => {
    writeAgentSessionJsonl('session-transactional-truncate', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: 'two' }] } }),
    ])
    const filePath = join(tempHome, '.domi', 'agent-sessions', 'session-transactional-truncate.jsonl')
    const original = readFileSync(filePath, 'utf8')

    const prepared = manager.prepareSDKMessageTruncation('session-transactional-truncate', 'assistant-1')
    expect(readFileSync(filePath, 'utf8')).toBe(original)
    prepared.commit()
    expect(manager.getAgentSessionSDKMessagesRaw('session-transactional-truncate')).toHaveLength(2)
    prepared.rollback()
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })

  test('Given a committed transcript rewind When restore is prepared from the trusted original Then commit and rollback are reversible', () => {
    writeAgentSessionJsonl('session-transactional-restore', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: 'two' }] } }),
    ])
    const filePath = join(tempHome, '.domi', 'agent-sessions', 'session-transactional-restore.jsonl')
    const original = readFileSync(filePath, 'utf8')
    const rewind = manager.prepareSDKMessageTruncation('session-transactional-restore', 'assistant-1')
    expect(rewind.originalContent).toBe(original)
    rewind.commit()
    const rewound = readFileSync(filePath, 'utf8')

    const restore = manager.prepareSDKMessageRestore('session-transactional-restore', original)
    restore.commit()
    expect(readFileSync(filePath, 'utf8')).toBe(original)
    restore.rollback()
    expect(readFileSync(filePath, 'utf8')).toBe(rewound)
  })

  test('Given 会话 JSONL 存在损坏行 When 截断 SDKMessage Then 抛错避免重写不完整历史', () => {
    writeAgentSessionJsonl('session-truncate-bad-line', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      '{ 这不是合法 JSON',
    ])

    expect(() => manager.truncateSDKMessages('session-truncate-bad-line', 'assistant-1'))
      .toThrow('JSONL 第 2 行解析失败')
  })
})

describe('Agent 会话 runtime 元数据', () => {
  test('Given rewound Pi metadata When a restore is prepared Then commit returns to source and rollback returns to the rewind branch', () => {
    const session = manager.createAgentSession('Pi rewind metadata restore')
    const piDir = join(tempHome, '.domi', 'sdk-config', 'sessions')
    mkdirSync(piDir, { recursive: true })
    const sourceFile = join(piDir, 'source.jsonl')
    const rewoundFile = join(piDir, 'rewound.jsonl')
    writeFileSync(sourceFile, '{}\n')
    writeFileSync(rewoundFile, '{}\n')
    const source = {
      sdkSessionId: 'pi-source',
      piSessionFile: sourceFile,
      piEntryBindings: { 'assistant-1': 'entry-1', 'assistant-2': 'entry-2' },
      piTreeActiveLeafId: 'entry-2',
    }
    const rewound = {
      sdkSessionId: 'pi-rewound',
      piSessionFile: rewoundFile,
      piEntryBindings: { 'assistant-1': 'entry-1' },
      piTreeActiveLeafId: null,
    }
    manager.updateAgentSessionMeta(session.id, rewound)

    const restore = manager.preparePiAgentSessionRestore(session.id, source, rewound)
    restore.commit()
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject(source)
    restore.rollback()
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject(rewound)
  })

  test('Given crash recovery sees either durable Pi side When targeting the other side Then commit and rollback remain reversible', () => {
    const session = manager.createAgentSession('Pi crash recovery')
    const piDir = join(tempHome, '.domi', 'sdk-config', 'sessions')
    mkdirSync(piDir, { recursive: true })
    const sourceFile = join(piDir, 'recovery-source.jsonl')
    const rewoundFile = join(piDir, 'recovery-rewound.jsonl')
    writeFileSync(sourceFile, '{}\n')
    writeFileSync(rewoundFile, '{}\n')
    const source = { sdkSessionId: 'recovery-source', piSessionFile: sourceFile, piEntryBindings: { a: 'one' } }
    const rewound = { sdkSessionId: 'recovery-rewound', piSessionFile: rewoundFile, piEntryBindings: { a: 'one' } }
    manager.updateAgentSessionMeta(session.id, source)

    const recovery = manager.preparePiAgentSessionRecovery(session.id, rewound, source, rewound)
    recovery.commit()
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject(rewound)
    recovery.rollback()
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject(source)
  })

  test('Given a persisted undo receipt points outside the Pi session directory When restore is prepared Then it fails closed', () => {
    const session = manager.createAgentSession('Unsafe Pi rewind metadata restore')
    const piDir = join(tempHome, '.domi', 'sdk-config', 'sessions')
    mkdirSync(piDir, { recursive: true })
    const rewoundFile = join(piDir, 'safe-rewound.jsonl')
    const outsideSource = join(tempHome, 'outside-source.jsonl')
    writeFileSync(rewoundFile, '{}\n')
    writeFileSync(outsideSource, '{}\n')
    const rewound = { sdkSessionId: 'pi-rewound', piSessionFile: rewoundFile, piEntryBindings: {} }
    manager.updateAgentSessionMeta(session.id, rewound)

    expect(() => manager.preparePiAgentSessionRestore(
      session.id,
      { sdkSessionId: 'pi-source', piSessionFile: outsideSource, piEntryBindings: {} },
      rewound,
    )).toThrow('已越过 Pi session 目录')
  })

  test('Given a new Pi session When it is persisted Then execution defaults to Full Access and Direct without writing a legacy mode', () => {
    const session = manager.createAgentSession('Execution defaults')
    const persisted = manager.getAgentSessionMeta(session.id)

    expect(session.executionPolicy).toBe('full-access')
    expect(session.workflow).toBe('direct')
    expect(session.permissionMode).toBeUndefined()
    expect(persisted?.executionPolicy).toBe('full-access')
    expect(persisted?.workflow).toBe('direct')
    expect(persisted?.sessionTarget).toEqual({ kind: 'unselected' })
  })

  test('Given the last actively selected policy and workflow When a new Pi session is created Then it inherits both defaults', () => {
    const settingsPath = join(tempHome, '.domi', 'settings.json')
    mkdirSync(join(tempHome, '.domi'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({
      agentExecutionPolicy: 'full-access',
      agentWorkflow: 'read-only',
    }), 'utf-8')

    try {
      const session = manager.createAgentSession('Remembered execution controls')

      expect(session.executionPolicy).toBe('full-access')
      expect(session.workflow).toBe('read-only')
      expect(manager.getAgentSessionMeta(session.id)).toMatchObject({
        executionPolicy: 'full-access',
        workflow: 'read-only',
      })
    } finally {
      rmSync(settingsPath, { force: true })
    }
  })

  test('Given a legacy Plan First setting When sessions are created Then it normalizes to Read Only without changing the stored default', () => {
    const settingsPath = join(tempHome, '.domi', 'settings.json')
    mkdirSync(join(tempHome, '.domi'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ agentWorkflow: 'plan-first' }), 'utf-8')

    try {
      const approvedSession = manager.createAgentSession('Plan lifecycle')
      expect(approvedSession.workflow).toBe('read-only')
      manager.updateAgentSessionMeta(approvedSession.id, { workflow: 'direct' })

      const nextSession = manager.createAgentSession('Still uses active default')
      expect(manager.getAgentSessionMeta(approvedSession.id)?.workflow).toBe('direct')
      expect(nextSession.workflow).toBe('read-only')
    } finally {
      rmSync(settingsPath, { force: true })
    }
  })

  test('Given 新建 Pi 会话 When 持久化 Then 等待显式选择 Session Target', () => {
    const session = manager.createAgentSession('Pi session')

    expect(session.sessionTarget).toEqual({ kind: 'unselected' })
    expect(manager.getAgentSessionMeta(session.id)?.sessionTarget).toEqual({ kind: 'unselected' })
  })

  test('Given 历史会话缺少 Session Target When 读取 Then 保持缺字段以便 production 按 Local 兼容', () => {
    writeAgentSessionsIndex([{
      id: 'historical-local',
      title: 'Historical local',
      workspaceId: 'workspace-a',
      agentRuntime: 'pi',
      createdAt: 1,
      updatedAt: 1,
    }])

    expect(manager.getAgentSessionMeta('historical-local')?.sessionTarget).toBeUndefined()
    const persisted = JSON.parse(readFileSync(join(tempHome, '.domi', 'agent-sessions.json'), 'utf-8')) as { sessions: Array<Record<string, unknown>> }
    expect(persisted.sessions[0]).not.toHaveProperty('agentRuntime')
  })

  test('Given a pre-cut index with explicit Pi runtime When read Then runtime is removed and schema advances to v2', () => {
    writeAgentSessionsIndex([{
      id: 'pre-cut-pi',
      title: 'Pre-cut Pi',
      workspaceId: 'workspace-a',
      agentRuntime: 'pi',
      createdAt: 1,
      updatedAt: 1,
    }], 1)

    expect(manager.getAgentSessionMeta('pre-cut-pi')?.id).toBe('pre-cut-pi')
    const persisted = JSON.parse(readFileSync(join(tempHome, '.domi', 'agent-sessions.json'), 'utf-8')) as {
      version: number
      sessions: Array<Record<string, unknown>>
    }
    expect(persisted.version).toBe(2)
    expect(persisted.sessions[0]).not.toHaveProperty('agentRuntime')
  })

  test('Given an interrupted Pi-only migration removed runtime but retained Pi execution controls When read Then recovery advances the index to v2', () => {
    writeAgentSessionsIndex([{
      id: 'interrupted-pi-migration',
      title: 'Interrupted Pi migration',
      workspaceId: 'workspace-a',
      executionPolicy: 'full-access',
      workflow: 'direct',
      createdAt: 1,
      updatedAt: 1,
    }], 1)

    expect(manager.getAgentSessionMeta('interrupted-pi-migration')?.id).toBe('interrupted-pi-migration')
    const persisted = JSON.parse(readFileSync(join(tempHome, '.domi', 'agent-sessions.json'), 'utf-8')) as {
      version: number
      sessions: Array<Record<string, unknown>>
    }
    expect(persisted.version).toBe(2)
    expect(persisted.sessions[0]).not.toHaveProperty('agentRuntime')
  })

  test('Given an ambiguous pre-cut index with missing runtime When read Then old Claude default is rejected explicitly', () => {
    writeAgentSessionsIndex([{
      id: 'pre-cut-missing',
      title: 'Pre-cut missing runtime',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
    }], 1)

    expect(() => manager.getAgentSessionMeta('pre-cut-missing'))
      .toThrow('不支持的旧 Agent runtime: 缺失（旧版默认 Claude）')
  })

  test('Given a Pi session with legacy bypassPermissions When its index is read Then Full Access is persisted while the legacy field remains readable', () => {
    writeAgentSessionsIndex([{
      id: 'legacy-bypass',
      title: 'Legacy bypass',
      workspaceId: 'workspace-a',
      agentRuntime: 'pi',
      permissionMode: 'bypassPermissions',
      createdAt: 1,
      updatedAt: 1,
    }])

    const migrated = manager.getAgentSessionMeta('legacy-bypass')
    const persisted = JSON.parse(readFileSync(join(tempHome, '.domi', 'agent-sessions.json'), 'utf-8')) as {
      sessions: Array<Record<string, unknown>>
    }

    expect(migrated?.executionPolicy).toBe('full-access')
    expect(migrated?.workflow).toBe('direct')
    expect(migrated?.permissionMode).toBe('bypassPermissions')
    expect(persisted.sessions[0]?.permissionMode).toBe('bypassPermissions')
    expect(persisted.sessions[0]?.executionPolicy).toBe('full-access')
  })

  test('Given 已保存 OpenAI medium 默认值 When 新建 Pi 会话 Then 默认并持久化 medium', () => {
    const settingsPath = join(tempHome, '.domi', 'settings.json')
    mkdirSync(join(tempHome, '.domi'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'max',
      defaultOpenAIThinkingLevel: 'medium',
    }), 'utf-8')

    try {
      const firstSession = manager.createAgentSession('默认内核会话')
      const secondSession = manager.createAgentSession('第二个 Pi 会话')

      expect(firstSession.reasoningLevel).toBe('medium')
      expect(secondSession.reasoningLevel).toBe('medium')
      expect(manager.getAgentSessionMeta(firstSession.id)?.reasoningLevel).toBe('medium')
      expect(manager.getAgentSessionMeta(secondSession.id)?.reasoningLevel).toBe('medium')
    } finally {
      rmSync(settingsPath, { force: true })
    }
  })

  test('Given 新安装用户保存关闭思考 When 连续新建会话 Then 不被旧版迁移改回 high', () => {
    const settingsPath = join(tempHome, '.domi', 'settings.json')
    const indexPath = join(tempHome, '.domi', 'agent-sessions.json')
    const indexBackupPath = `${indexPath}.bak`
    mkdirSync(join(tempHome, '.domi'), { recursive: true })
    rmSync(indexPath, { force: true })
    rmSync(indexBackupPath, { force: true })
    writeFileSync(settingsPath, JSON.stringify({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'medium',
      defaultOpenAIThinkingLevel: 'off',
    }), 'utf-8')

    try {
      const firstSession = manager.createAgentSession('关闭思考会话一')
      const secondSession = manager.createAgentSession('关闭思考会话二')

      expect(manager.getAgentSessionMeta(firstSession.id)?.reasoningLevel).toBe('off')
      expect(manager.getAgentSessionMeta(secondSession.id)?.reasoningLevel).toBe('off')
    } finally {
      rmSync(settingsPath, { force: true })
      rmSync(indexPath, { force: true })
      rmSync(indexBackupPath, { force: true })
    }
  })

  test('Given session settings When updating Then persists reasoning depth per session', () => {
    const session = manager.createAgentSession('Codex 会话')

    const updated = manager.updateAgentSessionMeta(session.id, { reasoningLevel: 'xhigh' })

    expect(updated.reasoningLevel).toBe('xhigh')
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ reasoningLevel: 'xhigh' })
  })

  test('Given historical Pi tool profiles When the index is read Then they migrate once into supported workflows and the legacy field is removed', () => {
    writeAgentSessionsIndex([
      {
        id: 'legacy-read-only',
        title: 'Legacy read only',
        workspaceId: 'workspace-a',
        agentRuntime: 'pi',
        piToolProfile: 'readOnly',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'legacy-no-bash',
        title: 'Legacy no bash',
        workspaceId: 'workspace-a',
        agentRuntime: 'pi',
        workflow: 'plan-first',
        piToolProfile: 'noBash',
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'legacy-full',
        title: 'Legacy full',
        workspaceId: 'workspace-a',
        agentRuntime: 'pi',
        workflow: 'plan-first',
        piToolProfile: 'full',
        createdAt: 3,
        updatedAt: 3,
      },
    ])

    expect(manager.getAgentSessionMeta('legacy-read-only')).toMatchObject({ workflow: 'read-only' })
    expect(manager.getAgentSessionMeta('legacy-no-bash')).toMatchObject({ workflow: 'direct' })
    expect(manager.getAgentSessionMeta('legacy-full')).toMatchObject({ workflow: 'read-only' })

    const persisted = JSON.parse(readFileSync(join(tempHome, '.domi', 'agent-sessions.json'), 'utf-8')) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(persisted.sessions.every((session) => session.piToolProfile === undefined)).toBe(true)
  })

  test('Given a session When star state is updated Then it persists without changing freshness or archive state', () => {
    const session = manager.createAgentSession('星标会话')
    const archived = manager.updateAgentSessionMeta(session.id, { archived: true })

    const updated = manager.updateAgentSessionMeta(session.id, { starred: true })

    expect(updated).toMatchObject({ starred: true, archived: true })
    expect(updated.updatedAt).toBe(archived.updatedAt)
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ starred: true, archived: true })
  })

  test('Given a session When follow-up state is updated Then it persists without changing freshness or archive state', () => {
    const session = manager.createAgentSession('待继续会话')
    const archived = manager.updateAgentSessionMeta(session.id, { archived: true })

    const updated = manager.updateAgentSessionMeta(session.id, { needsFollowUp: true })

    expect(updated).toMatchObject({ needsFollowUp: true, archived: true })
    expect(updated.updatedAt).toBe(archived.updatedAt)
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ needsFollowUp: true, archived: true })
  })
})

describe('Agent 会话引用搜索', () => {
  test('Given 工作区有超过 20 个会话 When 请求最近 200 条 Then 按更新时间返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 200,
    })

    expect(results).toHaveLength(200)
    expect(results[0]?.sessionId).toBe('session-219')
    expect(results.at(-1)?.sessionId).toBe('session-20')
    expect(results.every((result) => result.matchSource === 'recent')).toBe(true)
  })

  test('Given 请求数量超过性能上限 When 搜索可引用会话 Then 最多返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 500,
    })

    expect(results).toHaveLength(200)
  })

  test('Given 未指定工作区 When 搜索可引用会话 Then 返回全部工作区的最近会话并标示来源', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '产品研发', slug: 'product-dev', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 2, updatedAt: 2 },
      { id: 'workspace-c', name: '当前项目', slug: 'current-project', createdAt: 3, updatedAt: 3 },
    ])
    writeAgentSessionsIndex([
      { id: 'workspace-a-session', title: '同名会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b-session', title: '同名会话', workspaceId: 'workspace-b', createdAt: 2, updatedAt: 2 },
      { id: 'current-session', title: '当前会话', workspaceId: 'workspace-c', createdAt: 3, updatedAt: 3 },
    ])

    const results = await manager.searchAgentSessionReferences({
      excludeSessionId: 'current-session',
      limit: 200,
    })

    expect(results).toMatchObject([
      { sessionId: 'workspace-b-session', workspaceName: '客户支持', workspaceSlug: 'customer-support' },
      { sessionId: 'workspace-a-session', workspaceName: '产品研发', workspaceSlug: 'product-dev' },
    ])
  })

  test('Given 消息内容命中 When 搜索可引用会话 Then 异步返回匹配片段和工作区来源', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([
      { id: 'message-session', title: '项目讨论', workspaceId: 'workspace-b', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('message-session', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '需要核对跨工作区的会话引用。' }] } }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '跨工作区' })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      sessionId: 'message-session',
      workspaceName: '客户支持',
      workspaceSlug: 'customer-support',
      matchSource: 'message',
      snippet: expect.stringContaining('跨工作区'),
    })
  })

  test('Given 正文扫描预算耗尽 When 较旧会话标题命中 Then 仍返回标题命中结果', async () => {
    const scannedSessions = Array.from({ length: 50 }, (_, index) => ({
      id: `body-scan-${index}`,
      title: `普通会话 ${index}`,
      workspaceId: 'workspace-a',
      createdAt: 100 - index,
      updatedAt: 100 - index,
    }))
    writeAgentSessionsIndex([
      ...scannedSessions,
      { id: 'older-title-match', title: '目标会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    for (const session of scannedSessions) {
      writeAgentSessionJsonl(session.id, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '没有匹配内容' }] } }),
      ])
    }

    const results = await manager.searchAgentSessionReferences({ query: '目标' })

    expect(results).toMatchObject([{ sessionId: 'older-title-match', matchSource: 'title' }])
  })

  test('Given 正文命中在单文件扫描上限之后 When 搜索引用 Then 不读取超出输入补全预算的历史', async () => {
    writeAgentSessionsIndex([
      { id: 'oversized-session', title: '大历史', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('oversized-session', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: `${'x'.repeat(300 * 1024)}隐藏关键词` }] },
      }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '隐藏关键词' })

    expect(results).toEqual([])
  })

  test('Given one SDK batch contains an unserializable message When appending Then no partial JSONL rows are persisted', () => {
    const session = manager.createAgentSession('Batch append', undefined, 'workspace-a')
    const circular: Record<string, unknown> = { type: 'assistant' }
    circular.self = circular

    expect(() => manager.appendSDKMessages(session.id, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first row' }] } } as never,
      circular as never,
    ])).toThrow()

    expect(existsSync(join(tempHome, '.domi', 'agent-sessions', `${session.id}.jsonl`))).toBe(false)
  })

  test('Given external index content changes with restored mtime and size When ctime advances Then cached data is invalidated', async () => {
    const indexPath = join(tempHome, '.domi', 'agent-sessions.json')
    const first = [{ id: 'cache-old', title: 'Old title', workspaceId: 'workspace-a', agentRuntime: 'pi' as const, workflow: 'direct' as const, createdAt: 1, updatedAt: 1 }]
    const second = [{ id: 'cache-new', title: 'New title', workspaceId: 'workspace-a', agentRuntime: 'pi' as const, workflow: 'direct' as const, createdAt: 1, updatedAt: 1 }]
    writeFileSync(indexPath, JSON.stringify({ sessions: first }), 'utf-8')

    expect(manager.listAgentSessions().map((session) => session.id)).toEqual(['cache-old'])
    const migratedRevision = statSync(indexPath)
    const normalizedSeconds = Math.floor(migratedRevision.mtimeMs) / 1000
    utimesSync(indexPath, normalizedSeconds, normalizedSeconds)
    expect(manager.listAgentSessions().map((session) => session.id)).toEqual(['cache-old'])

    const persisted = readFileSync(indexPath, 'utf-8')
    const replacement = persisted.replace('cache-old', 'cache-new').replace('Old title', 'New title')
    expect(replacement.length).toBe(persisted.length)
    const revision = statSync(indexPath)
    await Bun.sleep(10)
    writeFileSync(indexPath, replacement, 'utf-8')
    utimesSync(indexPath, revision.atime, revision.mtime)

    expect(manager.listAgentSessions().map((session) => session.id)).toEqual(['cache-new'])

    writeFileSync(indexPath, JSON.stringify({ sessions: [{ ...second[0]!, title: 'Changed size title' }] }), 'utf-8')
    expect(manager.listAgentSessions().map((session) => session.id)).toEqual(['cache-new'])
  })
})

function installCheckoutLifecycle(
  releaseSession: (sessionId: string, intent: 'delete' | 'move') => Promise<void>,
): void {
  manager.setReleasePiSessionLifecycleForTesting(releaseSession)
}

describe('Fork Session Target 输入边界', () => {
  test('Given IPC 传入未知 target kind When fork Then 在读取源会话前 fail closed', async () => {
    await expect(manager.forkAgentSession({
      sessionId: 'missing-session',
      target: { kind: 'unexpected' },
    } as never)).rejects.toThrow('无效的 Fork Session Target')
  })

  test('Given isolated target 缺少 dirty 确认布尔值 When fork Then fail closed', async () => {
    await expect(manager.forkAgentSession({
      sessionId: 'missing-session',
      target: { kind: 'isolated' },
    } as never)).rejects.toThrow('无效的 Fork Session Target')
  })

  test('Given local target passes input validation When source is missing Then fork reaches the source lookup boundary', async () => {
    await expect(manager.forkAgentSession({
      sessionId: 'missing-session',
      upToMessageUuid: 'assistant-1',
      target: { kind: 'local' },
    })).rejects.toThrow('源 Agent 会话不存在')
  })

  test('Given isolated-copy target passes input validation When source is missing Then fork reaches the source lookup boundary', async () => {
    await expect(manager.forkAgentSession({
      sessionId: 'missing-session',
      upToMessageUuid: 'assistant-1',
      target: { kind: 'isolated-copy' },
    })).rejects.toThrow('源 Agent 会话不存在')
  })

  test('Given Pi SDK session or artifact is unavailable When fork starts Then it exposes a stable degradable reason', async () => {
    const noSdk = manager.createAgentSession('No SDK')
    await expect(manager.forkAgentSession({
      sessionId: noSdk.id, upToMessageUuid: 'assistant-1', target: { kind: 'inherit' },
    })).rejects.toMatchObject({ code: 'pi_fork_unavailable', reason: 'sdk_session_missing' })

    const missingArtifact = manager.createAgentSession('Missing artifact')
    manager.updateAgentSessionMeta(missingArtifact.id, {
      sdkSessionId: 'sdk-session',
      piSessionFile: join(tempHome, '.domi', 'sdk-config', 'sessions', 'missing.jsonl'),
      piEntryBindings: { 'assistant-1': 'pi-entry-1' },
    })
    await expect(manager.forkAgentSession({
      sessionId: missingArtifact.id, upToMessageUuid: 'assistant-1', target: { kind: 'inherit' },
    })).rejects.toMatchObject({ code: 'pi_fork_unavailable', reason: 'session_artifact_missing' })
  })

})

describe('Agent session checkout lifecycle integration', () => {
  test('Given a bound Pi session When project move is requested Then metadata remains unchanged on lifecycle refusal', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: 'A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', name: 'B', slug: 'workspace-b', createdAt: 2, updatedAt: 2 },
    ])
    writeAgentSessionsIndex([{
      id: 'bound-pi', title: 'Bound Pi', workspaceId: 'workspace-a', agentRuntime: 'pi',
      sessionTarget: { kind: 'unselected' }, createdAt: 1, updatedAt: 1,
    }])
    installCheckoutLifecycle(async (_sessionId, intent) => {
      if (intent === 'move') throw Object.assign(new Error('已绑定 Local/Isolated 的 Pi 会话不能移动项目'), { code: 'target_already_bound' })
    })

    await expect(manager.moveSessionToWorkspace('bound-pi', 'workspace-b')).rejects.toMatchObject({
      code: 'target_already_bound',
    })
    expect(manager.getAgentSessionMeta('bound-pi')?.workspaceId).toBe('workspace-a')
  })

  test('Given an unselected Pi session When project move is requested Then preflight allows metadata move', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: 'A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', name: 'B', slug: 'workspace-b', createdAt: 2, updatedAt: 2 },
    ])
    writeAgentSessionsIndex([{
      id: 'draft-pi', title: 'Draft Pi', workspaceId: 'workspace-a', agentRuntime: 'pi',
      sessionTarget: { kind: 'unselected' }, createdAt: 1, updatedAt: 1,
    }])
    const intents: string[] = []
    installCheckoutLifecycle(async (_sessionId, intent) => { intents.push(intent) })

    const moved = await manager.moveSessionToWorkspace('draft-pi', 'workspace-b')

    expect(moved.workspaceId).toBe('workspace-b')
    expect(intents).toEqual(['move'])
  })

  test('Given a persisted non-Pi runtime When sessions are read Then the incompatible data is rejected explicitly', () => {
    writeAgentSessionsIndex([{
      id: 'legacy', title: 'Legacy', workspaceId: 'workspace-a', agentRuntime: 'claude',
      sessionTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1,
    }])

    expect(() => manager.getAgentSessionMeta('legacy')).toThrow('不支持的旧 Agent runtime')
  })


  test('Given a workspace has bound Pi sessions When relink or deletion is preflighted Then every Pi target is checked before workspace mutation', async () => {
    writeAgentSessionsIndex([
      {
        id: 'pi-a', title: 'Pi A', workspaceId: 'workspace-a', agentRuntime: 'pi',
        sessionTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'pi-b', title: 'Pi B', workspaceId: 'workspace-a', agentRuntime: 'pi',
        sessionTarget: { kind: 'local' }, createdAt: 2, updatedAt: 2,
      },
    ])
    const calls: string[] = []
    installCheckoutLifecycle(async (sessionId, intent) => {
      calls.push(`${sessionId}:${intent}`)
      if (intent === 'move') throw Object.assign(new Error('target fixed'), { code: 'target_already_bound' })
    })

    await expect(manager.assertAgentWorkspaceSessionLifecycle('workspace-a', 'move')).rejects.toMatchObject({
      code: 'target_already_bound',
    })
    await manager.assertAgentWorkspaceSessionLifecycle('workspace-a', 'delete')

    expect(calls).toEqual(['pi-a:move', 'pi-a:delete', 'pi-b:delete'])
    expect(manager.getAgentSessionMeta('pi-a')?.workspaceId).toBe('workspace-a')
  })

  test('Given a dirty Isolated owner When deletion lifecycle refuses Then session index and message sidecar are not partially deleted', async () => {
    writeAgentSessionsIndex([{
      id: 'dirty-owner', title: 'Dirty owner', workspaceId: 'workspace-a', agentRuntime: 'pi',
      sessionTarget: { kind: 'unselected' }, createdAt: 1, updatedAt: 1,
    }])
    writeAgentSessionJsonl('dirty-owner', [JSON.stringify({ type: 'user', message: { content: [] } })])
    installCheckoutLifecycle(async () => {
      throw Object.assign(new Error('Isolated Checkout 尚未 Discard，请先 Apply/Discard'), { code: 'operation_not_allowed' })
    })

    await expect(manager.deleteAgentSession('dirty-owner')).rejects.toMatchObject({ code: 'operation_not_allowed' })

    expect(manager.getAgentSessionMeta('dirty-owner')?.id).toBe('dirty-owner')
    expect(existsSync(join(tempHome, '.domi', 'agent-sessions', 'dirty-owner.jsonl'))).toBe(true)
  })

  test('Given a discarded Isolated owner When deletion lifecycle releases it Then session and sidecar are deleted', async () => {
    writeAgentSessionsIndex([{
      id: 'discarded-owner', title: 'Discarded owner', workspaceId: 'workspace-a', agentRuntime: 'pi',
      sessionTarget: { kind: 'unselected' }, createdAt: 1, updatedAt: 1,
    }])
    writeAgentSessionJsonl('discarded-owner', [JSON.stringify({ type: 'user', message: { content: [] } })])
    const checkpointDir = join(tempHome, '.domi', 'agent-sessions', 'file-checkpoints', 'discarded-owner')
    mkdirSync(checkpointDir, { recursive: true })
    writeFileSync(join(checkpointDir, 'manifest.json'), '{}')
    let released = false
    installCheckoutLifecycle(async () => { released = true })

    await manager.deleteAgentSession('discarded-owner')

    expect(released).toBe(true)
    expect(manager.getAgentSessionMeta('discarded-owner')).toBeUndefined()
    expect(existsSync(join(tempHome, '.domi', 'agent-sessions', 'discarded-owner.jsonl'))).toBe(false)
    expect(existsSync(checkpointDir)).toBe(false)
  })
})

describe('Agent 会话引用 prompt', () => {
  test('Given 用户显式引用跨工作区会话 When 构建发送 prompt Then 保留该会话上下文', () => {
    writeAgentSessionsIndex([
      { id: 'current-session', title: '当前工作区会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'other-workspace-session', title: '其他工作区会话', workspaceId: 'workspace-b', createdAt: 2, updatedAt: 2 },
    ])

    const processWithResourcesPath = process as NodeJS.Process & { resourcesPath?: string }
    const originalResourcesPath = processWithResourcesPath.resourcesPath
    processWithResourcesPath.resourcesPath = tempHome
    try {
      const prompt = contextPrompt.buildReferencedSessionsPrompt(
        'current-session',
        ['other-workspace-session'],
      )

      expect(prompt).toContain('id="other-workspace-session"')
      expect(prompt).toContain('title="其他工作区会话"')
      expect(prompt).not.toContain('同工作区')
    } finally {
      Object.defineProperty(processWithResourcesPath, 'resourcesPath', {
        value: originalResourcesPath,
        configurable: true,
        writable: true,
      })
    }
  })
})
