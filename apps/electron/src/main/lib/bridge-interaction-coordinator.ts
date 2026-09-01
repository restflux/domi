import type {
  AskUserQuestion,
  AskUserRequest,
  ExitPlanModeAction,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
} from '@domi/shared'

// 与 @domi/shared 的 Direct Workflow 回答协议保持一致；这里保留纯值以便协调器独立测试。
const DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY = '__direct_workflow_adjustment__'

export const BRIDGE_INTERACTION_TIMEOUT_MS = 30 * 60_000
const LATE_ANSWER_GUARD_MS = 2 * 60_000

export interface BridgeInteractionScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
  now(): number
}

const DEFAULT_SCHEDULER: BridgeInteractionScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
}

export interface BridgeInteractionOption {
  id: string
  label: string
  description?: string
  actionId: string
}

export interface BridgeInteractionView {
  requestId: string
  sessionId: string
  chatId: string
  generation: number
  kind: 'ask_user' | 'exit_plan' | 'desktop_only'
  title: string
  prompt: string
  context?: string
  options: BridgeInteractionOption[]
  multiSelect: boolean
  allowText: boolean
  questionIndex: number
  questionCount: number
  desktopOnly: boolean
}

export interface BridgeInteractionResolution {
  submittedByThisCoordinator: boolean
}

export interface BridgeInteractionResult {
  handled: boolean
  status?: 'accepted' | 'advanced' | 'awaiting_text' | 'invalid' | 'expired'
  message?: string
  view?: BridgeInteractionView
}

interface BridgeInteractionCoordinatorOptions {
  respondAskUser: (requestId: string, answers: Record<string, string>) => boolean
  respondExitPlan: (response: ExitPlanModeResponse) => boolean
  onTimeout: (sessionId: string, chatId: string, requestId: string) => void
  scheduler?: BridgeInteractionScheduler
  timeoutMs?: number
}

interface ActiveRun {
  chatId: string
  generation: number
}

interface PendingBase {
  requestId: string
  sessionId: string
  chatId: string
  generation: number
  timer: ReturnType<typeof setTimeout>
  submitting: boolean
}

interface PendingAskUser extends PendingBase {
  kind: 'ask_user'
  request: AskUserRequest
  questionIndex: number
  answers: Record<string, string>
  awaitingCustom: boolean
  directWorkflow: boolean
}

interface PendingExitPlan extends PendingBase {
  kind: 'exit_plan'
  request: ExitPlanModeRequest
  awaitingFeedback: boolean
}

interface PendingDesktopOnly extends PendingBase {
  kind: 'desktop_only'
  title: string
  prompt: string
}

type PendingInteraction = PendingAskUser | PendingExitPlan | PendingDesktopOnly

interface LateAnswerGuard {
  expiresAt: number
  consumeAnyText: boolean
  optionLabels: Set<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDirectWorkflowRequest(request: AskUserRequest): boolean {
  const presentation = request.toolInput.presentation
  return isRecord(presentation) && presentation.kind === 'direct-workflow'
}

/** 未知的宿主 presentation 可能承载高风险事务，第一版只允许普通问答和 Direct Workflow。 */
export function isBridgeSafeAskUserRequest(request: AskUserRequest): boolean {
  const presentation = request.toolInput.presentation
  if (presentation === undefined) return true
  return isDirectWorkflowRequest(request)
}

function directWorkflowContext(request: AskUserRequest): string | undefined {
  const presentation = request.toolInput.presentation
  if (!isRecord(presentation) || presentation.kind !== 'direct-workflow') return undefined
  const summary = typeof presentation.summary === 'string' ? presentation.summary.trim() : ''
  const details = typeof presentation.details === 'string' ? presentation.details.trim() : ''
  const context = [summary, details].filter(Boolean).join('\n\n')
  if (!context) return undefined
  return context.length > 4_000 ? `${context.slice(0, 4_000)}\n…` : context
}

function extractPlanContext(request: ExitPlanModeRequest): string | undefined {
  const plan = typeof request.toolInput.plan === 'string' ? request.toolInput.plan.trim() : ''
  if (!plan) return undefined
  return plan.length > 4_000 ? `${plan.slice(0, 4_000)}\n…` : plan
}

function normalizeAnswerCommand(text: string): string {
  const trimmed = text.trim()
  return trimmed.toLowerCase().startsWith('/answer')
    ? trimmed.slice('/answer'.length).trim()
    : trimmed
}

function parseIndices(text: string): number[] | null {
  const normalized = text.trim()
  if (!/^\d+(?:\s*[,，、\s]\s*\d+)*$/.test(normalized)) return null
  const values = normalized.split(/[,，、\s]+/).filter(Boolean).map(Number)
  return values.every((value) => Number.isSafeInteger(value) && value > 0) ? values : null
}

function questionOptions(question: AskUserQuestion, directWorkflow: boolean): BridgeInteractionOption[] {
  const options = question.options.map((option, index) => ({
    id: String(index + 1),
    label: option.label,
    description: option.description,
    actionId: `option:${index + 1}`,
  }))
  if (question.allowCustom !== false) {
    options.push({
      id: String(options.length + 1),
      label: directWorkflow ? '调整后再确认' : '其他（直接输入）',
      description: directWorkflow ? '补充调整意见后保持研究，由 Agent 修订方向并重新确认。' : undefined,
      actionId: 'custom',
    })
  }
  return options
}

function planOptions(): BridgeInteractionOption[] {
  return [
    { id: '1', label: '仅执行本次', description: '只批准当前任务执行。', actionId: 'plan:approve_current' },
    { id: '2', label: '切换到执行', description: '批准当前任务，并让后续消息保持执行模式。', actionId: 'plan:approve_and_switch' },
    { id: '3', label: '保持规划', description: '拒绝当前计划，不进入执行。', actionId: 'plan:deny' },
    { id: '4', label: '调整后再确认', description: '补充反馈，由 Agent 修改计划后重新申请。', actionId: 'plan:feedback' },
  ]
}

export function formatBridgeInteractionText(view: BridgeInteractionView): string {
  const lines: string[] = [`【${view.title}】`]
  if (view.context) lines.push(view.context)
  lines.push(view.prompt)
  for (const option of view.options) {
    lines.push(`${option.id}. ${option.label}${option.description ? ` · ${option.description}` : ''}`)
  }
  if (view.desktopOnly) {
    lines.push('此确认涉及宿主或权限边界，请回 Domi 桌面处理。')
  } else if (view.options.length > 0) {
    lines.push(view.multiSelect ? '直接回复多个序号，如 1,3。' : '直接回复序号或完整选项文字。')
  } else {
    lines.push('直接回复内容即可。')
  }
  return lines.join('\n')
}

export class BridgeInteractionCoordinator {
  private readonly scheduler: BridgeInteractionScheduler
  private readonly timeoutMs: number
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly pendingBySession = new Map<string, PendingInteraction>()
  private readonly sessionByChat = new Map<string, string>()
  private readonly lateAnswerGuards = new Map<string, LateAnswerGuard>()
  private generationCounter = 0

  constructor(private readonly options: BridgeInteractionCoordinatorOptions) {
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER
    this.timeoutMs = options.timeoutMs ?? BRIDGE_INTERACTION_TIMEOUT_MS
  }

  beginRun(sessionId: string, chatId: string): number {
    this.clearSession(sessionId)
    const generation = ++this.generationCounter
    this.activeRuns.set(sessionId, { chatId, generation })
    this.sessionByChat.set(chatId, sessionId)
    return generation
  }

  endRun(sessionId: string): void {
    const run = this.activeRuns.get(sessionId)
    this.clearSession(sessionId)
    this.activeRuns.delete(sessionId)
    if (run && this.sessionByChat.get(run.chatId) === sessionId) {
      this.sessionByChat.delete(run.chatId)
    }
  }

  registerAskUser(request: AskUserRequest): BridgeInteractionView | null {
    const run = this.activeRuns.get(request.sessionId)
    if (!run) return null
    if (request.questions.length === 0) {
      return this.registerDesktopOnly(
        request.sessionId,
        request.requestId,
        '需要桌面确认',
        '该问答没有可安全解析的问题，请回 Domi 桌面处理。',
      )
    }
    if (!isBridgeSafeAskUserRequest(request)) {
      return this.registerDesktopOnly(
        request.sessionId,
        request.requestId,
        '需要桌面确认',
        'Agent 正在等待一项宿主级确认。',
      )
    }
    const pending: PendingAskUser = {
      kind: 'ask_user',
      requestId: request.requestId,
      sessionId: request.sessionId,
      chatId: run.chatId,
      generation: run.generation,
      timer: this.createTimeout(request.sessionId, run.chatId, request.requestId, run.generation),
      submitting: false,
      request,
      questionIndex: 0,
      answers: {},
      awaitingCustom: false,
      directWorkflow: isDirectWorkflowRequest(request),
    }
    this.replacePending(pending)
    return this.buildView(pending)
  }

  registerExitPlan(request: ExitPlanModeRequest): BridgeInteractionView | null {
    const run = this.activeRuns.get(request.sessionId)
    if (!run) return null
    const pending: PendingExitPlan = {
      kind: 'exit_plan',
      requestId: request.requestId,
      sessionId: request.sessionId,
      chatId: run.chatId,
      generation: run.generation,
      timer: this.createTimeout(request.sessionId, run.chatId, request.requestId, run.generation),
      submitting: false,
      request,
      awaitingFeedback: false,
    }
    this.replacePending(pending)
    return this.buildView(pending)
  }

  registerPermission(request: PermissionRequest): BridgeInteractionView | null {
    return this.registerDesktopOnly(
      request.sessionId,
      request.requestId,
      '需要桌面权限确认',
      '出于安全考虑，IM 不处理 Execution Policy 权限请求。',
    )
  }

  getPendingView(chatId: string): BridgeInteractionView | null {
    const pending = this.getPendingByChat(chatId)
    return pending ? this.buildView(pending) : null
  }

  handleText(chatId: string, rawText: string): BridgeInteractionResult {
    const text = normalizeAnswerCommand(rawText)
    const pending = this.getPendingByChat(chatId)
    if (!pending) return this.handleLateAnswer(chatId, rawText)
    if (pending.submitting) {
      return { handled: true, status: 'invalid', message: '该回答正在提交，请稍候。' }
    }
    if (pending.kind === 'desktop_only') {
      return { handled: true, status: 'invalid', message: formatBridgeInteractionText(this.buildView(pending)) }
    }
    if (!text) {
      return { handled: true, status: 'invalid', message: '回答不能为空，请重新输入。', view: this.buildView(pending) }
    }
    return pending.kind === 'ask_user'
      ? this.answerAskUser(pending, text)
      : this.answerExitPlan(pending, text)
  }

  handleAction(chatId: string, requestId: string, actionId: string): BridgeInteractionResult {
    const pending = this.getPendingByChat(chatId)
    if (!pending || pending.requestId !== requestId) {
      return { handled: true, status: 'expired', message: '该确认已处理或失效。' }
    }
    if (pending.kind === 'desktop_only') {
      return { handled: true, status: 'invalid', message: '此确认必须回 Domi 桌面处理。' }
    }
    if (pending.submitting) {
      return { handled: true, status: 'invalid', message: '该回答正在提交，请稍候。' }
    }
    if (pending.kind === 'exit_plan') {
      const action = actionId.startsWith('plan:') ? actionId.slice('plan:'.length) : ''
      return this.submitPlanAction(pending, action as ExitPlanModeAction)
    }
    if (actionId === 'custom') return this.beginCustomAnswer(pending)
    const match = /^option:(\d+)$/.exec(actionId)
    if (!match) return { handled: true, status: 'invalid', message: '无效选项，请重新选择。' }
    return this.submitAskOptionIndices(pending, [Number(match[1])])
  }

  resolveRequest(requestId: string): BridgeInteractionResolution | null {
    for (const pending of this.pendingBySession.values()) {
      if (pending.requestId !== requestId) continue
      this.rememberLateAnswer(pending)
      this.removePending(pending)
      return { submittedByThisCoordinator: pending.submitting }
    }
    return null
  }

  clearSession(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId)
    if (pending) {
      this.rememberLateAnswer(pending)
      this.removePending(pending)
    }
  }

  clearAll(): void {
    for (const pending of this.pendingBySession.values()) {
      this.scheduler.clearTimeout(pending.timer)
    }
    this.pendingBySession.clear()
    this.activeRuns.clear()
    this.sessionByChat.clear()
    this.lateAnswerGuards.clear()
  }

  private answerAskUser(pending: PendingAskUser, text: string): BridgeInteractionResult {
    if (pending.awaitingCustom) return this.submitCustomAskUser(pending, text)
    const question = pending.request.questions[pending.questionIndex]
    if (!question) return this.expireInvalidPending(pending)
    const options = questionOptions(question, pending.directWorkflow)
    const exact = options.find((option) => option.label === text)
    if (exact?.actionId === 'custom') return this.beginCustomAnswer(pending)
    if (exact) return this.submitAskOptionIndices(pending, [Number(exact.id)])

    const indices = parseIndices(text)
    if (indices) return this.submitAskOptionIndices(pending, indices)
    if (question.allowCustom !== false) return this.submitCustomAskUser(pending, text)
    return {
      handled: true,
      status: 'invalid',
      message: '没有匹配到有效选项，请回复序号或完整选项文字。',
      view: this.buildView(pending),
    }
  }

  private submitAskOptionIndices(pending: PendingAskUser, indices: number[]): BridgeInteractionResult {
    const question = pending.request.questions[pending.questionIndex]
    if (!question) return this.expireInvalidPending(pending)
    const optionCount = question.options.length
    const customIndex = question.allowCustom !== false ? optionCount + 1 : -1
    if (indices.includes(customIndex)) {
      if (indices.length > 1) {
        return { handled: true, status: 'invalid', message: '“其他/调整”不能和其他选项同时选择。' }
      }
      return this.beginCustomAnswer(pending)
    }
    if (!question.multiSelect && indices.length !== 1) {
      return { handled: true, status: 'invalid', message: '这是单选问题，请只回复一个序号。' }
    }
    const unique = [...new Set(indices)]
    if (unique.some((index) => index < 1 || index > optionCount)) {
      return { handled: true, status: 'invalid', message: '选项序号超出范围，请重新输入。', view: this.buildView(pending) }
    }
    const labels = unique.map((index) => question.options[index - 1]!.label)
    pending.answers[question.question || String(pending.questionIndex)] = labels.join(', ')
    return this.advanceOrSubmitAskUser(pending)
  }

  private beginCustomAnswer(pending: PendingAskUser): BridgeInteractionResult {
    pending.awaitingCustom = true
    const prompt = pending.directWorkflow
      ? '请直接回复希望如何调整。Agent 会保持研究，修订后重新向你确认。'
      : '请直接回复你的补充内容。'
    return {
      handled: true,
      status: 'awaiting_text',
      message: prompt,
      view: this.buildView(pending),
    }
  }

  private submitCustomAskUser(pending: PendingAskUser, text: string): BridgeInteractionResult {
    const question = pending.request.questions[pending.questionIndex]
    if (!question) return this.expireInvalidPending(pending)
    const key = pending.directWorkflow
      ? DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY
      : question.question || String(pending.questionIndex)
    pending.answers[key] = text
    pending.awaitingCustom = false
    return this.advanceOrSubmitAskUser(pending)
  }

  private advanceOrSubmitAskUser(pending: PendingAskUser): BridgeInteractionResult {
    if (pending.questionIndex + 1 < pending.request.questions.length && !pending.directWorkflow) {
      pending.questionIndex += 1
      pending.awaitingCustom = false
      return {
        handled: true,
        status: 'advanced',
        message: '已记录，请继续回答下一题。',
        view: this.buildView(pending),
      }
    }
    pending.submitting = true
    const accepted = this.options.respondAskUser(pending.requestId, pending.answers)
    if (!accepted) {
      this.rememberLateAnswer(pending)
      this.removePending(pending)
      return { handled: true, status: 'expired', message: '该确认已在其他入口处理或已经失效。' }
    }
    return { handled: true, status: 'accepted', message: '已提交回答，Agent 将继续处理。' }
  }

  private answerExitPlan(pending: PendingExitPlan, text: string): BridgeInteractionResult {
    if (pending.awaitingFeedback) return this.submitPlanFeedback(pending, text)
    const options = planOptions()
    const exact = options.find((option) => option.label === text)
    if (exact) return this.submitPlanAction(pending, exact.actionId.slice('plan:'.length) as ExitPlanModeAction)
    const indices = parseIndices(text)
    if (!indices || indices.length !== 1) {
      return { handled: true, status: 'invalid', message: '请回复一个有效序号或完整选项文字。', view: this.buildView(pending) }
    }
    const option = options[indices[0]! - 1]
    if (!option) return { handled: true, status: 'invalid', message: '选项序号超出范围。', view: this.buildView(pending) }
    return this.submitPlanAction(pending, option.actionId.slice('plan:'.length) as ExitPlanModeAction)
  }

  private submitPlanAction(pending: PendingExitPlan, action: ExitPlanModeAction): BridgeInteractionResult {
    if (!['approve_current', 'approve_and_switch', 'deny', 'feedback'].includes(action)) {
      return { handled: true, status: 'invalid', message: '无效计划审批选项。' }
    }
    if (action === 'feedback') {
      pending.awaitingFeedback = true
      return { handled: true, status: 'awaiting_text', message: '请直接回复希望如何调整计划。', view: this.buildView(pending) }
    }
    return this.submitExitPlan(pending, { requestId: pending.requestId, action })
  }

  private submitPlanFeedback(pending: PendingExitPlan, feedback: string): BridgeInteractionResult {
    return this.submitExitPlan(pending, { requestId: pending.requestId, action: 'feedback', feedback })
  }

  private submitExitPlan(pending: PendingExitPlan, response: ExitPlanModeResponse): BridgeInteractionResult {
    pending.submitting = true
    const accepted = this.options.respondExitPlan(response)
    if (!accepted) {
      this.rememberLateAnswer(pending)
      this.removePending(pending)
      return { handled: true, status: 'expired', message: '该计划审批已在其他入口处理或已经失效。' }
    }
    return { handled: true, status: 'accepted', message: '已提交选择，Agent 将继续处理。' }
  }

  private registerDesktopOnly(
    sessionId: string,
    requestId: string,
    title: string,
    prompt: string,
  ): BridgeInteractionView | null {
    const run = this.activeRuns.get(sessionId)
    if (!run) return null
    const pending: PendingDesktopOnly = {
      kind: 'desktop_only',
      requestId,
      sessionId,
      chatId: run.chatId,
      generation: run.generation,
      timer: this.createTimeout(sessionId, run.chatId, requestId, run.generation),
      submitting: false,
      title,
      prompt,
    }
    this.replacePending(pending)
    return this.buildView(pending)
  }

  private buildView(pending: PendingInteraction): BridgeInteractionView {
    if (pending.kind === 'desktop_only') {
      return {
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        chatId: pending.chatId,
        generation: pending.generation,
        kind: pending.kind,
        title: pending.title,
        prompt: pending.prompt,
        options: [],
        multiSelect: false,
        allowText: false,
        questionIndex: 0,
        questionCount: 1,
        desktopOnly: true,
      }
    }
    if (pending.kind === 'exit_plan') {
      return {
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        chatId: pending.chatId,
        generation: pending.generation,
        kind: pending.kind,
        title: '计划审批',
        prompt: pending.awaitingFeedback ? '请直接回复希望如何调整计划。' : 'Agent 已完成计划，如何继续？',
        context: extractPlanContext(pending.request),
        options: pending.awaitingFeedback ? [] : planOptions(),
        multiSelect: false,
        allowText: pending.awaitingFeedback,
        questionIndex: 0,
        questionCount: 1,
        desktopOnly: false,
      }
    }
    const question = pending.request.questions[pending.questionIndex]
    const questionCount = pending.request.questions.length
    return {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      chatId: pending.chatId,
      generation: pending.generation,
      kind: pending.kind,
      title: pending.directWorkflow ? '实施方向待确认' : question?.header || '需要你的回答',
      prompt: pending.awaitingCustom
        ? (pending.directWorkflow ? '请直接回复希望如何调整。' : '请直接回复你的补充内容。')
        : question?.question || '请回答以下问题。',
      context: pending.directWorkflow ? directWorkflowContext(pending.request) : undefined,
      options: pending.awaitingCustom || !question ? [] : questionOptions(question, pending.directWorkflow),
      multiSelect: question?.multiSelect === true,
      allowText: pending.awaitingCustom || question?.options.length === 0,
      questionIndex: pending.questionIndex,
      questionCount,
      desktopOnly: false,
    }
  }

  private replacePending(pending: PendingInteraction): void {
    const existing = this.pendingBySession.get(pending.sessionId)
    if (existing) this.removePending(existing)
    this.pendingBySession.set(pending.sessionId, pending)
  }

  private removePending(pending: PendingInteraction): void {
    this.scheduler.clearTimeout(pending.timer)
    if (this.pendingBySession.get(pending.sessionId) === pending) {
      this.pendingBySession.delete(pending.sessionId)
    }
  }

  private getPendingByChat(chatId: string): PendingInteraction | null {
    const sessionId = this.sessionByChat.get(chatId)
    if (!sessionId) return null
    const pending = this.pendingBySession.get(sessionId)
    const run = this.activeRuns.get(sessionId)
    if (!pending || !run || run.chatId !== chatId || run.generation !== pending.generation) return null
    return pending
  }

  private createTimeout(
    sessionId: string,
    chatId: string,
    requestId: string,
    generation: number,
  ): ReturnType<typeof setTimeout> {
    return this.scheduler.setTimeout(() => {
      const pending = this.pendingBySession.get(sessionId)
      const run = this.activeRuns.get(sessionId)
      if (!pending || !run) return
      if (pending.requestId !== requestId || pending.generation !== generation || run.generation !== generation) return
      this.rememberLateAnswer(pending)
      this.removePending(pending)
      this.options.onTimeout(sessionId, chatId, requestId)
    }, this.timeoutMs)
  }

  private rememberLateAnswer(pending: PendingInteraction): void {
    const view = this.buildView(pending)
    this.lateAnswerGuards.set(pending.chatId, {
      expiresAt: this.scheduler.now() + LATE_ANSWER_GUARD_MS,
      consumeAnyText: view.allowText || pending.kind === 'desktop_only',
      optionLabels: new Set(view.options.map((option) => option.label)),
    })
  }

  private handleLateAnswer(chatId: string, rawText: string): BridgeInteractionResult {
    const guard = this.lateAnswerGuards.get(chatId)
    if (!guard) return { handled: false }
    if (guard.expiresAt <= this.scheduler.now()) {
      this.lateAnswerGuards.delete(chatId)
      return { handled: false }
    }
    const text = normalizeAnswerCommand(rawText)
    const looksLikeAnswer = rawText.trim().toLowerCase().startsWith('/answer')
      || parseIndices(text) !== null
      || guard.optionLabels.has(text)
      || guard.consumeAnyText
    if (!looksLikeAnswer) return { handled: false }
    this.lateAnswerGuards.delete(chatId)
    return {
      handled: true,
      status: 'expired',
      message: '上一项确认已在其他入口处理或已经失效；如果这是新任务，请重新发送一次。',
    }
  }

  private expireInvalidPending(pending: PendingInteraction): BridgeInteractionResult {
    this.removePending(pending)
    return { handled: true, status: 'expired', message: '该确认数据不完整，已停止在 IM 中处理，请回 Domi 桌面查看。' }
  }
}
