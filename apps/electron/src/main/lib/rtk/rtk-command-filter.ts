import type { ShellAnalysis } from '../execution-policy/shell-analysis.ts'

export type RtkFilter = 'git-status' | 'git-log' | 'tsc' | 'vitest' | 'bun-test' | 'typecheck-script'

/** 只选择输出格式；不授权、不重写、不执行命令。未知参数保持原始结果。 */
export function selectRtkFilter(analysis: ShellAnalysis): RtkFilter | undefined {
  if (analysis.status !== 'static' || analysis.stages.length !== 1 || analysis.operators.length) return
  const stage = analysis.stages[0]!
  if (stage.provenance !== 'top-level' || !stage.argumentsStatic || stage.redirects.length || stage.environment.length) return
  const { executable } = stage
  const argv = stage.argv.slice(1)
  if (executable === 'git') {
    const [subcommand, ...args] = argv
    if (subcommand === 'status' && args.every(arg => ['--short', '-s', '--branch', '-b'].includes(arg))) return 'git-status'
    if (subcommand === 'log' && args.every(arg => arg === '--oneline' || /^-[1-9]\d{0,3}$/.test(arg))) return 'git-log'
    return
  }
  if (executable === 'bun') {
    const args = [...argv]
    const cwdIndex = args.indexOf('--cwd')
    if (cwdIndex >= 0) {
      if (!args[cwdIndex + 1] || args[cwdIndex + 1]!.startsWith('-')) return
      args.splice(cwdIndex, 2)
    }
    if (args[0] === 'test' && args.slice(1).every(arg => !arg.startsWith('-'))) return 'bun-test'
    if (args.length === 2 && args[0] === 'run' && args[1] === 'typecheck') return 'typecheck-script'
  }
  const tool = executable === 'bun' && argv[0] === 'x' ? argv[1] : executable
  const args = executable === 'bun' ? argv.slice(2) : argv
  if (tool === 'tsc' && args.length > 0 && args.every(arg => ['--noEmit', '--pretty', 'false'].includes(arg))) return 'tsc'
  if (tool === 'vitest' && args.length === 1 && args[0] === 'run') return 'vitest'
}
