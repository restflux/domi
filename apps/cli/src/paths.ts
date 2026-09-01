/**
 * 会话存储路径解析（electron-free）。
 *
 * Domi 主进程用 config-paths.ts 里的 getConfigDir()，其中通过 require('electron')
 * 判断 isPackaged 来在 .domi / .domi-dev 间切换——CLI 没有 electron 运行时，
 * 因此这里独立实现等价的运行模式判断：
 *   - 默认 ~/.domi
 *   - 兼容环境变量 DOMI_DEV=1 → ~/.domi-dev
 *   - 显式 configDir 覆盖（CLI 的 --config-dir）优先级最高
 *
 * 与 config-paths.ts 的目录布局保持一致：
 *   <configDir>/agent-sessions.json        会话索引
 *   <configDir>/agent-sessions/<id>.jsonl   单会话消息
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR_NAME, DEV_CONFIG_DIR_NAME } from '@domi/shared/config'

export interface PathOptions {
  /** 显式指定配置目录（绝对路径）。优先级最高。 */
  configDir?: string
  /** 使用开发目录 .domi-dev（等价于 DOMI_DEV=1）。 */
  dev?: boolean
}

export function resolveConfigDir(opts: PathOptions = {}): string {
  if (opts.configDir) return opts.configDir
  const useDev = opts.dev || process.env.DOMI_DEV === '1'
  return join(homedir(), useDev ? DEV_CONFIG_DIR_NAME : CONFIG_DIR_NAME)
}

export function getSessionsIndexPath(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions.json')
}

export function getSessionsDir(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions')
}

export function getSessionMessagesPath(id: string, opts: PathOptions = {}): string {
  return join(getSessionsDir(opts), `${id}.jsonl`)
}
