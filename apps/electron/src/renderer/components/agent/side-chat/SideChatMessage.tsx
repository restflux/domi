import * as React from 'react'
import { useAtomValue } from 'jotai'
import { userProfileAtom } from '@/atoms/user-profile'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { Check, Copy, CornerUpLeft } from 'lucide-react'
import { Message, MessageHeader, MessageContent, MessageResponse, MessageActions, MessageAction } from '@/components/ai-elements/message'
import { BrandLogo } from '@/components/ui/brand-logo'
import { getModelLogo } from '@/lib/model-logo'

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
          <MessageResponse>{text}</MessageResponse>
        </div>
        <MessageActions>
          <MessageAction tooltip={copied ? '已复制' : '复制'} onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(onError)
          }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</MessageAction>
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
