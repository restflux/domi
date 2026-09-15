import { expect, test } from 'bun:test'
import ts from 'typescript'
import type { AgentSendInput } from '@domi/shared'
import { claimSideChatLaunch, registerSideChatLaunch } from './policy'

// 执行生产类的完整 sendMessage 方法，不复制授权逻辑、不 mock claim。
// 仅剥离模块依赖与构造副作用，在进入后续 Worktree 准备时停止；不是 Provider/GUI 集成测试。
const source = ts.createSourceFile('agent-orchestrator.ts', await Bun.file(new URL('../agent-orchestrator.ts', import.meta.url)).text(), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'AgentOrchestrator')
if (!declaration) throw new Error('缺少 AgentOrchestrator 生产入口')
const classSource = declaration.getText(source).replace(/^export /, '')
const compiled = ts.transpileModule(classSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
interface Callbacks { onError(message: string): void; onComplete(value: { startedAt: number }): void }
interface Entry { sendMessage(input: AgentSendInput, callbacks: Callbacks): Promise<void> }
interface EntryClass { prototype: Entry }
const admitted = new Error('已通过入口授权，停止于 Worktree 准备边界')
function harness(parent: string | undefined = 'parent', capturePersistedInput = false) {
  let resolutions = 0
  let persistedSelection: AgentSendInput['imageGeneration']
  const defaultSelection: NonNullable<AgentSendInput['imageGeneration']> = { channelId: 'image-channel', modelId: 'image-model' }
  const errors: string[] = []
  let completed = 0
  const create = new Function('claimSideChatLaunch', 'getAgentSessionMeta', 'resolveRequestImageGeneration', 'normalizeAgentNextTurnAsides', 'worktreeContinuationAuthorizationRegistry', `${compiled}\nreturn AgentOrchestrator;`) as (...dependencies: unknown[]) => EntryClass
  const Class = create(claimSideChatLaunch, () => ({ sideChatParentSessionId: parent || undefined }), (selection: AgentSendInput['imageGeneration']) => { resolutions++; return selection ?? defaultSelection }, () => [], {
    isConfirmationInProgress: () => { if (!capturePersistedInput) throw admitted; return false },
    noteSessionActivity: () => {}, clearSession: () => {},
  })
  const entry: Entry = Object.assign(Object.create(Class.prototype), {
    rewindSessions: new Set(), activeSessions: new Set(['child']),
    persistUserMessage: (_id: string, _text: string, _started: number, _asides: unknown, _uuid: string | undefined, selection: AgentSendInput['imageGeneration']) => { persistedSelection = selection },
  })
  const callbacks: Callbacks = { onError: message => errors.push(message), onComplete: () => { completed++ } }
  return { send: (input: AgentSendInput) => entry.sendMessage(input, callbacks), errors, resolutions: () => resolutions, completed: () => completed, selection: () => persistedSelection, defaultSelection }
}
function request(): AgentSendInput { return { sessionId: 'child', channelId: 'chat-channel', userMessage: '解释这段内容', startedAt: 1 } }

test('Given 宿主登记的侧聊文字请求 When 进入真实编排入口 Then 原始身份通过且不读取生图默认', async () => {
  const h = harness()
  const input = request()
  const release = registerSideChatLaunch('child', 'parent', input)
  try {
    await expect(h.send(input)).rejects.toBe(admitted)
    expect(h.errors).toEqual([])
    expect(h.resolutions()).toBe(0)
    expect(claimSideChatLaunch('child', 'parent', input)).toBe(false)
  } finally { release() }
})

for (const variant of ['复制对象', '错误父会话', '未登记'] as const) {
  test(`Given ${variant} When 请求侧聊 Then 拒绝且不解析生图配置`, async () => {
    const h = harness(variant === '错误父会话' ? 'other-parent' : 'parent')
    const input = request()
    const release = variant === '未登记' ? () => {} : registerSideChatLaunch('child', 'parent', input)
    try {
      await h.send(variant === '复制对象' ? { ...input } : input)
      expect(h.errors).toEqual(['侧聊只能由所属主会话的侧聊入口发送消息。'])
      expect(h.completed()).toBe(1)
      expect(h.resolutions()).toBe(0)
      if (variant !== '未登记') expect(claimSideChatLaunch('child', 'parent', input)).toBe(true)
    } finally { release() }
  })
}

test('Given 图片附件引用 When 进入编排并重复发送 Then 首次通过而重放被拒绝', async () => {
  const h = harness()
  const input = { ...request(), userMessage: '<attached_files>\n- 图.png: C:/child/图.png\n</attached_files>' }
  const release = registerSideChatLaunch('child', 'parent', input)
  try {
    await expect(h.send(input)).rejects.toBe(admitted)
    await h.send(input)
    expect(h.errors).toEqual(['侧聊只能由所属主会话的侧聊入口发送消息。'])
    expect(h.resolutions()).toBe(0)
  } finally { release() }
})

test('Given 侧聊请求带生图配置 When 授权后正规化 Then 持久化输入剥离生图选择但不修改原始请求', async () => {
  const h = harness('parent', true)
  const input = { ...request(), imageGeneration: h.defaultSelection }
  const release = registerSideChatLaunch('child', 'parent', input)
  try {
    await h.send(input)
    expect(h.errors).toEqual(['上一条消息仍在处理中，请稍候再试'])
    expect(h.selection()).toBeUndefined()
    expect(h.resolutions()).toBe(0)
    expect(input.imageGeneration).toBe(h.defaultSelection)
  } finally { release() }
})

for (const explicit of [false, true]) {
  test(`Given 普通 Work ${explicit ? '显式' : '默认'}生图选择 When 正规化 Then 原选择规则保持`, async () => {
    const h = harness('', true)
    const selection = { channelId: 'chosen-channel', modelId: 'chosen-model' }
    await h.send({ ...request(), ...(explicit ? { imageGeneration: selection } : {}) })
    expect(h.errors).toEqual(['上一条消息仍在处理中，请稍候再试'])
    expect(h.resolutions()).toBe(1)
    expect(h.selection()).toBe(explicit ? selection : h.defaultSelection)
  })
}

test('Given 宿主 continuation When 进入编排 Then 不补入用户生图默认', async () => {
  const h = harness('', true)
  await h.send({ ...request(), worktreeContinuationAuthorizationToken: 'host-token' })
  expect(h.errors).toEqual(['上一条消息仍在处理中，请稍候再试'])
  expect(h.resolutions()).toBe(0)
  expect(h.selection()).toBeUndefined()
})
