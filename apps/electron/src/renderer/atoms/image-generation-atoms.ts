import { atom } from 'jotai'
import type { Channel, ImageGenerationSelection } from '@domi/shared'

export const imageGenerationChannelsAtom = atom<Channel[]>([])
export const imageGenerationDefaultAtom = atom<ImageGenerationSelection | null>(null)
/** 未出现的会话为普通对话；关闭状态与其他会话完全独立。 */
export const imageGenerationSelectionsAtom = atom<Record<string, ImageGenerationSelection | null>>({})

export { getImageChannels, resolveImageSelection, parseImageCommand } from '@/lib/image-generation-selection'
