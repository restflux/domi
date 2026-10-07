import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'

type Executor = ToolDefinition['execute']
type SessionView = ExtensionContext['sessionManager']

interface ProtectedDefinition {
  original: Executor
  execute: Executor
  owners: WeakMap<SessionView, Executor>
  shape: string
  prepareArguments: ToolDefinition['prepareArguments']
  invalidated: boolean
}

function definitionShape(definition: ToolDefinition): string {
  return JSON.stringify([definition.name, definition.parameters, definition.outputSchema,
    definition.annotations, definition.executionMode, definition.exposure, definition.namespace])
}

// 同一个定义可被多个Session复用；包装不能把它永久绑定到最后一个会话的许可。
const protectedDefinitions = new WeakMap<ToolDefinition, ProtectedDefinition>()

/** 不可重定义的外部定义保持原直接路径；不得进入宿主只读脚本。 */
export function canBindPiToolDefinitionGuard(definition: ToolDefinition): boolean {
  return protectedDefinitions.has(definition)
    || (Object.getOwnPropertyDescriptor(definition, 'execute')?.configurable ?? Object.isExtensible(definition))
}

/** 只保护公开定义的执行入口；实际调用仍由Pi pipeline发起。 */
export function bindPiToolDefinitionGuard(
  definition: ToolDefinition,
  manager: SessionView,
  protect: (execute: Executor) => Executor,
): () => void {
  let entry = protectedDefinitions.get(definition)
  if (!entry) {
    const owners = new WeakMap<SessionView, Executor>()
    entry = {
      original: definition.execute.bind(definition), owners,
      shape: definitionShape(definition), prepareArguments: definition.prepareArguments,
      invalidated: false,
      async execute(...args: Parameters<Executor>) {
        const context = args[4]
        const execute = context && owners.get(context.sessionManager)
        if (!execute) throw new Error('工具定义没有当前Session的最终授权owner，已保守拒绝')
        return execute(...args)
      },
    }
    const registered = entry
    // SDK包装在执行时读取definition.execute；普通赋值不能撤掉正在使用的门禁。
    // 更换实现会使本轮定义失效，而不是让新实现继承旧许可。
    Object.defineProperty(definition, 'execute', {
      configurable: false, enumerable: Object.getOwnPropertyDescriptor(definition, 'execute')?.enumerable ?? true,
      get: () => registered.execute,
      set: (next: Executor) => { if (next !== registered.execute) registered.invalidated = true },
    })
    protectedDefinitions.set(definition, entry)
  }
  if (entry.invalidated || definition.execute !== entry.execute || definitionShape(definition) !== entry.shape
    || definition.prepareArguments !== entry.prepareArguments || entry.owners.has(manager)) {
    throw new Error('工具执行定义发生变化或Session owner重复，已保守拒绝')
  }
  entry.owners.set(manager, protect(entry.original))
  const registered = entry
  let released = false
  return () => {
    if (released) return
    released = true
    registered.owners.delete(manager)
    // 入口不能由前置hook撤掉；仅撤销当前Session owner，弱引用不会保活Session。
    // 下一Session可重新绑定同一未变化的定义；无owner的入口保守拒绝。
  }
}

/** 对象相同不等于执行入口/校验合同未变；许可只能消费原来绑定的定义。 */
export function isPiToolDefinitionGuardCurrent(definition: ToolDefinition, manager: SessionView): boolean {
  const entry = protectedDefinitions.get(definition)
  return entry !== undefined && !entry.invalidated && entry.owners.has(manager) && definition.execute === entry.execute
    && definitionShape(definition) === entry.shape && definition.prepareArguments === entry.prepareArguments
}
