import { delimiter } from 'node:path'

// 改编自 ZCode packages/services/src/terminal/terminalService.ts 的 resolveTerminalEnv。
const DARWIN_GUI_FALLBACK_PATHS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
] as const

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? '')
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toUpperCase()
  return normalized === '' || normalized === 'C' || normalized === 'POSIX'
}

function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const value of entries) {
    for (const path of value?.split(delimiter) ?? []) {
      const entry = path.trim()
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      merged.push(entry)
    }
  }
  return merged.join(delimiter)
}

/** 只修改交给 PTY 的副本；Agent 命令环境保持宿主原有策略。 */
export function resolveTerminalSpawnEnv(
  env: NodeJS.ProcessEnv,
  platform: string,
  mode: 'interactive-shell' | 'agent-command',
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, TERM: 'xterm-256color', COLORTERM: env.COLORTERM?.trim() || 'truecolor' }
  if (mode !== 'interactive-shell') return next

  if (platform === 'darwin') next.PATH = mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS])
  if (next.CI === '1' && env.TERM === 'dumb') delete next.CI
  const fallback = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale)
    ?? (platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8')
  if (isMissingOrCLocale(next.LANG)) next.LANG = fallback
  if (isMissingOrCLocale(next.LC_CTYPE)) next.LC_CTYPE = fallback
  if (next.LC_ALL !== undefined && isMissingOrCLocale(next.LC_ALL)) next.LC_ALL = fallback
  return next
}
