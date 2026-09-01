import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSensitiveDataKey, redactSensitiveString } from '../security/sensitive-data.ts'

export interface AuditEvent {
  category: string
  action: string
  timestamp?: string
  data?: Record<string, unknown>
}

export interface AuditRecord {
  version: 1
  timestamp: string
  category: string
  action: string
  data: Record<string, unknown>
}

export interface AuditWriteResult {
  written: boolean
  errorCategory?: 'write_failed'
}

export interface AuditEvidence {
  records: AuditRecord[]
  corruptLines: number
  errorCategory?: 'read_failed'
}

export interface AuditSink {
  append(line: string): Promise<void>
}

export interface AuditWriterOptions {
  auditDir: string
  fileName?: string
  maxEventBytes?: number
  sink?: AuditSink
}

const DEFAULT_MAX_EVENT_BYTES = 16 * 1024
const MAX_STRING_CHARS = 2_048
const MAX_OUTPUT_CHARS = 512
const ENVIRONMENT_KEY = /^(?:env|environment|processEnv|environmentVariables)$/i
const COMMAND_OUTPUT_KEY = /^(?:stdout|stderr|output|commandOutput)$/i

class FileAuditSink implements AuditSink {
  constructor(private readonly path: string, private readonly auditDir: string) {}

  async append(line: string): Promise<void> {
    await mkdir(this.auditDir, { recursive: true })
    const file = await open(this.path, 'a+')
    try {
      const { size } = await file.stat()
      let separator = ''
      if (size > 0) {
        const tail = Buffer.allocUnsafe(1)
        await file.read(tail, 0, 1, size - 1)
        if (tail[0] !== 0x0a) separator = '\n'
      }
      await file.writeFile(`${separator}${line}`, 'utf8')
    } finally {
      await file.close()
    }
  }
}

function truncateCharacters(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 13))}[TRUNCATED]` : value
}

function redactString(raw: string, maxChars = MAX_STRING_CHARS): string {
  return truncateCharacters(redactSensitiveString(raw), maxChars)
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth = 0, key = ''): unknown {
  if (isSensitiveDataKey(key) || ENVIRONMENT_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactString(value, COMMAND_OUTPUT_KEY.test(key) ? MAX_OUTPUT_CHARS : MAX_STRING_CHARS)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return `[${typeof value}]`
  if (depth >= 8) return '[TRUNCATED]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, seen, depth + 1))
  }

  const sanitized: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    sanitized[childKey] = sanitizeValue(childValue, seen, depth + 1, childKey)
  }
  return sanitized
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  return value.slice(0, low)
}

function serializeWithinLimit(record: AuditRecord, maxBytes: number): string {
  const serialized = JSON.stringify(record)
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized

  const dataPreview = JSON.stringify(record.data)
  const limited: AuditRecord = {
    ...record,
    data: {
      truncated: true,
      preview: truncateUtf8(dataPreview, Math.max(32, Math.floor(maxBytes / 2))),
    },
  }
  let result = JSON.stringify(limited)
  if (Buffer.byteLength(result, 'utf8') <= maxBytes) return result

  limited.data = { truncated: true }
  result = JSON.stringify(limited)
  if (Buffer.byteLength(result, 'utf8') <= maxBytes) return result

  limited.category = truncateUtf8(limited.category, 64)
  limited.action = truncateUtf8(limited.action, 64)
  return truncateUtf8(JSON.stringify(limited), maxBytes)
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<AuditRecord>
  return record.version === 1
    && typeof record.timestamp === 'string'
    && typeof record.category === 'string'
    && typeof record.action === 'string'
    && !!record.data
    && typeof record.data === 'object'
}

export class AuditWriter {
  readonly filePath: string
  private readonly sink: AuditSink
  private readonly maxEventBytes: number
  private queue: Promise<void> = Promise.resolve()

  constructor(options: AuditWriterOptions) {
    this.filePath = join(options.auditDir, options.fileName ?? 'events.jsonl')
    this.sink = options.sink ?? new FileAuditSink(this.filePath, options.auditDir)
    this.maxEventBytes = Math.max(512, options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES)
  }

  async record(event: AuditEvent): Promise<AuditWriteResult> {
    const data = sanitizeValue(event.data ?? {}, new WeakSet()) as Record<string, unknown>
    const suppliedTimestamp = event.timestamp && Number.isFinite(Date.parse(event.timestamp))
      ? event.timestamp
      : undefined
    const record: AuditRecord = {
      version: 1,
      timestamp: suppliedTimestamp ?? new Date().toISOString(),
      category: redactString(event.category, 128),
      action: redactString(event.action, 128),
      data,
    }
    const line = `${serializeWithinLimit(record, this.maxEventBytes)}\n`
    let result: AuditWriteResult = { written: true }

    this.queue = this.queue.then(async () => {
      try {
        await this.sink.append(line)
      } catch {
        result = { written: false, errorCategory: 'write_failed' }
      }
    })
    await this.queue
    return result
  }

  async readEvidence(): Promise<AuditEvidence> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], corruptLines: 0 }
      return { records: [], corruptLines: 0, errorCategory: 'read_failed' }
    }

    const records: AuditRecord[] = []
    let corruptLines = 0
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isAuditRecord(parsed)) records.push(parsed)
        else corruptLines += 1
      } catch {
        corruptLines += 1
      }
    }
    return { records, corruptLines }
  }
}
