/**
 * 为 Agent run 生成进程内唯一、严格单调的授权 token，并记录一次性执行 lease。
 * 时间戳不能承担授权身份：同一毫秒启动的前后 run 必须仍然可区分。
 */
export class AgentRunExecutionLeaseRegistry {
  private nextToken = 0
  private leases = new Map<string, number>()

  createRunToken(): number {
    if (this.nextToken >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Agent run token 已耗尽，请重启应用')
    }
    this.nextToken += 1
    return this.nextToken
  }

  grant(sessionId: string, runToken: number): void {
    this.leases.set(sessionId, runToken)
  }

  revoke(sessionId: string, runToken: number): boolean {
    if (this.leases.get(sessionId) !== runToken) return false
    this.leases.delete(sessionId)
    return true
  }

  owns(sessionId: string, runToken: number): boolean {
    return this.leases.get(sessionId) === runToken
  }

  clearSession(sessionId: string): void {
    this.leases.delete(sessionId)
  }

  clear(): void {
    this.leases.clear()
  }
}
