/** Bun 没有 RTK 0.48.0 原生 pipe filter；仅折叠完整成功报告里的逐条通过记录。 */
export function compactBunTestOutput(text: string): string | undefined {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n')
  const lines = clean.split('\n')
  if (!/^bun test v\d+\.\d+\.\d+[^\n]*\n/.test(clean)) return
  const pass = [...clean.matchAll(/^\s*(\d+) pass\s*$/gm)]
  const fail = [...clean.matchAll(/^\s*(\d+) fail\s*$/gm)]
  if (pass.length !== 1 || fail.length !== 1 || fail[0]![1] !== '0') return
  if (!/^Ran \d+ tests? across \d+ files?\. \[[^\]\n]+\]\s*$/.test(lines.filter(line => line.trim()).at(-1) ?? '')) return
  const isPass = (line: string): boolean => /^\(pass\) \S.*$/.test(line)
  const count = lines.filter(isPass).length
  if (count === 0 || count !== Number(pass[0]![1])) return
  // 只删除经过计数核对的 pass 行；警告、skip、文件名、汇总及任意其他文本原样保留。
  return lines.filter(line => !isPass(line)).join('\n')
}

/** 只省略成功 typecheck 脚本的已知 tsc 回显，不解释或执行 package.json 脚本。 */
export function compactTypecheckOutput(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const echo = /^\$ tsc --noEmit(?: --pretty false)?$/
  const count = lines.filter(line => echo.test(line)).length
  if (!count) return
  return [`[已省略 ${count} 行 tsc 命令回显]`, ...lines.filter(line => !echo.test(line))].join('\n')
}
