import * as React from 'react'
import { useAtomValue } from 'jotai'
import { userProfileAtom } from '@/atoms/user-profile'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { Check, Copy, CornerUpLeft } from 'lucide-react'
import { Message, MessageHeader, MessageContent, MessageResponse, MessageActions, MessageAction } from '@/components/ai-elements/message'
import { BrandLogo } from '@/components/ui/brand-logo'
import { getModelLogo } from '@/lib/model-logo'

import { parseAttachedFiles, isImageFile } from '@/lib/message-attachments'
import { AttachedImageThumb } from '../AttachedImageThumb'
import { ImageLightbox } from '@/components/ui/image-lightbox'

interface SideChatMessageProps {
  role: 'user' | 'assistant'
  text: string
  modelId?: string
  handoffDisabled: boolean
  onHandoff: (text: string) => void
  onError: (error: unknown) => void
}

/** 复用主会话消息原语；侧聊只展示可见正文，不挂载主任务的执行操作。 */
export function SideChatMessage({ role, text, modelId, handoffDisabled, onHandoff, onError }: SideChatMessageProps): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  // 只解析用户附件引用，助手正文不能伪造附件加载请求。
  const parsed = role === 'user' ? parseAttachedFiles(text) : { text, files: [] }
  const imageFiles = parsed.files.filter((file) => isImageFile(file.filename))
  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  const [lightboxIndex, setLightboxIndex] = React.useState(0)
  const [loaded, setLoaded] = React.useState<Record<string, string>>({})
  const onLoaded = React.useCallback((path: string, src: string) => setLoaded((current) => ({ ...current, [path]: src })), [])
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const logo = getModelLogo(modelId ?? '')
  return (
    <Message from={role}>
      {role === 'user' ? (
        <div className="mb-2.5 flex items-center gap-2.5">
          <UserAvatar avatar={userProfile.avatar} size={35} />
          <span className="text-sm font-semibold text-foreground/60">{userProfile.userName}</span>
        </div>
      ) : <MessageHeader model={modelId ?? '助手'} logo={<BrandLogo src={logo} className="size-7" />} />}
      <MessageContent className="pl-0">
        <div className={role === 'user' ? 'max-w-full rounded-lg bg-muted px-3 py-2' : 'min-w-0'}>
          {imageFiles.length > 0 && <div className="mb-2 flex flex-wrap gap-2">
            {imageFiles.map((file, index) => <AttachedImageThumb key={file.path} file={file} index={index} onLoaded={onLoaded}
              onOpen={(next) => { setLightboxIndex(next); setLightboxOpen(true) }} />)}
          </div>}
          {parsed.text && <MessageResponse>{parsed.text}</MessageResponse>}
          <ImageLightbox open={lightboxOpen} onOpenChange={setLightboxOpen} index={lightboxIndex} onIndexChange={setLightboxIndex}
            images={imageFiles.map((file) => ({ src: loaded[file.path] ?? '', alt: file.filename }))} />
        </div>
        <MessageActions>
          {parsed.text && <MessageAction tooltip={copied ? '已复制' : '复制'} onClick={() => {
            void navigator.clipboard.writeText(parsed.text).then(() => setCopied(true)).catch(onError)
          }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</MessageAction>}
          {role === 'assistant' && (
            <MessageAction tooltip="交给主助手" disabled={handoffDisabled} onClick={() => onHandoff(text)}>
              <CornerUpLeft className="size-3.5" />
            </MessageAction>
          )}
        </MessageActions>
      </MessageContent>
    </Message>
  )
}
