import { expect, test } from 'bun:test'
import type { AgentSendInput, AgentSessionMeta, SDKMessage } from '@domi/shared'
import { SideChatService, type SideChatPorts } from './service'
import { claimSideChatLaunch } from './policy'

function harness() {
  const sessions: AgentSessionMeta[] = [{ id: 'parent', title: '任务', workspaceId: 'w', channelId: 'c', modelId: 'm', createdAt: 1, updatedAt: 1 } as AgentSessionMeta]
  const runs: AgentSendInput[] = []
  const stops: string[] = []
  const seeded: string[] = []
  const deleted: string[] = []
  let childSeq = 0
  let finish = () => {}
  let bind: () => Promise<void> = async () => {}
  const messages = new Map<string, SDKMessage[]>()
  const ports: SideChatPorts = {
    getSession: id => sessions.find(s => s.id === id), listSessions: () => sessions,
    createChild: p => { childSeq += 1; const c = { ...p, id: `child${childSeq}`, channelId: undefined, modelId: undefined, parentSessionId: p.id, sideChatParentSessionId: p.id, createdAt: childSeq } as AgentSessionMeta; sessions.push(c); return c },
    seedChild: async id => { seeded.push(id); return true },
    deleteChild: async id => { deleted.push(id); const index = sessions.findIndex(s => s.id === id); if (index >= 0) sessions.splice(index, 1) },
    updateModel: (id, channelId, modelId) => Object.assign(sessions.find(s => s.id === id)!, { channelId, modelId }),
    messages: id => messages.get(id) ?? [], bindTarget: () => bind(), validateModel: () => undefined, validateImageModel: async () => {},
    saveImages: (id, images) => images.map(image => ({ label: image.filename, path: `C:\\host\\${id}\\${image.filename}` })),
    run: input => { runs.push(input); return new Promise(resolve => { finish = resolve }) },
    stop: id => { stops.push(id) }, isActive: () => false, recordError: () => {},
  }
  return { service: new SideChatService(ports), ports, sessions, runs, stops, seeded, deleted, messages, finish: () => finish(), setBind: (fn: () => Promise<void>) => { bind = fn } }
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
    expect(claimSideChatLaunch('child1', 'parent', { ...h.runs[0]! })).toBe(false)
    expect(claimSideChatLaunch('child1', 'parent', h.runs[0]!)).toBe(true)
    expect(claimSideChatLaunch('child1', 'parent', h.runs[0]!)).toBe(false)
  } finally { h.finish(); await tick() }
})

test('并发打开只创建一个持久子会话并 fork 父上下文，不触发模型；新服务实例不自动运行', async () => {
  const h = harness()
  const views = await Promise.all([h.service.openSideChat({ parentSessionId: 'parent' }), h.service.openSideChat({ parentSessionId: 'parent' })])
  expect(views[0]!.sessionId).toBe(views[1]!.sessionId)
  expect(h.sessions).toHaveLength(2)
  expect(h.seeded).toEqual([views[0]!.sessionId])
  expect(h.runs).toHaveLength(0)
  // 创建即继承父会话渠道与模型；旧子会话未设置时也回落显示父值。
  expect(views[0]!.channelId).toBe('c')
  expect(views[0]!.modelId).toBe('m')
  const fresh = new SideChatService(h.ports)
  const listed = await fresh.listSideChats('parent')
  expect(listed.map(view => view.sessionId)).toEqual([views[0]!.sessionId])
  expect(listed[0]!.isRunning).toBe(false)
})

test('forceNew 追加新子会话，默认入口仍复用活动子会话', async () => {
  const h = harness()
  const first = await h.service.openSideChat({ parentSessionId: 'parent' })
  const reuse = await h.service.openSideChat({ parentSessionId: 'parent' })
  expect(reuse.sessionId).toBe(first.sessionId)
  expect(h.sessions).toHaveLength(2)
  const second = await h.service.openSideChat({ parentSessionId: 'parent', forceNew: true })
  expect(second.sessionId).not.toBe(first.sessionId)
  expect(h.sessions).toHaveLength(3)
  // 显式 childSessionId 定向发送，活动指针随发送更新。
  h.service.sendSideChat({ parentSessionId: 'parent', childSessionId: first.sessionId, message: '第一问' }).catch(() => {})
  await tick(); h.finish(); await tick()
  const reuseAfterSend = await h.service.openSideChat({ parentSessionId: 'parent' })
  expect(reuseAfterSend.sessionId).toBe(first.sessionId)
})

test('closeSideChat 删除指定子会话并回退活动指针；运行中拒绝关闭', async () => {
  const h = harness()
  const first = await h.service.openSideChat({ parentSessionId: 'parent' })
  const second = await h.service.openSideChat({ parentSessionId: 'parent', forceNew: true })
  const remaining = await h.service.closeSideChat({ parentSessionId: 'parent', childSessionId: second.sessionId })
  expect(h.deleted).toEqual([second.sessionId])
  expect(remaining.map(view => view.sessionId)).toEqual([first.sessionId])
  const reuse = await h.service.openSideChat({ parentSessionId: 'parent' })
  expect(reuse.sessionId).toBe(first.sessionId)
  await expect(h.service.closeSideChat({ parentSessionId: 'parent', childSessionId: 'missing' })).rejects.toThrow('不存在')
})

test('发送立即返回，主侧独立；子会话串行、多轮保留模型，换模型不改父', async () => {
  const h = harness()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '问题一' })
  expect(h.runs).toHaveLength(1)
  expect(h.runs[0]!.modelId).toBe('m')
  // 完整会话：不再覆盖工作方式，随子会话持久设置与全局默认。
  expect(h.runs[0]!.workflowOverride).toBeUndefined()
  await expect(h.service.sendSideChat({ parentSessionId: 'parent', message: '重复' })).rejects.toThrow('正在回复')
  h.finish(); await tick()
  h.sessions[0]!.modelId = 'parent-changed'
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '问题二' })
  expect(h.runs[1]!.modelId).toBe('m')
  h.finish(); await tick()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '问题三', modelId: 'child-changed' })
  expect(h.sessions[0]!.modelId).toBe('parent-changed')
  expect(h.runs[2]!.modelId).toBe('child-changed')
  await h.service.stopSideChat({ parentSessionId: 'parent' })
  expect(h.stops).toEqual(['child1'])
  h.finish(); await tick()
})

test('fork 继承后发送不再注入背景摘录；显式引用仍随正文发送', async () => {
  const h = harness()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '帮我解释', quotedText: '这段引用' })
  expect(h.seeded).toEqual(['child1'])
  expect(h.runs[0]!.userMessage).not.toContain('宿主可见主会话背景')
  expect(h.runs[0]!.rawUserMessage).toContain('这段引用')
  expect(h.messages.get('parent')).toBeUndefined()
  h.finish(); await tick()
})

test('目标绑定期间停止阻止后续付费启动且保留记录', async () => {
  const h = harness(); let release = () => {}
  h.setBind(() => new Promise(resolve => { release = resolve }))
  const sending = h.service.sendSideChat({ parentSessionId: 'parent', message: '问题' })
  await h.service.stopSideChat({ parentSessionId: 'parent' }); release(); await expect(sending).rejects.toThrow('已取消')
  expect(h.runs).toHaveLength(0)
  expect(await h.service.listSideChats('parent')).not.toHaveLength(0)
})

test('跨项目归属和侧聊再创建侧聊均被拒绝', async () => {
  const h = harness(); await h.service.openSideChat({ parentSessionId: 'parent' })
  await expect(h.service.openSideChat({ parentSessionId: 'child1' })).rejects.toThrow()
  h.sessions[1]!.workspaceId = 'other'
  await expect(h.service.stopSideChat({ parentSessionId: 'parent' })).rejects.toThrow('归属')
})

test('父会话正在运行不阻挡侧聊；子会话运行态在列表中可见', async () => {
  const h = harness()
  await h.service.sendSideChat({ parentSessionId: 'parent', message: '继续并行' })
  expect(h.runs).toHaveLength(1)
  // 发送已启动后子会话进入运行态（宿主 runner 活跃）。
  h.ports.isActive = id => id === 'child1'
  expect((await h.service.listSideChats('parent'))[0]!.isRunning).toBe(true)
  await expect(h.service.listSideChats('missing')).rejects.toThrow()
  h.finish(); await tick()
})

test('Given 已验证图片等待启动 When 原请求对象被修改 Then 保存和启动仍绑定原始字节与用户意图', async () => {
  const h = harness(); let release = () => {}; let saved = ''; let validateReached = false
  h.ports.validateImageModel = () => { validateReached = true; return new Promise(resolve => { release = resolve }) }
  h.ports.saveImages = (_id, images) => { saved = images[0]!.bytes.toString('base64'); return [{ label: images[0]!.filename, path: 'C:\host\child1\image.png' }] }
  const input = { parentSessionId: 'parent', message: '原问题', images: [{ ...png }] }
  const sending = h.service.sendSideChat(input)
  input.message = '替换问题'; input.images[0]!.data = 'malformed'; input.images[0]!.filename = '../escape.png'
  // fork 创建是异步的：等发送链路真正挂起在图片校验后再放行。
  for (let i = 0; i < 50 && !validateReached; i += 1) await tick()
  expect(validateReached).toBe(true)
  release(); await sending
  expect(saved).toBe(png.data)
  expect(h.runs[0]!.rawUserMessage).toContain('原问题')
  expect(h.runs[0]!.rawUserMessage).not.toContain('替换')
  h.finish(); await tick()
})
