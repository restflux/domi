/**
 * running-terminals-model — 后台服务终端的纯逻辑
 *
 * 顶部入口只关心由 TerminalRun 托管、仍在运行的长期进程。
 * 普通 Bash 工具和 Agent run 状态不代表独立服务，不进入这里。
 */

import type { TerminalSessionView } from '@domi/shared'

export interface TerminalServiceOutputState {
  /** 为处理跨输出分片 URL 保留的有界尾部。 */
  tail: string
  /** 已从终端输出中识别出的本地服务地址。 */
  urls: string[]
}

const EMPTY_SERVICE_OUTPUT_STATE: TerminalServiceOutputState = { tail: '', urls: [] }
const OUTPUT_TAIL_LIMIT = 4_096
const ANSI_ESCAPE_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g
const LOCAL_SERVICE_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\])(?::\d{1,5})?(?:\/[^\s"'<>\u001B]*)?/gi

/** 只保留当前会话内 `kind === 'agent-run'` 且仍在启动/运行的后台终端。 */
export function selectRunningAgentTerminals(
  terminals: readonly TerminalSessionView[],
  ownerSessionId: string,
): TerminalSessionView[] {
  return terminals
    .filter((terminal) => terminal.ownerSessionId === ownerSessionId)
    .filter((terminal) => terminal.kind === 'agent-run')
    .filter((terminal) => terminal.status === 'starting' || terminal.status === 'running')
    .sort((left, right) => left.startedAt - right.startedAt)
}

/**
 * 从终端文本提取可作为本地服务入口的 URL。
 *
 * 仅接受 loopback / wildcard 地址，避免把依赖下载地址或日志中的外部链接误当服务。
 * wildcard 地址统一改写为 127.0.0.1，保证用户点击后可访问。
 */
export function extractLocalServiceUrls(output: string): string[] {
  const text = output.replace(ANSI_ESCAPE_PATTERN, '')
  const candidates = text.match(LOCAL_SERVICE_URL_PATTERN) ?? []
  const urls = candidates
    .map((candidate) => candidate.replace(/[),.;!?]+$/g, ''))
    .map(normalizeLocalServiceUrl)
    .filter((url): url is string => url !== null)
  return [...new Set(urls)]
}

/** 累积终端输出并识别 URL；保留短尾部以覆盖 URL 被 PTY 分片拆开的情况。 */
export function accumulateTerminalServiceOutput(
  previous: TerminalServiceOutputState | undefined,
  chunk: string,
): TerminalServiceOutputState {
  const current = previous ?? EMPTY_SERVICE_OUTPUT_STATE
  const combined = `${current.tail}${chunk}`
  const nextUrls = extractLocalServiceUrls(combined)
  const urls = nextUrls.length > 0
    ? [...new Set([...current.urls, ...nextUrls])]
    : current.urls
  return {
    tail: combined.slice(-OUTPUT_TAIL_LIMIT),
    urls,
  }
}

/** 格式化耗时（起止时间戳 → "X 秒 / X 分钟 / X 小时 X 分钟 / X 天 X 小时"）。 */
export function formatElapsed(from: number | undefined, now: number): string {
  if (!from) return '—'
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

function normalizeLocalServiceUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    const hostname = url.hostname.toLowerCase()
    if (hostname === '0.0.0.0' || hostname === '[::]' || hostname === '::') {
      url.hostname = '127.0.0.1'
    }
    return url.toString()
  } catch {
    return null
  }
}
