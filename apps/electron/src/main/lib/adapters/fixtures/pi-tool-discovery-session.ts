import { Type } from 'typebox'
import * as sdk from '@earendil-works/pi-coding-agent'
import type { AgentSession, InlineExtension, SessionManager, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { AssistantMessage, JsonObject, Model, Tool } from '@earendil-works/pi-ai'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import type { PermissionResult } from '../../agent-permission-service.ts'
import type { PiRunAuditRecorder } from '../../audit/pi-run-audit.ts'
import type { PiFinalToolAuthorizationRequest } from '../pi-final-tool-guard.ts'
import { installPiFinalToolGuard } from '../pi-final-tool-guard.ts'
import { preparePiMcpToolDiscovery } from '../pi-mcp-tool-discovery.ts'

export const DISCOVERY_MODEL: Model<'openai-completions'> = {
  id: 'discovery-test', name: 'Offline discovery test', provider: 'domi-discovery-test', api: 'openai-completions',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

export function discoveryTool(name: string, description = 'Search documents'): ToolDefinition {
  return { name, label: name, description, parameters: Type.Object({
    query: Type.Optional(Type.String({ description: 'Document lookup keywords' })),
  }), async execute() { return { content: [{ type: 'text', text: `${name}: completed` }], details: {} } } }
}

export const DISCOVERY_CORE_TOOLS = ['Read', 'Bash', 'AskUserQuestion', 'CompactContext', 'ReadyForReview', 'FinishWorktree']
  .map(name => discoveryTool(name, 'Domi core tool'))

interface DiscoverySessionOptions {
  tools: ToolDefinition[]
  enabled?: boolean
  manager?: SessionManager
  factories?: InlineExtension[]
  auditRecorder?: PiRunAuditRecorder
  authorize?: (request: PiFinalToolAuthorizationRequest) => boolean | PermissionResult | Promise<boolean | PermissionResult>
}

export async function discoverySession(options: DiscoverySessionOptions) {
  const cwd = process.cwd()
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } })
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  })
  modelRuntime.registerProvider(DISCOVERY_MODEL.provider, {
    api: DISCOVERY_MODEL.api, baseUrl: DISCOVERY_MODEL.baseUrl, apiKey: 'offline-placeholder', models: [DISCOVERY_MODEL],
  })
  const toolSources = Object.fromEntries(options.tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => [tool.name, 'mcp']))
  const plan = preparePiMcpToolDiscovery({ ...sdk, getCurrentTools }, { enabled: options.enabled, tools: options.tools, toolSources })
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: settings, noExtensions: true,
    disabledBuiltinExtensions: ['mcp', 'codemode'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...(options.factories ?? []), ...plan.extensionFactories],
  })
  await loader.reload()
  const { session } = await sdk.createAgentSession({
    cwd, agentDir: cwd, model: DISCOVERY_MODEL, modelRuntime, settingsManager: settings, resourceLoader: loader,
    sessionManager: options.manager ?? sdk.SessionManager.inMemory(cwd), noTools: 'builtin', customTools: plan.tools,
  })
  try {
    plan.initialize(session)
    await session.bindExtensions({})
  } catch (error) { session.dispose(); throw error }
  const authorized: PiFinalToolAuthorizationRequest[] = []
  const guard = installPiFinalToolGuard(session, {
    cwd, auditRecorder: options.auditRecorder,
    validateArguments: (definition, args) => validateToolArguments(definition,
      { type: 'toolCall', id: 'verification', name: definition.name, arguments: args as JsonObject }),
    resolveToolSource: name => plan.isOwnedTool(session, name) ? 'host' : toolSources[name] === 'mcp' ? 'mcp' : 'resource',
    authorize: async request => {
      authorized.push(request)
      const allowed = options.authorize ? await options.authorize(request) : true
      return typeof allowed === 'boolean'
        ? allowed ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'offline policy denied' }
        : allowed
    },
  })
  return { session, plan, modelRuntime, authorized, guard }
}

export interface DiscoveryCall {
  name: string
  arguments: JsonObject
}

/** 仅模拟 Provider；工具发现、原生投影、授权和 MCP 调用均走真实 Session 生命周期。 */
export function scriptDiscoveryRun(
  session: AgentSession,
  responses: DiscoveryCall[][] | ((declarations: Tool[][]) => DiscoveryCall[]),
) {
  const declarations: Tool[][] = []
  session.agent.streamFunction = (model, context) => {
    const ordinal = declarations.length
    declarations.push(getCurrentTools(context.messages))
    const calls = typeof responses === 'function' ? responses(declarations) : responses[ordinal] ?? []
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: calls.length ? calls.map((call, index) => ({ type: 'toolCall', id: `call-${ordinal}-${index}`, ...call }))
        : [{ type: 'text', text: '完成' }],
      stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const stream = createAssistantMessageEventStream()
    stream.end(message)
    return stream
  }
  return declarations
}
