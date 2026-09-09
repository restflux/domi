import type { createStore } from 'jotai'
import type { SideChatSendInput } from '@domi/shared'
import { sideChatDraftAtomFamily, sideChatOperationAtomFamily, sideChatViewAtomFamily } from '@/atoms/side-chat-atoms'
import { sideChatImagesAtomFamily, sideChatImageLoadingAtomFamily, sideChatComposerErrorAtomFamily, removeSentSideChatImages } from './side-chat-images'
import { sideChatSendInput } from './side-chat-behavior'

/** 整次提交固定父会话与草稿快照，异步返回不会读写当前前台会话。 */
export async function sendSideChatDraft(store: ReturnType<typeof createStore>, parentId: string, running: boolean, send: (input: SideChatSendInput) => Promise<void>): Promise<void> {
  const operationAtom = sideChatOperationAtomFamily(parentId)
  const draftAtom = sideChatDraftAtomFamily(parentId)
  const imagesAtom = sideChatImagesAtomFamily(parentId)
  const viewAtom = sideChatViewAtomFamily(parentId)
  const errorAtom = sideChatComposerErrorAtomFamily(parentId)
  const sent = store.get(draftAtom)
  const sentImages = store.get(imagesAtom)
  if (store.get(operationAtom).sending || store.get(sideChatImageLoadingAtomFamily(parentId)) || running || (!sent.text.trim() && !sentImages.length) || !store.get(viewAtom)) return
  store.set(operationAtom, (current) => ({ sending: true, revision: current.revision + 1 }))
  store.set(errorAtom, '')
  const revision = store.get(operationAtom).revision
  try {
    await send(sideChatSendInput(parentId, sent, sentImages))
    store.set(imagesAtom, (current) => removeSentSideChatImages(current, sentImages))
    store.set(draftAtom, (current) => ({ ...current, text: current.text === sent.text ? '' : current.text, quotedText: current.quotedText === sent.quotedText ? '' : current.quotedText }))
    if (store.get(operationAtom).revision === revision) {
      store.set(viewAtom, (current) => current ? { ...current, isRunning: true } : current)
    }
  } catch (cause) { store.set(errorAtom, String(cause)) }
  finally { store.set(operationAtom, (current) => ({ ...current, sending: false })) }
}
