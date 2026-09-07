import type { AgentWorkflow } from '@domi/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { analyzeShellCommand } from '../execution-policy/shell-analysis.ts'
import { selectRtkFilter } from '../rtk/rtk-command-filter.ts'
import { optimizeRtkOutput, type RtkOptimizerDependencies } from '../rtk/rtk-output-optimizer.ts'

export interface PiRtkOutputOptions {
  isEnabled(): boolean
  getWorkflow(): AgentWorkflow | undefined
  supportedShell: boolean
  dependencies: RtkOptimizerDependencies
}

/** 每次调用独立记录退出码；SDK 会将 null 退出码当结果返回，不能据此认定成功。 */
export function createRtkBashToolDefinition(
  createTool: (onExit: (code: number | null) => void) => ToolDefinition,
  options: PiRtkOutputOptions,
): ToolDefinition {
  const base = createTool(() => {})
  return {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let exitCode: number | null | undefined
      const tool = createTool(code => { exitCode = code })
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx)
      // 授权与执行全部发生在原路径；失败抛出仍由 SDK 处理，这里只处理确认成功的结果。
      try {
        if (exitCode !== 0 || signal?.aborted || !options.supportedShell
          || options.getWorkflow() !== 'direct' || !options.isEnabled()) return result
        const command = (params as { command?: unknown }).command
        if (typeof command !== 'string' || result.content.length !== 1 || result.content[0]?.type !== 'text') return result
        const details: unknown = result.details
        if (details && typeof details === 'object' && ('truncation' in details || 'fullOutputPath' in details)) return result
        const filter = selectRtkFilter(analyzeShellCommand(command))
        if (!filter) return result
        const optimized = await optimizeRtkOutput(filter, result.content[0].text, options.dependencies, signal)
        if (!optimized) return result
        return {
          ...result,
          content: [{ type: 'text', text: optimized.text }],
          details: { ...(details && typeof details === 'object' ? details : {}), fullOutputPath: optimized.originalPath },
        }
      } catch { return result }
    },
  }
}
