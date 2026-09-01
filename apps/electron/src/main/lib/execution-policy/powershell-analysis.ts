import { createRequire } from 'node:module'
import { posix, win32 } from 'node:path'
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter'
import type { ShellCommandStage } from './shell-analysis.ts'

export interface PowerShellSourceAnalysis {
  stages: ShellCommandStage[]
  reasonCodes: string[]
  complete: boolean
  readOnly: boolean
}

interface PowerShellAnalysisState {
  variables: Map<string, string>
  knownFunctions: Map<string, SyntaxNode>
  stages: ShellCommandStage[]
  reasonCodes: string[]
}

const require = createRequire(__filename)
let powershellParser: Parser | undefined

const READ_ONLY_POWERSHELL_COMMANDS = new Set([
  'get-content', 'gc', 'cat', 'type',
  'select-string', 'sls',
  'get-childitem', 'gci', 'ls', 'dir',
  'get-item', 'gi',
  'test-path',
  'measure-object', 'measure',
  'sort-object', 'sort',
  'where-object', 'where', '?',
  'foreach-object', 'foreach', '%',
])

const SCRIPT_BLOCK_READ_COMMANDS = new Set(['where-object', 'where', '?', 'foreach-object', 'foreach', '%'])
const UNSAFE_READ_ONLY_SYNTAX = new Set([
  'ERROR', 'assignment_expression', 'redirection', 'invokation_expression', 'type_literal', 'cast_expression',
  'command_invokation_operator', 'function_statement', 'class_statement', 'enum_statement',
  'trap_statement', 'throw_statement', 'exit_statement', 'break_statement', 'continue_statement',
  'if_statement', 'switch_statement', 'foreach_statement', 'for_statement',
  'while_statement', 'do_while_statement', 'do_until_statement', 'try_statement',
  'using_statement', 'param_block', 'dynamic_keyword_statement',
])
let parserPromise: Promise<void> | undefined

export function initializePowerShellAnalysis(): Promise<void> {
  parserPromise ??= (async () => {
    await Parser.init()
    const languagePath = require.resolve('tree-sitter-powershell/tree-sitter-powershell.wasm')
    const language = await Language.load(languagePath)
    powershellParser = new Parser().setLanguage(language)
  })()
  return parserPromise
}

function variableName(text: string): string | undefined {
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/i.exec(text.trim())
  return match?.[1]?.toLowerCase()
}

function decodeVerbatimString(text: string): string | undefined {
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  return undefined
}

function decodeExpandableString(node: SyntaxNode): string | undefined {
  if (node.namedChildren.some((child) => child.type === 'variable' || child.type === 'sub_expression')) return undefined
  const text = node.text
  if (!text.startsWith('"') || !text.endsWith('"')) return undefined
  return text.slice(1, -1).replace(/`([0abfnrtv`"'$])/gi, (_match, escaped: string) => {
    const escapes: Record<string, string> = {
      '0': '\0', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '`': '`', '"': '"', "'": "'", '$': '$',
    }
    return escapes[escaped.toLowerCase()] ?? escaped
  })
}

function staticString(node: SyntaxNode): string | undefined {
  if (node.type === 'verbatim_string_characters') return decodeVerbatimString(node.text)
  if (node.type === 'expandable_string_literal') return decodeExpandableString(node)
  if (node.type === 'string_literal' && node.namedChildren.length === 1) return staticString(node.namedChildren[0]!)
  return undefined
}

function evaluateValues(node: SyntaxNode, variables: ReadonlyMap<string, string>): Array<string | undefined> {
  const literal = staticString(node)
  if (literal !== undefined) return [literal]
  if (node.type === 'variable') return [variables.get(variableName(node.text) ?? '')]
  if (node.type === 'generic_token' || node.type === 'command_parameter') return [node.text]
  if (node.type === 'array_literal_expression') {
    return node.namedChildren.flatMap((child) => evaluateValues(child, variables))
  }
  if (node.namedChildren.length === 1) return evaluateValues(node.namedChildren[0]!, variables)
  return [undefined]
}

function findDirectDescendant(node: SyntaxNode, type: string): SyntaxNode | undefined {
  if (node.type === type) return node
  for (const child of node.namedChildren) {
    const found = findDirectDescendant(child, type)
    if (found) return found
  }
  return undefined
}

function commandName(command: SyntaxNode, variables?: ReadonlyMap<string, string>): string | undefined {
  const nameNode = command.childForFieldName('command_name')
  if (!nameNode) return undefined
  const variable = findDirectDescendant(nameNode, 'variable')
  if (variable) return variables?.get(variableName(variable.text) ?? '')
  if (nameNode.type === 'command_name' || nameNode.type === 'path_command_name') return nameNode.text
  const literal = staticString(nameNode)
  if (literal !== undefined) return literal
  if (nameNode.namedChildren.length === 1) {
    const child = nameNode.namedChildren[0]!
    if (child.type === 'command_name' || child.type === 'path_command_name') return child.text
    return staticString(child)
  }
  return undefined
}

function commandArgumentParts(command: SyntaxNode, variables: ReadonlyMap<string, string>): Array<string | undefined> {
  const elements = command.childForFieldName('command_elements')
  if (!elements) return []
  const parts: Array<string | undefined> = []
  for (const element of elements.namedChildren) {
    if (element.type === 'command_argument_sep') continue
    parts.push(...evaluateValues(element, variables))
  }
  return parts
}

function commandReceivesPipelineInput(command: SyntaxNode): boolean {
  let current: SyntaxNode | null = command
  while (current && current.type !== 'pipeline_chain') current = current.parent
  if (!current) return false
  const prefixLength = Math.max(0, command.startIndex - current.startIndex)
  return current.text.slice(0, prefixLength).includes('|')
}

function stageFromCommand(command: SyntaxNode, variables: ReadonlyMap<string, string>): ShellCommandStage | undefined {
  const executable = commandName(command, variables)
  if (!executable) return undefined
  const args = commandArgumentParts(command, variables)
  const firstDynamic = args.findIndex((arg) => arg === undefined)
  const staticPrefix = args.slice(0, firstDynamic < 0 ? args.length : firstDynamic) as string[]
  return {
    executable,
    argv: [executable, ...staticPrefix],
    rawArgv: [executable, ...args.map((arg) => arg ?? '')],
    environment: [],
    redirects: [],
    argvParts: [executable, ...args],
    argumentsStatic: args.every((arg) => arg !== undefined),
    argumentsResolvedFromVariables: findDirectDescendant(command.childForFieldName('command_elements') ?? command, 'variable') !== undefined,
    receivesPipelineInput: commandReceivesPipelineInput(command),
    environmentStatic: true,
    redirectsStatic: true,
    sourceText: command.text,
    start: command.startIndex,
    commandEnd: command.endIndex,
    end: command.endIndex,
    provenance: 'wrapper',
    dialect: 'powershell',
  }
}

function stageFromRedirection(redirection: SyntaxNode, variables: ReadonlyMap<string, string>): ShellCommandStage | undefined {
  const operator = findDirectDescendant(redirection, 'file_redirection_operator')?.text
  if (!operator?.includes('>')) return undefined
  const targetNode = findDirectDescendant(redirection, 'redirected_file_name')
  const targetValueNode = targetNode
    ? findDirectDescendant(targetNode, 'array_literal_expression') ?? targetNode
    : undefined
  const target = targetValueNode ? evaluateValues(targetValueNode, variables)[0] : undefined
  return {
    executable: 'powershell-redirection',
    argv: target ? ['powershell-redirection', target] : ['powershell-redirection'],
    rawArgv: ['powershell-redirection', targetNode?.text ?? ''],
    environment: [],
    redirects: [],
    argvParts: ['powershell-redirection', target],
    argumentsStatic: target !== undefined,
    argumentsResolvedFromVariables: targetNode ? findDirectDescendant(targetNode, 'variable') !== undefined : false,
    environmentStatic: true,
    redirectsStatic: target !== undefined,
    sourceText: redirection.text,
    start: redirection.startIndex,
    commandEnd: redirection.endIndex,
    end: redirection.endIndex,
    provenance: 'wrapper',
    dialect: 'powershell',
  }
}

function stageExecutableName(stage: ShellCommandStage): string {
  return stage.executable.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? stage.executable.toLowerCase()
}

function commandHasInvocationOperator(command: SyntaxNode): boolean {
  return command.namedChildren.some((child) => child.type === 'command_invokation_operator')
}

function invalidateVariablesForCommand(command: SyntaxNode, stage: ShellCommandStage, state: PowerShellAnalysisState): void {
  const executable = stageExecutableName(stage)
  if (executable === 'join-path') return
  if (['set-variable', 'sv', 'new-variable', 'nv', 'remove-variable', 'rv', 'clear-variable', 'clv'].includes(executable)) {
    state.variables.clear()
    state.reasonCodes.push('powershell-variable-state-invalidated')
    return
  }
  if (commandHasInvocationOperator(command) || executable === 'invoke-expression' || executable === 'iex' || state.knownFunctions.has(executable)) {
    state.variables.clear()
    state.reasonCodes.push('powershell-unmodeled-execution')
  }
}

function evaluateAssignment(assignment: SyntaxNode, variables: Map<string, string>): void {
  const left = assignment.namedChildren[0]
  const name = left ? variableName(findDirectDescendant(left, 'variable')?.text ?? '') : undefined
  if (!name) return
  const value = assignment.childForFieldName('value')
  if (!value) {
    variables.delete(name)
    return
  }

  const command = findDirectDescendant(value, 'command')
  if (command
    && command.text.trim() === value.text.trim()
    && commandName(command, variables)?.toLowerCase() === 'join-path') {
    const parts = commandArgumentParts(command, variables)
    const strictlyPositional = parts.length === 2
      && parts.every((part) => part !== undefined && !part.startsWith('-'))
    if (strictlyPositional) {
      const pathApi = /^[A-Za-z]:[\\/]/.test(parts[0]!) || parts[0]!.startsWith('\\\\') ? win32 : posix
      variables.set(name, pathApi.join(parts[0]!, parts[1]!))
      return
    }
    variables.delete(name)
    return
  }

  const values = evaluateValues(value, variables)
  if (values.length === 1 && values[0] !== undefined) variables.set(name, values[0])
  else variables.delete(name)
}

function isStaticallyInvokedScriptBlock(node: SyntaxNode): boolean {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === 'command_name_expr') {
    const command = parent.parent
    return command?.type === 'command'
      && command.namedChildren.some((child) => child.type === 'command_invokation_operator')
  }
  return false
}

function collectNestedExecutionRoots(node: SyntaxNode, result: SyntaxNode[]): void {
  for (const child of node.namedChildren) {
    if (child.type === 'sub_expression' || child.type === 'parenthesized_expression') {
      result.push(child)
      continue
    }
    collectNestedExecutionRoots(child, result)
  }
}

function collectCommands(node: SyntaxNode, result: SyntaxNode[]): void {
  if (node.type === 'command') {
    result.push(node)
    const nestedRoots: SyntaxNode[] = []
    collectNestedExecutionRoots(node, nestedRoots)
    if (commandHasInvocationOperator(node)) {
      const invokedBlock = findDirectDescendant(node.childForFieldName('command_name') ?? node, 'script_block_expression')
      if (invokedBlock) nestedRoots.push(invokedBlock)
    }
    for (const root of new Set(nestedRoots)) collectCommands(root, result)
    return
  }
  // Declarations do not execute their bodies when parsed. Treating those commands as live
  // would reproduce the same false-positive class that Canonical Shell Analysis avoids for Bash functions.
  if (['function_statement', 'class_statement', 'enum_statement'].includes(node.type)) return
  if (node.type === 'script_block_expression' && !isStaticallyInvokedScriptBlock(node)) return
  for (const child of node.namedChildren) collectCommands(child, result)
}

function collectRedirections(node: SyntaxNode, result: SyntaxNode[]): void {
  if (node.type === 'redirection') {
    result.push(node)
    return
  }
  for (const child of node.namedChildren) collectRedirections(child, result)
}

function collectFunctionDefinitions(node: SyntaxNode, result: Map<string, SyntaxNode>): void {
  if (node.type === 'function_statement') {
    const name = node.namedChildren.find((child) => child.type === 'function_name')?.text.toLowerCase()
    const body = findDirectDescendant(node, 'script_block')
    if (name && body) result.set(name, body)
    return
  }
  for (const child of node.namedChildren) collectFunctionDefinitions(child, result)
}

function commandIsReadOnly(command: SyntaxNode): boolean {
  if (commandHasInvocationOperator(command)) return false
  const rawExecutable = commandName(command)
  if (!rawExecutable || rawExecutable.includes('\\') || rawExecutable.includes('/')) return false
  const executable = rawExecutable.toLowerCase()
  if (!executable || !READ_ONLY_POWERSHELL_COMMANDS.has(executable)) return false
  const text = command.text
  if (['get-content', 'gc', 'cat', 'type'].includes(executable) && /(?:^|\s)-(?:wait|w)(?:\s|$|:)/i.test(text)) return false
  if (SCRIPT_BLOCK_READ_COMMANDS.has(executable)
    && /(?:^|\s)-(?:parallel|asjob|membername|remainingScripts)(?:\s|$|:)/i.test(text)) return false
  return true
}

function scriptBlockBelongsToReadCommand(node: SyntaxNode): boolean {
  let current = node.parent
  while (current && current.type !== 'command') current = current.parent
  return current?.type === 'command' && commandIsReadOnly(current)
}

function isReadOnlyPowerShellTree(node: SyntaxNode): boolean {
  if (UNSAFE_READ_ONLY_SYNTAX.has(node.type)) return false
  if (node.type === 'command' && !commandIsReadOnly(node)) return false
  if (node.type === 'script_block_expression' && !scriptBlockBelongsToReadCommand(node)) return false
  if ((node.type === 'postfix_operator' || node.type === 'unary_operator') && /\+\+|--/.test(node.text)) return false
  return node.namedChildren.every(isReadOnlyPowerShellTree)
}

function hasUnparsedDeletion(node: SyntaxNode): boolean {
  if (node.type === 'ERROR' && /\b(?:Remove-Item|ri|rm|del|erase|rd|rmdir)\b/i.test(node.text)) return true
  return node.namedChildren.some(hasUnparsedDeletion)
}

function hasUnparsedWrite(node: SyntaxNode): boolean {
  if (node.type === 'ERROR' && /\b(?:Set-Content|Add-Content|Clear-Content|Out-File|Move-Item|Copy-Item|Rename-Item|New-Item)\b/i.test(node.text)) return true
  return node.namedChildren.some(hasUnparsedWrite)
}

function collectAssignments(node: SyntaxNode, result: SyntaxNode[]): void {
  if (node.type === 'assignment_expression') result.push(node)
  for (const child of node.namedChildren) collectAssignments(child, result)
}

function invalidateAssignedVariables(node: SyntaxNode, variables: Map<string, string>): void {
  const assignments: SyntaxNode[] = []
  collectAssignments(node, assignments)
  for (const assignment of assignments) {
    const left = assignment.namedChildren[0]
    const name = left ? variableName(findDirectDescendant(left, 'variable')?.text ?? '') : undefined
    if (name) variables.delete(name)
  }
}

function appendCommandStage(command: SyntaxNode, state: PowerShellAnalysisState): void {
  const stage = stageFromCommand(command, state.variables)
  if (!stage) {
    if (commandHasInvocationOperator(command)) state.reasonCodes.push('powershell-unmodeled-execution')
    return
  }
  state.stages.push(stage)
  const executable = stageExecutableName(stage)
  const functionBody = state.knownFunctions.get(executable)
  if (functionBody) {
    const nestedCommands: SyntaxNode[] = []
    collectCommands(functionBody, nestedCommands)
    const unknownFunctionScope = new Map<string, string>()
    for (const nestedCommand of nestedCommands) {
      const nestedStage = stageFromCommand(nestedCommand, unknownFunctionScope)
      if (nestedStage) state.stages.push(nestedStage)
    }
  }
  invalidateVariablesForCommand(command, stage, state)
}

export function analyzePowerShellSource(source: string): PowerShellSourceAnalysis {
  const parser = powershellParser
  if (!parser) return { stages: [], reasonCodes: ['powershell-parser-unavailable'], complete: false, readOnly: false }
  try {
    const tree = parser.parse(source)
    if (!tree) return { stages: [], reasonCodes: ['powershell-parser-returned-null'], complete: false, readOnly: false }
    try {
      const knownFunctions = new Map<string, SyntaxNode>()
      collectFunctionDefinitions(tree.rootNode, knownFunctions)
      const state: PowerShellAnalysisState = {
        variables: new Map<string, string>(),
        knownFunctions,
        stages: [],
        reasonCodes: [],
      }
      const statements = tree.rootNode.namedChildren[0]?.type === 'statement_list'
        ? tree.rootNode.namedChildren[0]!.namedChildren
        : tree.rootNode.namedChildren

      for (const statement of statements) {
        const isSequentialPipeline = statement.type === 'pipeline'
        if (!isSequentialPipeline) invalidateAssignedVariables(statement, state.variables)

        const commands: SyntaxNode[] = []
        collectCommands(statement, commands)
        for (const command of commands) appendCommandStage(command, state)
        const redirections: SyntaxNode[] = []
        collectRedirections(statement, redirections)
        for (const redirection of redirections) {
          const stage = stageFromRedirection(redirection, state.variables)
          if (stage) state.stages.push(stage)
        }

        if (isSequentialPipeline) {
          const assignment = findDirectDescendant(statement, 'assignment_expression')
          if (assignment) evaluateAssignment(assignment, state.variables)
        }
      }

      const dynamicArguments = state.stages.some((stage) => !stage.argumentsStatic)
      const complete = !tree.rootNode.hasError
      return {
        stages: state.stages,
        reasonCodes: [
          ...state.reasonCodes,
          ...(tree.rootNode.hasError ? ['powershell-parse-error'] : []),
          ...(hasUnparsedDeletion(tree.rootNode) ? ['powershell-unparsed-delete'] : []),
          ...(hasUnparsedWrite(tree.rootNode) ? ['powershell-unparsed-write'] : []),
          ...(dynamicArguments ? ['dynamic-powershell-argument'] : []),
        ],
        complete,
        readOnly: complete && state.stages.length > 0 && isReadOnlyPowerShellTree(tree.rootNode),
      }
    } finally {
      tree.delete()
    }
  } catch {
    return { stages: [], reasonCodes: ['powershell-parser-threw'], complete: false, readOnly: false }
  }
}
