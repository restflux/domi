import type { createStore } from 'jotai'
import type { SideChatSendInput } from '@domi/shared'
import { sideChatDraftAtomFamily, sideChatOperationAtomFamily, sideChatChildrenMapAtom } from '@/atoms/side-chat-atoms'
import { sideChatImagesAtomFamily, sideChatImageLoadingAtomFamily, sideChatComposerErrorAtomFamily, removeSentSideChatImages } from './side-chat-images'
import { sideChatSendInput } from './side-chat-behavior'

/** 整次提交固定父会话与草稿快照，异步返回不会读写当前前台会话。 */
export async function sendSideChatDraft(
  store: ReturnType<typeof createStore>,
  parentSessionId: string,
  childSessionId: string,
  running: boolean,
  send: (input: SideChatSendInput) => Promise<void>,
  serializeMessage: (text: string) => string = (text) => text,
): Promise<void> {
  const operationAtom = sideChatOperationAtomFamily(childSessionId)
  const draftAtom = sideChatDraftAtomFamily(childSessionId)
  const imagesAtom = sideChatImagesAtomFamily(childSessionId)
  const errorAtom = sideChatComposerErrorAtomFamily(childSessionId)
  const sent = store.get(draftAtom)
  const sentImages = store.get(imagesAtom)
  const serializedMessage = serializeMessage(sent.text.trim())
  if (store.get(operationAtom).sending || store.get(sideChatImageLoadingAtomFamily(childSessionId)) || running || (!serializedMessage && !sentImages.length)) return
  store.set(operationAtom, (current) => ({ sending: true, revision: current.revision + 1 }))
  store.set(errorAtom, '')
  const revision = store.get(operationAtom).revision
  try {
    const payload = sideChatSendInput(parentSessionId, childSessionId, sent, sentImages)
    await send(serializedMessage === payload.message
      ? payload
      : { ...payload, message: serializedMessage })
    store.set(imagesAtom, (current) => removeSentSideChatImages(current, sentImages))
    store.set(draftAtom, (current) => ({ ...current, text: current.text === sent.text ? '' : current.text }))
    if (store.get(operationAtom).revision === revision) {
      const children = store.get(sideChatChildrenMapAtom).get(parentSessionId) ?? []
      const index = children.findIndex(view => view.sessionId === childSessionId)
      if (index >= -1 && children[index]) {
        const next = children.map((view, i) => (i === index ? { ...view, isRunning: true } : view))
        store.set(sideChatChildrenMapAtom, new Map(store.get(sideChatChildrenMapAtom)).set(parentSessionId, next))
      }
    }
  } catch (cause) { store.set(errorAtom, String(cause)) }
  finally { store.set(operationAtom, (current) => ({ ...current, sending: false })) }
}
