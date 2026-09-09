import { expect, test } from 'bun:test'
import type { AgentSendInput, AgentSessionMeta, SDKMessage } from '@domi/shared'
import { SideChatService, visibleParentContext, type SideChatPorts } from './service'
import { claimSideChatLaunch } from './policy'

function harness() {
  const sessions: AgentSessionMeta[] = [{ id: 'parent', title: '任务', workspaceId: 'w', channelId: 'c', modelId: 'm', createdAt: 1, updatedAt: 1 } as AgentSessionMeta]
  const runs: AgentSendInput[] = []
  const stops: string[] = []
  let finish = () => {}
  let bind: () => Promise<void> = async () => {}
  const messages = new Map<string, SDKMessage[]>()
  const ports: SideChatPorts = {
    getSession: id => sessions.find(s => s.id === id), listSessions: () => sessions,
    createChild: p => { const c = { ...p, id: 'child', channelId: undefined, modelId: undefined, parentSessionId: p.id, sideChatParentSessionId: p.id }; sessions.push(c); return c },
    updateModel: (id, channelId, modelId) => Object.assign(sessions.find(s => s.id === id)!, { channelId, modelId }),
    messages: id => messages.get(id) ?? [], bindTarget: () => bind(), validateModel: () => undefined, validateImageModel: async () => {},
    saveImages: (id, images) => images.map(image => ({ label: image.filename, path: `C:\\host\\${id}\\${image.filename}` })),
    run: input => { runs.push(input); return new Promise(resolve => { finish = resolve }) },
    stop: id => { stops.push(id) }, isActive: () => false, recordError: () => {},
  }
  return { service: new SideChatService(ports), ports, sessions, runs, stops, messages, finish: () => finish(), setBind: (fn: () => Promise<void>) => { bind = fn } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const png = { filename: '截图.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==' }

test('Given 伪装为图片的路径穿越附件 When 发送 Then 拒绝且不启动或创建子会话', async () => {
  const h = harness()
  const input = { parentSessionId: 'parent', message: '看图', images: [{ ...png, filename: '../escape.png' }] }
  await expect(h.service.sendSideChat(input)).rejects.toThrow('文件名')
  expect(h.runs).toHaveLength(0)
  expect(h.sessions).toHaveLength(1)
})

test('Given 只有图片 When 发送 Then 保存到宿主 child 并把路径交给 Read，不把 base64 混入正文', async () => {
  const h = harness()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '', images: [png] })
  try {
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.rawUserMessage).toContain('<attached_files>')
    expect(h.runs[0]!.rawUserMessage).toContain('截图.png')
    expect(h.runs[0]!.userMessage).toContain('Read')
    expect(h.runs[0]!.rawUserMessage).not.toContain(png.data)
    expect(claimSideChatLaunch('child', 'parent', { ...h.runs[0]! })).toBe(false)
    expect(claimSideChatLaunch('child', 'parent', h.runs[0]!)).toBe(true)
    expect(claimSideChatLaunch('child', 'parent', h.runs[0]!)).toBe(false)
  } finally { h.finish(); await tick() }
})

test('并发打开只创建一个持久子会话，不触发模型；新服务恢复记录不自动运行', async () => {
  const h = harness()
  const views = await Promise.all([h.service.openSideChat({ parentSessionId: 'parent' }), h.service.openSideChat({ parentSessionId: 'parent' })])
  expect(views[0]!.sessionId).toBe(views[1]!.sessionId)
  expect(h.sessions).toHaveLength(2)
  expect(h.runs).toHaveLength(0)
  expect((await new SideChatService(h.ports).getSideChat('parent'))?.isRunning).toBe(false)
})
test('发送立即返回，主侧独立；子会话串行、多轮保留模型，换模型不改父', async () => {
  const h = harness()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '问题一' })
  expect(h.runs).toHaveLength(1)
  expect(h.runs[0]!.modelId).toBe('m')
  expect(h.runs[0]!.workflowOverride).toBe('read-only')
  await expect(h.service.sendSideChat({ parentSessionId: 'parent', message: '重复' })).rejects.toThrow('正在回复')
  h.finish(); await tick()
  h.sessions[0]!.modelId = 'parent-changed'
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '问题二' })
  expect(h.runs[1]!.modelId).toBe('m')
  h.finish(); await tick()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '问题三', modelId: 'child-changed' })
  expect(h.sessions[0]!.modelId).toBe('parent-changed')
  expect(h.runs[2]!.modelId).toBe('child-changed')
  await h.service.stopSideChat('parent')
  expect(h.stops).toEqual(['child'])
  h.finish(); await tick()
})
test('目标绑定期间停止阻止后续付费启动且保留记录', async () => {
  const h = harness(); let release = () => {}
  h.setBind(() => new Promise(resolve => { release = resolve }))
  const sending = h.service.sendSideChat({ parentSessionId: 'parent', message: '问题' })
  await h.service.stopSideChat('parent'); release(); await expect(sending).rejects.toThrow('已取消')
  expect(h.runs).toHaveLength(0)
  expect(await h.service.getSideChat('parent')).not.toBeNull()
})
test('跨项目归属和侧聊再创建侧聊均被拒绝', async () => {
  const h = harness(); await h.service.openSideChat({ parentSessionId: 'parent' })
  await expect(h.service.openSideChat({ parentSessionId: 'child' })).rejects.toThrow()
  h.sessions[1]!.workspaceId = 'other'
  await expect(h.service.stopSideChat('parent')).rejects.toThrow('归属')
})
test('父背景有界，只包含可见文本，不含内部推理、工具结果或系统消息', () => {
  const context = visibleParentContext([
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'SECRET_REASONING' }, { type: 'text', text: '可见回答' }] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'SECRET_RESULT' }] } },
    { type: 'system', message: 'SECRET_SYSTEM' },
  ])
  expect(context).toContain('可见回答'); expect(context).not.toContain('SECRET')
  expect(visibleParentContext(Array.from({ length: 200 }, () => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'x'.repeat(9000) }] } })))).toHaveLength(5000)
})

test('自动背景脱敏常见凭证字段，显式引文不混入父会话历史', async () => {
  const context = visibleParentContext([{ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'api_key=TOP_SECRET password=hunter2 普通背景' }] } }])
  expect(context).not.toContain('TOP_SECRET')
  expect(context).not.toContain('hunter2')
  expect(context).toContain('普通背景')
  const h = harness()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '帮我解释', quotedText: '这段引用' })
  expect(h.runs[0]!.rawUserMessage).toContain('这段引用')
  expect(h.messages.get('parent')).toBeUndefined()
  h.finish(); await tick()
})

test('父会话正在运行不阻挡侧聊；不绑定为父的跨项目输入不能读取侧聊', async () => {
  const h = harness()
  h.ports.isActive = id => id === 'parent'
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '继续并行' })
  expect(h.runs).toHaveLength(1)
  expect((await h.service.getSideChat('parent'))?.isRunning).toBe(true)
  await expect(h.service.getSideChat('missing')).rejects.toThrow()
  h.finish(); await tick()
})

test('Given 图片模型不支持或保存失败 When 发送 Then 不启动且释放串行锁', async () => {
  for (const failure of ['capability', 'storage']) {
    const h = harness()
    let saved = 0
    h.ports.saveImages = () => { saved++; throw new Error('保存失败') }
    h.ports.validateImageModel = async () => { if (failure === 'capability') throw new Error('模型不支持图片') }
    await expect(h.service.sendSideChat({ parentSessionId: 'parent', message: '看图', images: [png] })).rejects.toThrow(failure === 'capability' ? '模型不支持' : '保存失败')
    expect(saved).toBe(failure === 'storage' ? 1 : 0)
    expect(h.runs).toHaveLength(0)
    expect((await h.service.getSideChat('parent'))?.isRunning).toBe(false)
    await h.service.sendSideChat({ parentSessionId: 'parent', message: '改问纯文本' })
    expect(h.runs).toHaveLength(1)
    h.finish(); await tick()
  }
})

test('Given 图片模型校验正在等待 When 停止 Then 不保存也不绑定或启动', async () => {
  const h = harness(); let release = () => {}; let saved = false; let bound = false
  h.ports.validateImageModel = () => new Promise(resolve => { release = resolve })
  h.ports.saveImages = () => { saved = true; return [] }
  h.setBind(async () => { bound = true })
  const sending = h.service.sendSideChat({ parentSessionId: 'parent', message: '看图', images: [png] })
  await h.service.stopSideChat('parent')
  release(); await expect(sending).rejects.toThrow('已取消')
  expect(saved).toBe(false); expect(bound).toBe(false); expect(h.runs).toHaveLength(0)
})

test('Given 图片等待目标绑定 When 父子归属变化 Then 不保存也不启动', async () => {
  const h = harness(); let saved = false
  h.setBind(async () => { h.sessions[1]!.workspaceId = 'other' })
  h.ports.saveImages = () => { saved = true; return [] }
  await expect(h.service.sendSideChat({ parentSessionId: 'parent', message: '看图', images: [png] })).rejects.toThrow('归属')
  expect(saved).toBe(false); expect(h.runs).toHaveLength(0)
})

test('Given 已验证图片等待启动 When 原请求对象被修改 Then 保存和启动仍绑定原始字节与用户意图', async () => {
  const h = harness(); let release = () => {}; let saved = ''
  h.ports.validateImageModel = () => new Promise(resolve => { release = resolve })
  h.ports.saveImages = (_id, images) => { saved = images[0]!.bytes.toString('base64'); return [{ label: images[0]!.filename, path: 'C:\host\child\image.png' }] }
  const input = { parentSessionId: 'parent', message: '原问题', images: [{ ...png }] }
  const sending = h.service.sendSideChat(input)
  input.message = '替换问题'; input.images[0]!.data = 'malformed'; input.images[0]!.filename = '../escape.png'
  release(); await sending
  expect(saved).toBe(png.data)
  expect(h.runs[0]!.rawUserMessage).toContain('原问题')
  expect(h.runs[0]!.rawUserMessage).not.toContain('替换')
  h.finish(); await tick()
})
