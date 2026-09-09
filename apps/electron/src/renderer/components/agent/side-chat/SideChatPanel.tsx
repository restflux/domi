import { sendSideChatDraft } from './side-chat-send'
import { mergeAgentMessageTimeline } from '@/lib/agent-message-timeline'
import * as React from 'react'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { agentChannelIdAtom, agentModelIdAtom, agentSidePanelOpenAtom, agentLiveMessagesAtomFamily, agentSessionStreamingStateAtomFamily, agentStreamErrorsAtom } from '@/atoms/agent-atoms'
import { agentSideChatMapAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { sideChatDraftAtomFamily, sideChatHandoffAtomFamily, sideChatViewAtomFamily, sideChatOperationAtomFamily } from '@/atoms/side-chat-atoms'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { MessageLoading } from '@/components/ai-elements/message'
import { CornerDownLeft, Square, X, Quote, ImagePlus } from 'lucide-react'
import { AttachmentPreviewItem } from '@/components/chat/AttachmentPreviewItem'
import { sideChatImagesAtomFamily, sideChatImageLoadingAtomFamily, sideChatComposerErrorAtomFamily, prepareSideChatImages, imagePreview } from './side-chat-images'
import { RichTextInput, type RichTextInputHandle } from '@/components/ai-elements/rich-text-input'
import { inputToolbarSendButtonClass, inputToolbarDangerButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { SideChatMessage } from './SideChatMessage'
import { Button } from '@/components/ui/button'
import { startSideChatPolling } from './side-chat-polling'
import { sideChatHandoffPrompt, sideChatTextMessages } from './side-chat-behavior'

export function SideChatPanel({ parentSessionId }: { parentSessionId: string }): React.ReactElement {
  const [draft, setDraft] = useAtom(sideChatDraftAtomFamily(parentSessionId))
  const [view, setView] = useAtom(sideChatViewAtomFamily(parentSessionId))
  const handoff = useAtomValue(sideChatHandoffAtomFamily(parentSessionId))
  const channelId = useAtomValue(agentChannelIdAtom)
  const modelId = useAtomValue(agentModelIdAtom)
  const legacyId = useAtomValue(agentSideChatMapAtom).get(parentSessionId)
  const setConversationId = useSetAtom(currentConversationIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const panelOpen = useAtomValue(agentSidePanelOpenAtom)
  const appMode = useAtomValue(appModeAtom)
  const store = useStore()
  const operationAtom = sideChatOperationAtomFamily(parentSessionId)
  const pending = useAtomValue(operationAtom).sending
  const [handoffPending, setHandoffPending] = React.useState(false)
  const [error, setError] = useAtom(sideChatComposerErrorAtomFamily(parentSessionId))
  const imagesAtom = sideChatImagesAtomFamily(parentSessionId)
  const loadingImagesAtom = sideChatImageLoadingAtomFamily(parentSessionId)
  const [images, setImages] = useAtom(imagesAtom)
  const loadingImages = useAtomValue(loadingImagesAtom)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const addImages = async (files: File[]): Promise<void> => {
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
  const input = React.useRef<RichTextInputHandle>(null)
  const bottom = React.useRef<HTMLDivElement>(null)
  const followBottom = React.useRef(true)
  React.useEffect(() => { input.current?.focus() }, [draft.focusRevision])
  React.useEffect(() => {
    if (!panelOpen || appMode !== 'agent') return
    return startSideChatPolling({
      open: () => window.electronAPI.openSideChat({ parentSessionId }),
      get: () => window.electronAPI.getSideChat(parentSessionId),
      onView: setView,
      onError: (cause) => setError(String(cause)),
      revision: () => store.get(operationAtom).revision,
      isSending: () => store.get(operationAtom).sending,
    })
  }, [parentSessionId, setView, panelOpen, appMode, store, operationAtom])
  const childId = view?.sessionId ?? ''
  const liveMessages = useAtomValue(agentLiveMessagesAtomFamily(childId))
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(childId))
  const streamErrors = useAtomValue(agentStreamErrorsAtom)
  const running = Boolean(streamState?.running || view?.isRunning)
  const messages = React.useMemo(() => sideChatTextMessages(mergeAgentMessageTimeline(view?.messages ?? [], liveMessages)), [view?.messages, liveMessages])
  React.useEffect(() => {
    if (followBottom.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [view?.messages, liveMessages])
  const model = draft.model ?? (view?.channelId && view.modelId ? { channelId: view.channelId, modelId: view.modelId } : channelId && modelId ? { channelId, modelId } : null)
  const send = async (): Promise<void> => {
    followBottom.current = true
    await sendSideChatDraft(store, parentSessionId, running, (payload) => window.electronAPI.sendSideChat(payload))
  }
  const passToMain = async (text: string): Promise<void> => {
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
  return (
    <section className="flex h-full min-h-0 flex-col p-3 gap-3" aria-label="侧聊">
      <header className="flex items-center gap-2 text-xs">
        <span className="font-medium">侧聊</span>
        <span className="text-muted-foreground">只读</span>

      </header>
      {legacyId && (
        <button className="text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => {
          setConversationId(legacyId)
          setAppMode('chat')
        }}>查看旧问答记录</button>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto space-y-4" onScroll={(event) => {
        const target = event.currentTarget
        followBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80
      }}>
        {messages.map((message) => (
          <SideChatMessage key={message.id} role={message.role} text={message.text}
            modelId={message.modelId}
            handoffDisabled={!handoff || handoffPending || running}
            onHandoff={(text) => void passToMain(text)} onError={(cause) => setError(String(cause))} />
        ))}
        {running && <div role="status"><MessageLoading /></div>}
        <div ref={bottom} />
      </div>
      {(error || streamErrors.get(childId)) && <p role="alert" className="text-xs text-destructive">{error || streamErrors.get(childId)}</p>}
      <div className="shrink-0 rounded-xl border border-border/60 bg-background/50 shadow-sm focus-within:border-ring/40">
        {draft.quotedText && (
          <div className="m-2 flex items-start gap-2 rounded-lg bg-muted/60 p-2 text-xs">
            <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="max-h-24 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words">{draft.quotedText}</div>
            <Button size="icon-sm" variant="ghost" aria-label="移除引用" onClick={() => setDraft((current) => ({ ...current, quotedText: '' }))}><X className="size-3.5" /></Button>
          </div>
        )}
        {images.length > 0 && <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="待发送图片">
          {images.map((image, index) => <AttachmentPreviewItem key={image.id} filename={image.filename} mediaType={image.mediaType}
            previewUrl={imagePreview(image)} onRemove={() => setImages((current) => current.filter((item) => item.id !== image.id))}
            imageSiblings={images.map((item) => ({ filename: item.filename, previewUrl: imagePreview(item) }))} siblingIndex={index} />)}
        </div>}
        <div role="group" aria-label="侧聊消息">
          <RichTextInput key={parentSessionId} ref={input} value={draft.text}
            onChange={(text) => setDraft((current) => ({ ...current, text }))}
            onSubmit={() => void send()} onPasteFiles={(files) => void addImages(files)} placeholder="在侧聊中提问…"
            enableMentions={false} autoFocusTrigger={parentSessionId}
            className="min-h-[88px] max-h-60 overflow-y-auto px-3 py-2" />
        </div>
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <input key={parentSessionId} ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" aria-label="选择侧聊图片"
            onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void addImages(files) }} />
          <Button size="icon" variant="ghost" aria-label="添加图片" title="添加图片" disabled={loadingImages || pending} onClick={() => fileInput.current?.click()}><ImagePlus className="size-4" /></Button>
          <div className="min-w-0 flex-1 overflow-hidden">
            <ModelSelector externalSelectedModel={model} onModelSelect={(option) => setDraft((current) => ({
              ...current, model: { channelId: option.channelId, modelId: option.modelId },
            }))} />
          </div>
          {running ? (
            <Button size="icon" variant="ghost" className={inputToolbarDangerButtonClass} aria-label="停止" title="停止" onClick={() => {
              void window.electronAPI.stopSideChat(parentSessionId).catch((cause: unknown) => setError(String(cause)))
            }}><Square className="size-4" /></Button>
          ) : (
            <Button size="icon" variant="ghost" className={inputToolbarSendButtonClass} aria-label="发送" title="发送" disabled={pending || loadingImages || !view || (!draft.text.trim() && !images.length)} onClick={() => void send()}><CornerDownLeft className="size-4" /></Button>
          )}
        </div>
      </div>
    </section>
  )
}
