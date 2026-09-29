import { atom } from 'jotai'
import type { AppLanguage } from '../../types'

/** 当前应用界面语言；持久化由主进程 settings.json 负责。 */
export const localeAtom = atom<AppLanguage>('zh-CN')
