/** 快照与订阅事件可能在 IPC 间交错；已包含在快照中的序列不能重复写入 xterm。 */
export function shouldWriteTerminalOutput(sequence: number, lastSequence: number): boolean {
  return sequence > lastSequence
}
