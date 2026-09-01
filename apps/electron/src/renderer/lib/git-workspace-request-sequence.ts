/** 丢弃快速切换会话/连续刷新时迟到的旧 Git snapshot。 */
export class GitWorkspaceRequestSequence {
  private value = 0

  next(): number {
    this.value += 1
    return this.value
  }

  invalidate(): void {
    this.value += 1
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.value
  }
}
