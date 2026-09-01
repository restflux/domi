import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024
const SENSITIVE_KEY_PATTERN = /(authorization|api.?key|secret|token|password|prompt|message|content|tool.?input|tool.?output|environment|env)/i

export interface RuntimeDiagnosticsOptions {
  directory: string
  appVersion: string
  pid?: number
  maxLogBytes?: number
  now?: () => number
  warn?: (message: string, error?: unknown) => void
}

interface RuntimeStateMarker {
  status: 'running' | 'clean'
  pid: number
  appVersion: string
  startedAt: number
  updatedAt: number
}

export interface RuntimeDiagnostics {
  logPath: string
  statePath: string
  record(event: string, details?: Record<string, unknown>): void
  recordStart(): void
  recordCleanShutdown(): void
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[max-depth]'
  if (value == null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? value.slice(0, 1_000) : value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeDiagnosticValue(item, depth + 1))
  }
  if (typeof value !== 'object') return String(value)

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[redacted]'
      : sanitizeDiagnosticValue(item, depth + 1)
  }
  return result
}

function readRuntimeState(path: string): RuntimeStateMarker | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeStateMarker>
    if ((parsed.status !== 'running' && parsed.status !== 'clean')
      || typeof parsed.pid !== 'number'
      || typeof parsed.startedAt !== 'number'
      || typeof parsed.updatedAt !== 'number'
      || typeof parsed.appVersion !== 'string') {
      return null
    }
    return parsed as RuntimeStateMarker
  } catch {
    return null
  }
}

export function describeDiagnosticError(error: unknown): Record<string, unknown> {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  return {
    name,
    messageLength: message.length,
    messageHash: createHash('sha256').update(message).digest('hex').slice(0, 16),
  }
}

export function createRuntimeDiagnostics(options: RuntimeDiagnosticsOptions): RuntimeDiagnostics {
  const pid = options.pid ?? process.pid
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
  const now = options.now ?? Date.now
  const warn = options.warn ?? ((message, error) => console.warn(message, error))
  const logPath = join(options.directory, 'runtime-events.jsonl')
  const rotatedLogPath = `${logPath}.1`
  const statePath = join(options.directory, 'runtime-state.json')
  let currentStartedAt: number | null = null

  const ensureDirectory = (): void => {
    mkdirSync(options.directory, { recursive: true })
  }

  const record = (event: string, details: Record<string, unknown> = {}): void => {
    try {
      ensureDirectory()
      const line = `${JSON.stringify({
        timestamp: new Date(now()).toISOString(),
        event,
        appVersion: options.appVersion,
        pid,
        details: sanitizeDiagnosticValue(details),
      })}\n`
      if (existsSync(logPath) && statSync(logPath).size + Buffer.byteLength(line) > maxLogBytes) {
        rmSync(rotatedLogPath, { force: true })
        renameSync(logPath, rotatedLogPath)
      }
      appendFileSync(logPath, line, 'utf8')
    } catch (error) {
      warn('[运行时诊断] 写入日志失败', error)
    }
  }

  const writeState = (state: RuntimeStateMarker): void => {
    try {
      ensureDirectory()
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      warn('[运行时诊断] 写入状态标记失败', error)
    }
  }

  const recordStart = (): void => {
    const startedAt = now()
    const previous = readRuntimeState(statePath)
    if (previous?.status === 'running') {
      record('previous_unclean_exit', {
        previousPid: previous.pid,
        previousAppVersion: previous.appVersion,
        previousStartedAt: previous.startedAt,
        previousUpdatedAt: previous.updatedAt,
      })
    }
    currentStartedAt = startedAt
    writeState({
      status: 'running',
      pid,
      appVersion: options.appVersion,
      startedAt,
      updatedAt: startedAt,
    })
    record('runtime_start')
  }

  const recordCleanShutdown = (): void => {
    const updatedAt = now()
    const previous = readRuntimeState(statePath)
    writeState({
      status: 'clean',
      pid,
      appVersion: options.appVersion,
      startedAt: currentStartedAt ?? previous?.startedAt ?? updatedAt,
      updatedAt,
    })
    record('runtime_clean_shutdown')
  }

  return {
    logPath,
    statePath,
    record,
    recordStart,
    recordCleanShutdown,
  }
}
