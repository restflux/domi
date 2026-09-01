import { parse } from 'unbash'
import { analyzePowerShellSource, initializePowerShellAnalysis } from './powershell-analysis.ts'
import type {
  AndOr,
  ArithmeticExpression,
  AssignmentPrefix,
  Command,
  Node,
  ParsedScript,
  Pipeline,
  Redirect,
  Statement,
  Word,
  WordPart,
} from 'unbash'

export type ShellAnalysisStatus = 'static' | 'opaque' | 'invalid'

export interface ShellEnvironmentAssignment {
  name: string
  value?: string
}

export interface ShellRedirect {
  operator: Redirect['operator']
  target?: string
  fileDescriptor?: number
}

export interface ShellCommandStage {
  executable: string
  argv: string[]
  /** 原始 Shell word 文本；仅用于路径拼写兼容和 source rewrite，不参与命令风险判断。 */
  rawArgv: string[]
  environment: ShellEnvironmentAssignment[]
  redirects: ShellRedirect[]
  /** 与 shell word 位置一一对应；动态 word 保留为 undefined，供硬门禁消费 partial facts。 */
  argvParts: Array<string | undefined>
  argumentsStatic: boolean
  /** 参数原文含 PowerShell 变量，但已由有界静态求值解析；Policy 仍须验证目标位于宿主信任根。 */
  argumentsResolvedFromVariables?: boolean
  /** PowerShell command 位于 pipeline tail，可能从上游接收未建模参数。 */
  receivesPipelineInput?: boolean
  environmentStatic: boolean
  redirectsStatic: boolean
  sourceText: string
  start: number
  /** executable + argv 的末尾，不包含附着在该 command 上的 redirect。 */
  commandEnd: number
  end: number
  provenance: 'top-level' | 'substitution' | 'wrapper'
  dialect?: 'bash' | 'powershell' | 'cmd'
  /** Canonical embedded-language parser proved the complete wrapped source read-only. */
  embeddedSourceReadOnly?: boolean
}

export interface ShellAnalysis {
  status: ShellAnalysisStatus
  source: string
  stages: ShellCommandStage[]
  operators: string[]
  reasonCodes: string[]
}

interface AnalysisAccumulator {
  source: string
  stages: ShellCommandStage[]
  operators: string[]
  reasonCodes: string[]
}

const STATIC_SHELL_WRAPPERS = new Set(['bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe'])
const STATIC_POWERSHELL_WRAPPERS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
const STATIC_CMD_WRAPPERS = new Set(['cmd', 'cmd.exe'])
const STATIC_EVAL_WRAPPERS = new Set(['eval'])
const TRANSPARENT_ARGV_WRAPPERS = new Set(['nohup', 'nohup.exe', 'setsid', 'setsid.exe'])
const MAX_ANALYSIS_DEPTH = 8

function unwrapStaticCommand(argv: readonly string[]): { executable?: string; args: string[] } {
  let current = [...argv]
  for (let depth = 0; depth < 6; depth += 1) {
    const executable = current.shift()?.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase()
    if (!executable) return { executable: undefined, args: current }
    if (executable === 'env' || executable === 'env.exe') {
      while (current.length > 0) {
        const token = current[0]!
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
          current.shift()
          continue
        }
        if (token === '--') {
          current.shift()
          break
        }
        if (!token.startsWith('-')) break
        const option = current.shift()!
        if (!option.includes('=') && ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(option)) current.shift()
      }
      continue
    }
    if (executable === 'command') {
      while (current[0]?.startsWith('-')) current.shift()
      continue
    }
    if (TRANSPARENT_ARGV_WRAPPERS.has(executable)) {
      while (current[0]?.startsWith('-')) current.shift()
      continue
    }
    if (executable === 'sudo' || executable === 'sudo.exe') {
      while (current.length > 0) {
        const token = current[0]!
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
          current.shift()
          continue
        }
        if (token === '--') {
          current.shift()
          break
        }
        if (!token.startsWith('-')) break
        const option = current.shift()!
        if (!option.includes('=') && ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-r', '--role', '-t', '--type'].includes(option)) current.shift()
      }
      continue
    }
    return { executable, args: current }
  }
  return { executable: undefined, args: current }
}

function partIsStatic(part: WordPart): boolean {
  switch (part.type) {
    case 'Literal':
    case 'SingleQuoted':
    case 'AnsiCQuoted':
      return true
    case 'DoubleQuoted':
      return part.parts.every((child) => child.type === 'Literal')
    default:
      return false
  }
}

function staticWordValue(word: Word | undefined): string | undefined {
  if (!word) return undefined
  const parts = word.parts
  if (parts?.some((part) => !partIsStatic(part))) return undefined
  return word.value
}

function collectNestedScriptsFromArithmetic(
  expression: ArithmeticExpression | undefined,
  scripts: ParsedScript[],
): void {
  if (!expression) return
  switch (expression.type) {
    case 'ArithmeticCommandExpansion':
      if (expression.script) scripts.push(expression.script)
      return
    case 'ArithmeticWord':
      collectNestedScriptsFromParts(expression.parts, scripts)
      return
    case 'ArithmeticBinary':
      collectNestedScriptsFromArithmetic(expression.left, scripts)
      collectNestedScriptsFromArithmetic(expression.right, scripts)
      return
    case 'ArithmeticUnary':
      collectNestedScriptsFromArithmetic(expression.operand, scripts)
      return
    case 'ArithmeticGroup':
      collectNestedScriptsFromArithmetic(expression.expression, scripts)
      return
    case 'ArithmeticTernary':
      collectNestedScriptsFromArithmetic(expression.test, scripts)
      collectNestedScriptsFromArithmetic(expression.consequent, scripts)
      collectNestedScriptsFromArithmetic(expression.alternate, scripts)
  }
}

function collectNestedScriptsFromParts(parts: readonly WordPart[] | undefined, scripts: ParsedScript[]): void {
  for (const part of parts ?? []) {
    if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
      collectNestedScriptsFromParts(part.parts, scripts)
      continue
    }
    if (part.type === 'CommandExpansion' || part.type === 'ProcessSubstitution') {
      if (part.script) scripts.push(part.script)
      continue
    }
    if (part.type === 'ArithmeticExpansion') {
      collectNestedScriptsFromArithmetic(part.expression, scripts)
      continue
    }
    if (part.type === 'ParameterExpansion') {
      collectNestedScriptsFromParts(part.indexParts, scripts)
      collectNestedScriptsFromParts(part.operand?.parts, scripts)
      collectNestedScriptsFromParts(part.slice?.offset.parts, scripts)
      collectNestedScriptsFromParts(part.slice?.length?.parts, scripts)
      collectNestedScriptsFromParts(part.replace?.pattern.parts, scripts)
      collectNestedScriptsFromParts(part.replace?.replacement.parts, scripts)
      continue
    }
    if (part.type === 'BraceExpansion' || part.type === 'ExtendedGlob') {
      collectNestedScriptsFromParts(part.parts, scripts)
    }
  }
}

function collectNestedScriptsFromWord(word: Word | undefined): ParsedScript[] {
  const scripts: ParsedScript[] = []
  collectNestedScriptsFromParts(word?.parts, scripts)
  return scripts
}

function collectNestedScriptsFromAssignment(assignment: AssignmentPrefix): ParsedScript[] {
  const scripts = [
    ...collectNestedScriptsFromWord(assignment.value),
    ...(assignment.array ?? []).flatMap(collectNestedScriptsFromWord),
  ]
  collectNestedScriptsFromParts(assignment.indexParts, scripts)
  return scripts
}

function collectNestedScriptsFromRedirect(redirect: Redirect): ParsedScript[] {
  return [
    ...collectNestedScriptsFromWord(redirect.target),
    ...collectNestedScriptsFromWord(redirect.body),
  ]
}

function assignmentFact(assignment: AssignmentPrefix): ShellEnvironmentAssignment | undefined {
  if (!assignment.name || assignment.array || assignment.index !== undefined || assignment.append) return undefined
  const value = assignment.value ? staticWordValue(assignment.value) : ''
  return { name: assignment.name, ...(value !== undefined && { value }) }
}

function staticRedirect(redirect: Redirect): ShellRedirect | undefined {
  if (redirect.body || redirect.heredocQuoted !== undefined) return undefined
  const target = redirect.target ? staticWordValue(redirect.target) : undefined
  if (redirect.target && target === undefined) return undefined
  return {
    operator: redirect.operator,
    ...(target !== undefined && { target }),
    ...(redirect.fileDescriptor !== undefined && { fileDescriptor: redirect.fileDescriptor }),
  }
}

function analyzeCommand(
  command: Command,
  accumulator: AnalysisAccumulator,
  provenance: ShellCommandStage['provenance'],
  nodeSource: string,
  depth: number,
): boolean {
  const nestedScripts = [
    ...[command.name, ...command.suffix].flatMap(collectNestedScriptsFromWord),
    ...command.prefix.flatMap(collectNestedScriptsFromAssignment),
    ...command.redirects.flatMap(collectNestedScriptsFromRedirect),
  ]
  for (const script of nestedScripts) {
    analyzeParsedScript(script, accumulator, 'substitution', script.source ?? nodeSource, depth + 1)
  }

  const executable = staticWordValue(command.name)
  if (!executable) {
    accumulator.reasonCodes.push('dynamic-or-missing-executable')
    return false
  }

  const args = command.suffix.map(staticWordValue)
  const argumentsStatic = args.every((arg) => arg !== undefined)
  if (!argumentsStatic) accumulator.reasonCodes.push('dynamic-argument')

  const environmentParts = command.prefix.map(assignmentFact)
  const environmentStatic = environmentParts.every((assignment) => assignment !== undefined && assignment.value !== undefined)
  if (!environmentStatic) accumulator.reasonCodes.push('dynamic-environment-assignment')

  const redirectParts = command.redirects.map(staticRedirect)
  const redirectsStatic = redirectParts.every((redirect) => redirect !== undefined)
  if (!redirectsStatic) accumulator.reasonCodes.push('dynamic-or-complex-redirection')

  const firstDynamicArgument = args.findIndex((arg) => arg === undefined)
  const staticArgumentPrefix = args.slice(0, firstDynamicArgument < 0 ? args.length : firstDynamicArgument) as string[]
  const argv = [executable, ...staticArgumentPrefix]
  const commandEnd = command.redirects.length > 0
    ? Math.min(...command.redirects.map((redirect) => redirect.pos))
    : command.end
  const stage: ShellCommandStage = {
    executable,
    argv,
    rawArgv: [command.name!.text, ...command.suffix.map((word) => word.text)],
    environment: environmentParts.filter((value): value is ShellEnvironmentAssignment => value !== undefined),
    redirects: redirectParts.filter((value): value is ShellRedirect => value !== undefined),
    argvParts: [executable, ...args],
    argumentsStatic,
    environmentStatic,
    redirectsStatic,
    sourceText: nodeSource.slice(command.pos, command.end),
    start: command.pos,
    commandEnd,
    end: command.end,
    provenance,
    dialect: 'bash',
  }
  accumulator.stages.push(stage)

  const wrapped = argumentsStatic ? unwrapStaticCommand(argv) : { executable: undefined, args: [] }
  const normalizedExecutable = wrapped.executable
  if (normalizedExecutable && STATIC_EVAL_WRAPPERS.has(normalizedExecutable)) {
    const nestedSource = wrapped.args.join(' ')
    if (nestedSource) analyzeSourceInto(nestedSource, accumulator, 'wrapper', depth + 1)
    accumulator.reasonCodes.push('opaque-eval-wrapper')
    return false
  }
  if (normalizedExecutable && STATIC_SHELL_WRAPPERS.has(normalizedExecutable)) {
    const commandOptionIndex = wrapped.args.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token))
    const nestedSource = commandOptionIndex >= 0 ? wrapped.args[commandOptionIndex + 1] : undefined
    if (nestedSource === undefined) return argumentsStatic && environmentStatic && redirectsStatic
    const nested = analyzeSourceInto(nestedSource, accumulator, 'wrapper', depth + 1)
    if (!nested) accumulator.reasonCodes.push('opaque-shell-wrapper')
    return nested && argumentsStatic && environmentStatic && redirectsStatic
  }
  if (normalizedExecutable && STATIC_POWERSHELL_WRAPPERS.has(normalizedExecutable)) {
    const commandOptionIndex = wrapped.args.findIndex((token) => /^-(?:command|c)$/i.test(token))
    const nestedSource = commandOptionIndex >= 0 ? wrapped.args[commandOptionIndex + 1] : undefined
    if (nestedSource === undefined) return argumentsStatic && environmentStatic && redirectsStatic
    const nested = analyzePowerShellSource(nestedSource)
    stage.embeddedSourceReadOnly = nested.readOnly
    accumulator.stages.push(...nested.stages)
    accumulator.reasonCodes.push(...nested.reasonCodes, 'opaque-powershell-wrapper')
    // PowerShell source is parsed with its own grammar. The bounded evaluator only exposes
    // executable and path facts; it never upgrades the wrapper to a fully static Bash command.
    return false
  }
  if (normalizedExecutable && STATIC_CMD_WRAPPERS.has(normalizedExecutable)) {
    const commandOptionIndex = wrapped.args.findIndex((token) => /^\/c$/i.test(token))
    const nestedSource = commandOptionIndex >= 0 ? wrapped.args[commandOptionIndex + 1] : undefined
    if (nestedSource === undefined) return argumentsStatic && environmentStatic && redirectsStatic
    const firstNestedStage = accumulator.stages.length
    const nested = analyzeSourceInto(nestedSource, accumulator, 'wrapper', depth + 1)
    for (const nestedStage of accumulator.stages.slice(firstNestedStage)) nestedStage.dialect = 'cmd'
    if (!nested) accumulator.reasonCodes.push('opaque-cmd-wrapper')
    return nested && argumentsStatic && environmentStatic && redirectsStatic
  }
  return argumentsStatic && environmentStatic && redirectsStatic
}

function analyzePipeline(
  pipeline: Pipeline,
  accumulator: AnalysisAccumulator,
  provenance: ShellCommandStage['provenance'],
  nodeSource: string,
  depth: number,
): boolean {
  let isStatic = true
  if (pipeline.negated || pipeline.time || pipeline.operators.some((operator) => operator !== '|')) {
    accumulator.reasonCodes.push('unsupported-pipeline-form')
    isStatic = false
  }
  for (let index = 0; index < pipeline.commands.length; index += 1) {
    if (!analyzeNode(pipeline.commands[index]!, accumulator, provenance, nodeSource, depth)) isStatic = false
    if (pipeline.operators[index]) accumulator.operators.push(pipeline.operators[index]!)
  }
  return isStatic
}

function analyzeAndOr(
  andOr: AndOr,
  accumulator: AnalysisAccumulator,
  provenance: ShellCommandStage['provenance'],
  nodeSource: string,
  depth: number,
): boolean {
  let isStatic = true
  for (let index = 0; index < andOr.commands.length; index += 1) {
    if (!analyzeNode(andOr.commands[index]!, accumulator, provenance, nodeSource, depth)) isStatic = false
    if (andOr.operators[index]) accumulator.operators.push(andOr.operators[index]!)
  }
  return isStatic
}

function analyzeStatement(
  statement: Statement,
  accumulator: AnalysisAccumulator,
  provenance: ShellCommandStage['provenance'],
  nodeSource: string,
  depth: number,
): boolean {
  let isStatic = analyzeNode(statement.command, accumulator, provenance, nodeSource, depth)
  if (statement.background) {
    accumulator.reasonCodes.push('background-execution')
    isStatic = false
  }
  if (statement.redirects.length > 0) {
    accumulator.reasonCodes.push('compound-redirection')
    for (const redirect of statement.redirects) {
      for (const script of collectNestedScriptsFromRedirect(redirect)) {
        analyzeParsedScript(script, accumulator, 'substitution', script.source ?? nodeSource, depth + 1)
      }
    }
    isStatic = false
  }
  return isStatic
}

function analyzeNode(
  node: Node,
  accumulator: AnalysisAccumulator,
  provenance: ShellCommandStage['provenance'],
  nodeSource: string,
  depth: number,
): boolean {
  if (depth > MAX_ANALYSIS_DEPTH) {
    accumulator.reasonCodes.push('analysis-depth-exceeded')
    return false
  }
  switch (node.type) {
    case 'Command':
      return analyzeCommand(node, accumulator, provenance, nodeSource, depth)
    case 'Pipeline':
      return analyzePipeline(node, accumulator, provenance, nodeSource, depth)
    case 'AndOr':
      return analyzeAndOr(node, accumulator, provenance, nodeSource, depth)
    case 'Statement':
      return analyzeStatement(node, accumulator, provenance, nodeSource, depth)
    case 'CompoundList': {
      let isStatic = true
      for (const statement of node.commands) {
        if (!analyzeStatement(statement, accumulator, provenance, nodeSource, depth + 1)) isStatic = false
      }
      return isStatic
    }
    case 'Subshell':
    case 'BraceGroup':
      accumulator.reasonCodes.push(`unsupported-node:${node.type}`)
      analyzeNode(node.body, accumulator, provenance, nodeSource, depth + 1)
      return false
    case 'If':
      accumulator.reasonCodes.push('unsupported-node:If')
      analyzeNode(node.clause, accumulator, provenance, nodeSource, depth + 1)
      analyzeNode(node.then, accumulator, provenance, nodeSource, depth + 1)
      if (node.else) analyzeNode(node.else, accumulator, provenance, nodeSource, depth + 1)
      return false
    case 'For':
    case 'Select':
      accumulator.reasonCodes.push(`unsupported-node:${node.type}`)
      analyzeNode(node.body, accumulator, provenance, nodeSource, depth + 1)
      return false
    case 'While':
      accumulator.reasonCodes.push('unsupported-node:While')
      analyzeNode(node.clause, accumulator, provenance, nodeSource, depth + 1)
      analyzeNode(node.body, accumulator, provenance, nodeSource, depth + 1)
      return false
    case 'Case':
      accumulator.reasonCodes.push('unsupported-node:Case')
      for (const item of node.items) analyzeNode(item.body, accumulator, provenance, nodeSource, depth + 1)
      return false
    case 'Function':
      // 函数声明本身不执行其 body；调用解析需要符号表，当前只诚实标记 opaque。
      accumulator.reasonCodes.push('unsupported-node:Function')
      return false
    case 'Coproc':
      accumulator.reasonCodes.push('unsupported-node:Coproc')
      analyzeNode(node.body, accumulator, provenance, nodeSource, depth + 1)
      return false
    case 'ArithmeticFor':
      accumulator.reasonCodes.push('unsupported-node:ArithmeticFor')
      analyzeNode(node.body, accumulator, provenance, nodeSource, depth + 1)
      return false
    case 'ArithmeticCommand': {
      accumulator.reasonCodes.push('unsupported-node:ArithmeticCommand')
      const scripts: ParsedScript[] = []
      collectNestedScriptsFromArithmetic(node.expression, scripts)
      for (const script of scripts) {
        analyzeParsedScript(script, accumulator, 'substitution', script.source ?? nodeSource, depth + 1)
      }
      return false
    }
    case 'TestCommand':
      accumulator.reasonCodes.push('unsupported-node:TestCommand')
      return false
  }
}

function analyzeParsedScript(
  script: ParsedScript,
  accumulator: AnalysisAccumulator,
  provenance: ShellCommandStage['provenance'],
  nodeSource: string,
  depth: number,
): boolean {
  if (script.errors?.length) {
    accumulator.reasonCodes.push('nested-parse-error')
    return false
  }
  let isStatic = true
  for (let index = 0; index < script.commands.length; index += 1) {
    if (!analyzeStatement(script.commands[index]!, accumulator, provenance, nodeSource, depth)) isStatic = false
    if (index < script.commands.length - 1) accumulator.operators.push(';')
  }
  return isStatic
}

function analyzeSourceInto(
  source: string,
  accumulator: AnalysisAccumulator,
  provenance: ShellCommandStage['provenance'],
  depth: number,
): boolean {
  if (depth > MAX_ANALYSIS_DEPTH) {
    accumulator.reasonCodes.push('analysis-depth-exceeded')
    return false
  }
  let script: ReturnType<typeof parse>
  try {
    script = parse(source)
  } catch {
    accumulator.reasonCodes.push('parser-threw')
    return false
  }
  return analyzeParsedScript(script, accumulator, provenance, source, depth)
}

export async function initializeShellAnalysis(): Promise<void> {
  await initializePowerShellAnalysis()
}

export function analyzeShellCommand(source: string): ShellAnalysis {
  if (!source.trim()) {
    return { status: 'invalid', source, stages: [], operators: [], reasonCodes: ['empty-command'] }
  }

  let script: ReturnType<typeof parse>
  try {
    script = parse(source)
  } catch {
    return { status: 'invalid', source, stages: [], operators: [], reasonCodes: ['parser-threw'] }
  }
  if (script.errors?.length) {
    return {
      status: 'invalid',
      source,
      stages: [],
      operators: [],
      reasonCodes: ['parse-error'],
    }
  }

  const accumulator: AnalysisAccumulator = { source, stages: [], operators: [], reasonCodes: [] }
  const isStatic = analyzeParsedScript(script, accumulator, 'top-level', source, 0)
  if (!isStatic) return { status: 'opaque', ...accumulator }
  return accumulator.stages.length > 0
    ? { status: 'static', ...accumulator }
    : { status: 'invalid', ...accumulator, reasonCodes: ['no-executable-stage'] }
}
