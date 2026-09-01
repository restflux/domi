import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { planFocusedValidation } from '../focused-validation/plan.ts'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface PiFocusedValidationToolsContext {
  agentCwd?: string
}

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

/** Build the read-only Domi product tool that plans bounded Bun tests and package typechecks. */
export function buildPiFocusedValidationTools(
  sdk: PiSdk,
  ctx: PiFocusedValidationToolsContext,
): ToolDefinition[] {
  if (!ctx.agentCwd) return []
  const projectRoot = ctx.agentCwd
  return [sdk.defineTool({
    name: 'PlanFocusedValidation',
    label: '规划聚焦验证',
    description: 'Read the current Session Target and deterministically plan bounded Bun tests plus safe affected-workspace typecheck commands for project-relative changed files. This tool only returns a plan: it never executes commands, writes files, changes review state, or reports a pass.',
    promptSnippet: 'PlanFocusedValidation: provide only project-relative changedFiles. Domi fixes projectRoot to the current Session Target and returns bounded test and affected-package typecheck plans without executing them.',
    parameters: Type.Object({
      changedFiles: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        minItems: 1,
        maxItems: 500,
        description: 'Changed file paths relative to the current Session Target. Absolute paths, parent traversal, and NUL bytes are rejected.',
      }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      return jsonToolResult(await planFocusedValidation({
        projectRoot,
        changedFiles: params.changedFiles,
        signal,
      }))
    },
  })] as unknown as ToolDefinition[]
}
