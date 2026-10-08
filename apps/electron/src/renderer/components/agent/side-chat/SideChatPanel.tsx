import { sendSideChatDraft } from './side-chat-send'
import { mergeAgentMessageTimeline } from '@/lib/agent-message-timeline'
import {
  getSideChatSelections, getSideChatSelectionLimitReason, clearSideChatSelectionLimitReason,
  removeSideChatSelection, clearSideChatSelections, buildPromptWithSideChatSelections,
  subscribeSideChatSelections, SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH,
} from '@/lib/side-chat-selections'
import * as React from 'react'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  agentLiveMessagesAtomFamily, agentSessionStreamingStateAtomFamily, agentStreamErrorsAtom,
  agentSessionPathMapAtom,
} from '@/atoms/agent-atoms'
import { agentSideChatMapAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import {
  sideChatDraftAtomFamily, sideChatChildrenMapAtom, sideChatOperationAtomFamily,
  sideChatHandoffAtomFamily,
} from '@/atoms/side-chat-atoms'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { ExecutionControls } from '@/components/agent/ExecutionControls'
import { ArrowUp, Square, X, Quote, CornerUpLeft, MessagesSquare } from 'lucide-react'
import { AttachmentPreviewItem } from '@/components/chat/AttachmentPreviewItem'
import { sideChatImagesAtomFamily, sideChatImageLoadingAtomFamily, sideChatComposerErrorAtomFamily, prepareSideChatImages, imagePreview } from './side-chat-images'
import { RichTextInput, type RichTextInputHandle } from '@/components/ai-elements/rich-text-input'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import { inputToolbarButtonClass, inputToolbarSendButtonClass, inputToolbarDangerButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { AgentMessages } from '@/components/agent/AgentMessages'
import { AgentSessionProvider } from '@/contexts/session-context'
import { PermissionBanner } from '@/components/agent/PermissionBanner'
import { AskUserBanner } from '@/components/agent/AskUserBanner'
import { Button } from '@/components/ui/button'
import { sideChatHandoffPrompt } from './side-chat-behavior'

/**
 * SideChatPanel — ZCode 式完整侧聊（单子会话视图）
 *
 * - 多开由右侧工作区标签条承载（side-chat:{childId} 实例 tab），本组件只渲染一个子会话
 * - 子会话创建时 fork 继承父 transcript（仅模型上下文），时间线只显示侧聊自己的消息
 * - 时间线复用 AgentMessages 全量渲染；完整会话能力（工具经权限审批，横幅内直接处理）
 * - 输入区复用主消息区同款 RichTextInput + InputToolbarOverflow 工具栏
 */
export function SideChatPanel({ parentSessionId, childSessionId }: { parentSessionId: string; childSessionId: string }): React.ReactElement {
  const store = useStore()
  const view = useAtomValue(sideChatChildrenMapAtom).get(parentSessionId)?.find(item => item.sessionId === childSessionId) ?? null
  const [draft, setDraft] = useAtom(sideChatDraftAtomFamily(childSessionId))
  const handoff = useAtomValue(sideChatHandoffAtomFamily(parentSessionId))
  const legacyId = useAtomValue(agentSideChatMapAtom).get(parentSessionId)
  const setConversationId = useSetAtom(currentConversationIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const sessionPath = useAtomValue(agentSessionPathMapAtom).get(parentSessionId) ?? null
  const pending = useAtomValue(sideChatOperationAtomFamily(childSessionId)).sending
  const [handoffPending, setHandoffPending] = React.useState(false)
  const [error, setError] = useAtom(sideChatComposerErrorAtomFamily(childSessionId))
  const imagesAtom = sideChatImagesAtomFamily(childSessionId)
  const loadingImagesAtom = sideChatImageLoadingAtomFamily(childSessionId)
  const images = useAtomValue(imagesAtom)
  const loadingImages = useAtomValue(loadingImagesAtom)
  const setImages = useSetAtom(imagesAtom)
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(childSessionId))
  const running = Boolean(view?.isRunning || streamState?.running || streamState?.backgroundWaiting)
  const streamErrors = useAtomValue(agentStreamErrorsAtom)
  const liveMessages = useAtomValue(agentLiveMessagesAtomFamily(childSessionId))
  const timeline = React.useMemo(() => mergeAgentMessageTimeline(view?.messages ?? [], liveMessages), [view?.messages, liveMessages])
  const [selections, setSelections] = React.useState(() => [...getSideChatSelections(parentSessionId)])
  const [selectionLimit, setSelectionLimit] = React.useState(() => getSideChatSelectionLimitReason(parentSessionId))
  const input = React.useRef<RichTextInputHandle>(null)

  // 划选引用来自模块级 scope store（非 atom），用订阅保持同步。
  React.useEffect(() => subscribeSideChatSelections(() => {
    setSelections([...getSideChatSelections(parentSessionId)])
    setSelectionLimit(getSideChatSelectionLimitReason(parentSessionId))
  }), [parentSessionId])
  React.useEffect(() => { input.current?.focus() }, [draft.focusRevision])

  const addImages = async (files: readonly File[]): Promise<void> => {
    if (!files.length) return
    if (store.get(loadingImagesAtom)) { setError('图片正在读取，请稍后再添加。'); return }
    store.set(loadingImagesAtom, true)
    setError('')
    try {
      const prepared = await prepareSideChatImages(files, store.get(imagesAtom))
      store.set(imagesAtom, (current) => [...current, ...prepared])
    } catch (cause) { setError(String(cause)) }
    finally { store.set(loadingImagesAtom, false) }
  }

  const handoffLock = React.useRef(false)
  const send = async (): Promise<void> => {
    const snapshot = [...getSideChatSelections(parentSessionId)]
    await sendSideChatDraft(
      store, parentSessionId, childSessionId, running,
      (payload) => window.electronAPI.sendSideChat(payload),
      (text) => buildPromptWithSideChatSelections(text, snapshot),
    )
    // 只有提交成功（无错误）才清空引用；失败时保留供重试。
    if (!store.get(sideChatComposerErrorAtomFamily(childSessionId))) clearSideChatSelections(parentSessionId)
  }

  const handoffToMain = async (text: string): Promise<void> => {
    if (!handoff || handoffLock.current) return
    handoffLock.current = true
    setHandoffPending(true); setError('')
    try {
      await handoff.send(sideChatHandoffPrompt(text))
      toast.success('已交给主助手')
    }
    catch (cause) { setError(String(cause)) }
    finally { handoffLock.current = false; setHandoffPending(false) }
  }

  const placeholder = view?.channelId ? '在侧聊中提问…' : '请先为主会话选择渠道'

  const toolbarItems = React.useMemo<ToolbarItem[]>(() => [
    {
      // 主输入同款工作方式控件（按子会话）：完整会话可切研究/执行。
      key: 'side-chat-execution-controls',
      node: <ExecutionControls sessionId={childSessionId} />,
    },
    ...(handoff && draft.text.trim() ? [{
      // 窄栏简化：低频入口只进「更多」菜单。
      key: 'side-chat-handoff',
      menuOnly: true,
      onMenuSelect: () => { void handoffToMain(draft.text) },
      node: (
        <TooltipIconButton label="交给主助手处理" disabled={handoffPending} onClick={() => { void handoffToMain(draft.text) }}>
          <CornerUpLeft className="size-4" />
        </TooltipIconButton>
      ),
    }] : []),
    ...(legacyId ? [{
      key: 'side-chat-legacy',
      menuOnly: true,
      onMenuSelect: () => { setConversationId(legacyId); setAppMode('chat') },
      node: (
        <TooltipIconButton label="查看旧问答记录" onClick={() => { setConversationId(legacyId); setAppMode('chat') }}>
          <MessagesSquare className="size-4" />
        </TooltipIconButton>
      ),
    }] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [childSessionId, draft.text, handoff, handoffPending, legacyId])

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="侧聊">
      {/* 时间线：复用主会话完整渲染（markdown / 工具活动 / 流式）；继承上下文只进模型侧，时间线从空白开始。
          wrapper 必须是 flex column：AgentMessages 根节点靠 flex-1 拿到受约束高度，StickToBottom 才能滚动 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {timeline.length > 0 || running ? (
          <AgentSessionProvider sessionId={childSessionId}>
            <AgentMessages
              sessionId={childSessionId}
              sessionModelId={view?.modelId ?? undefined}
              messagesLoaded
              persistedSDKMessages={timeline}
              streaming={running}
              streamState={streamState ?? undefined}
              liveMessages={liveMessages}
              sessionPath={sessionPath}
            />
          </AgentSessionProvider>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <MessagesSquare className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">已继承主对话上下文</p>
            <p className="text-xs text-muted-foreground/70">直接提问开始这轮侧聊；也可以在主对话划选文本作为引用。</p>
          </div>
        )}
      </div>
      {/* 完整会话：侧聊内权限/问答请求直接在面板审批 */}
      <div className="shrink-0 px-2">
        <PermissionBanner sessionId={childSessionId} />
        <AskUserBanner sessionId={childSessionId} />
      </div>
      {(error || streamErrors.get(childSessionId)) && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">{error || streamErrors.get(childSessionId)}</p>
      )}
      {/* 输入区：主消息区同款形态（引用 chips + 图片预览 + RichTextInput + 工具栏） */}
      <div className="shrink-0 px-2 pb-2">
        {selectionLimit && (
          <div className="mb-1.5 flex items-center justify-between rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">
            <span>{selectionLimit === 'single' ? `单条引用不能超过 ${SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH} 字符` : selectionLimit === 'count' ? '最多同时引用 8 段内容' : '引用总长度超过 16000 字符'}</span>
            <button type="button" className="hover:underline" onClick={() => clearSideChatSelectionLimitReason(parentSessionId)}>知道了</button>
          </div>
        )}
        {selections.length > 0 && (
          <div className="mb-1.5 flex flex-col gap-1" aria-label="待发送引用">
            {selections.map((selection) => (
              <div key={selection.id} className="flex items-start gap-2 rounded-lg bg-muted/60 p-2 text-xs">
                <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-[11px] text-muted-foreground">{selection.sourceLabel ?? 'Agent 历史'}</div>
                  <div className="max-h-16 overflow-auto whitespace-pre-wrap break-words">{selection.text}</div>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label="移除引用" onClick={() => removeSideChatSelection(parentSessionId, selection.id)}><X className="size-3.5" /></Button>
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && <div className="mb-1.5 flex flex-wrap gap-2" aria-label="待发送图片">
          {images.map((image, index) => <AttachmentPreviewItem key={image.id} filename={image.filename} mediaType={image.mediaType}
            previewUrl={imagePreview(image)} onRemove={() => setImages((current) => current.filter((item) => item.id !== image.id))}
            imageSiblings={images.map((item) => ({ filename: item.filename, previewUrl: imagePreview(item) }))} siblingIndex={index} />)}
        </div>}
        <div role="group" aria-label="侧聊消息" data-agent-composer-surface="true"
          className="agent-composer-surface rounded-lg border-[0.5px] border-border bg-background/70 backdrop-blur-sm transition-all duration-200">
          <RichTextInput
            ref={input}
            value={draft.text}
            onChange={(text) => setDraft((current) => ({ ...current, text }))}
            onSubmit={() => void send()}
            onPasteFiles={(files) => void addImages(files)}
            placeholder={placeholder}
            autoFocusTrigger={childSessionId}
            collapsible
            enableMentions
            workspacePath={sessionPath}
            className="px-3 py-2.5"
          />
          <div className="px-2 py-1.5">
            <InputToolbarOverflow
              items={toolbarItems}
              trailing={(
                <>
                  <ModelSelector
                    externalSelectedModel={draft.model ?? (view?.channelId && view?.modelId ? { channelId: view.channelId, modelId: view.modelId } : null)}
                    onModelSelect={(option) => setDraft((current) => ({ ...current, model: { channelId: option.channelId, modelId: option.modelId } }))}
                  />
                  {running ? (
                    <Button size="icon" variant="ghost" className={inputToolbarDangerButtonClass} aria-label="停止" title="停止"
                      onClick={() => { void window.electronAPI.stopSideChat({ parentSessionId, childSessionId }).catch((cause: unknown) => setError(String(cause))) }}>
                      <Square className="size-3.5" />
                    </Button>
                  ) : (
                    <Button size="icon" variant="ghost" className={inputToolbarSendButtonClass} aria-label="发送" title="发送"
                      disabled={pending || loadingImages || (!draft.text.trim() && !images.length && !selections.length)}
                      onClick={() => void send()}>
                      <ArrowUp className="size-4" strokeWidth={2.25} />
                    </Button>
                  )}
                </>
              )}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

function TooltipIconButton({ label, onClick, disabled, children }: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} disabled={disabled}
      className={inputToolbarButtonClass} onClick={onClick}>
      {children}
    </Button>
  )
}
