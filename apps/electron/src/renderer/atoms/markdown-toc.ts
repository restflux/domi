import { atom } from 'jotai'

/** Markdown 预览目录（TOC）是否固定占位：仅本次运行记忆，重启后默认使用悬浮目录 */
export const markdownTocPinnedAtom = atom<boolean>(false)
