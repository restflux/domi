import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentSessionManager = typeof import('../agent-session-manager')

let manager: AgentSessionManager
let tempHome: string
const originalHome = process.env.HOME

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

const line = (uuid: string, text: string): string => JSON.stringify({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } })
const resultLine = (sessionId: string): string => JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, usage: { input_tokens: 1 } })
const systemLine = (sessionId: string): string => JSON.stringify({ type: 'system', subtype: 'worktree_ready_for_review', session_id: sessionId })

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'domi-side-chat-prune-'))
  process.env.HOME = tempHome
  manager = await import('../agent-session-manager')
})

afterAll(() => {
  process.env.HOME = originalHome
  rmSync(tempHome, { recursive: true, force: true })
})

test('纯函数：剔除与父 uuid 重合的行并保留自身消息，幂等且容错非 JSON 行', () => {
  const parentUuids = new Set(['p1', 'p2'])
  const childContent = [line('p1', '父历史消息一'), line('own1', '侧聊自己的问题'), line('p2', '父历史消息二'), line('own2', '侧聊自己的追问')].join('\n') + '\n'
  const first = manager.filterInheritedDisplayLines(childContent, parentUuids)
  expect(first.removed).toBe(2)
  expect(first.content).toBe(`${line('own1', '侧聊自己的问题')}\n${line('own2', '侧聊自己的追问')}\n`)
  const second = manager.filterInheritedDisplayLines(first.content, parentUuids)
  expect(second.removed).toBe(0)
  expect(second.content).toBe(first.content)
  const malformed = `${line('p1', '父')}\nnot-json\n${JSON.stringify({ type: 'system' })}\n`
  const third = manager.filterInheritedDisplayLines(malformed, parentUuids)
  expect(third.removed).toBe(1)
  expect(third.content).toBe(`not-json\n${JSON.stringify({ type: 'system' })}\n`)
  expect(manager.filterInheritedDisplayLines(`${line('p1', 'a')}\n${line('p2', 'b')}\n`, parentUuids).content).toBe('')
  expect(manager.filterInheritedDisplayLines(childContent, new Set())).toEqual({ content: childContent, removed: 0 })
})

test('纯函数：无 uuid 的父残留（result/system）按 session_id 剔除，子会话自身记录保留', () => {
  const parentUuids = new Set(['p1'])
  const parentIds = new Set(['parent-agent-id', 'parent-sdk-id'])
  const childContent = [
    resultLine('parent-sdk-id'),
    line('own1', '侧聊自己的问题'),
    systemLine('parent-agent-id'),
    resultLine('child-sdk-id'),
    systemLine('child-agent-id'),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n') + '\n'
  const first = manager.filterInheritedDisplayLines(childContent, parentUuids, parentIds)
  expect(first.removed).toBe(2)
  expect(first.content).toBe([
    line('own1', '侧聊自己的问题'),
    resultLine('child-sdk-id'),
    systemLine('child-agent-id'),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n') + '\n')
  // 幂等。
  const second = manager.filterInheritedDisplayLines(first.content, parentUuids, parentIds)
  expect(second.removed).toBe(0)
  expect(second.content).toBe(first.content)
  // 仅 uuid 规则时（父 meta 缺失）：无 uuid 行不动。
  const uuidOnly = manager.filterInheritedDisplayLines(childContent, parentUuids, new Set())
  expect(uuidOnly.removed).toBe(0)
})

test('IO：重写旧子会话 JSONL 仅保留自身消息；重复执行不再改动', async () => {
  const sessionsDir = join(tempHome, '.domi', 'agent-sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(tempHome, '.domi', 'agent-sessions.json'), JSON.stringify({ version: 2, sessions: [{
    id: 'parent', title: '父', createdAt: 1, updatedAt: 1, sdkSessionId: 'parent-sdk-id',
  }] }), 'utf-8')
  writeFileSync(join(sessionsDir, 'parent.jsonl'), `${line('p1', '父一')}\n${line('p2', '父二')}\n${resultLine('parent-sdk-id')}\n`, 'utf-8')
  writeFileSync(join(sessionsDir, 'child-old.jsonl'), `${line('p1', '父一')}\n${resultLine('parent-sdk-id')}\n${systemLine('parent')}\n${line('own1', '侧聊问题')}\n`, 'utf-8')
  const removed = manager.pruneSideChatInheritedDisplayHistory('child-old', 'parent')
  expect(removed).toBe(3)
  const fs = await import('node:fs')
  expect(fs.readFileSync(join(sessionsDir, 'child-old.jsonl'), 'utf-8')).toBe(`${line('own1', '侧聊问题')}\n`)
  expect(manager.pruneSideChatInheritedDisplayHistory('child-old', 'parent')).toBe(0)
  // 会话文件缺失时安全返回。
  expect(manager.pruneSideChatInheritedDisplayHistory('missing-child', 'parent')).toBe(0)
  expect(manager.pruneSideChatInheritedDisplayHistory('child-old', 'missing-parent')).toBe(0)
})
