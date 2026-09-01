import type { AgentStopSource } from './agent-stop-source.ts'

/** 将停止请求绑定到具体 run generation，避免迟到请求污染后续运行。 */
export class AgentStopTracker {
  private readonly records = new Map<string, { generation: number; source: AgentStopSource }>()

  request(sessionId: string, generation: number | undefined, source: AgentStopSource): boolean {
    if (generation === undefined) return false
    this.records.set(sessionId, { generation, source })
    return true
  }

  has(sessionId: string): boolean {
    return this.records.has(sessionId)
  }

  consume(sessionId: string, generation: number): AgentStopSource | undefined {
    const record = this.records.get(sessionId)
    if (!record || record.generation !== generation) return undefined
    this.records.delete(sessionId)
    return record.source
  }

  clear(): void {
    this.records.clear()
  }
}
