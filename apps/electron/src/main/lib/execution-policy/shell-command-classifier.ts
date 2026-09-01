import { analyzeShellCommand, type ShellAnalysis, type ShellCommandStage } from './shell-analysis.ts'

const SHELL_CONTROL_SYNTAX = /(?:[;&|<>`]|\$|\r|\n)/

const KNOWN_VALIDATION_COMMANDS = [
  /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:typecheck|test|lint|check|build)(?:\s+[^;&|<>`]*)?$/i,
  /^bun\s+test(?:\s+[^;&|<>`]*)?$/i,
  /^(?:npx\s+)?tsc\s+--noEmit(?:\s+[^;&|<>`]*)?$/i,
]

/**
 * Git Bash 会把 CMD 的 `>nul` / `2>nul` 当作普通文件重定向并创建实体 `nul`。
 * 这里只识别 Bash 代码上下文中的静态重定向目标；引号内普通文本和动态目标不猜测，
 * 但双引号中的 `$(...)` / 反引号仍是可执行 Bash 子命令，必须递归检查。
 */
export function hasGitBashCmdNullDeviceRedirection(command: string): boolean {
  return executableStages(command).some((stage) => stage.dialect !== 'cmd' && stage.redirects.some((redirect) => (
    redirect.target?.toLowerCase() === 'nul'
  )))
}

interface GitInvocation {
  subcommand: string
  args: string[]
  argumentsStatic: boolean
}

function shellAnalysis(command: string): ShellAnalysis {
  return analyzeShellCommand(command)
}

function executableStages(command: string, analysis = shellAnalysis(command)): ShellCommandStage[] {
  return analysis.stages
}

export interface SessionTrustEligibleGitPush {
  remote: string
  source: 'HEAD'
  destination: string
}

function normalizeSessionTrustPushDestination(value: string): string | null {
  const shortName = value.startsWith('refs/heads/')
    ? value.slice('refs/heads/'.length)
    : value
  if (!shortName
    || shortName.startsWith('.')
    || shortName.endsWith('.')
    || shortName.startsWith('/')
    || shortName.endsWith('/')
    || shortName.includes('..')
    || shortName.includes('@{')
    || shortName.includes('//')
    || /[\s~^:?*[\\]/.test(shortName)) {
    return null
  }
  return `refs/heads/${shortName}`
}

/**
 * 解析可由当前会话精确授权的普通 push。
 *
 * 只接受单条直接命令 `git push <named-remote> HEAD:<branch>`；不接受任何 Git
 * global option、push option、shell 组合、显式 URL 或多 refspec，避免 session grant
 * 被扩大为通用外部影响白名单。
 */
export function isDirectManagedWorktreeDestructiveGitCommand(
  command: string,
  analysis = shellAnalysis(command),
): boolean {
  if (analysis.status !== 'static' || analysis.stages.length === 0) return false
  if (analysis.operators.some((operator) => operator !== '&&' && operator !== ';')) return false
  const onlyDirectGitStages = analysis.stages.every((stage) => {
    const executable = stage.argv[0]?.toLowerCase()
    return stage.provenance === 'top-level'
      && (executable === 'git' || executable === 'git.exe')
      && stage.environment.length === 0
      && stage.redirects.length === 0
      && Boolean(stage.argv[1])
      && !stage.argv[1]!.startsWith('-')
  })
  return onlyDirectGitStages && isDestructiveGitCommand(command, analysis)
}

export function parseSessionTrustEligibleGitPush(
  command: string,
  analysis = shellAnalysis(command),
): SessionTrustEligibleGitPush | null {
  if (analysis.status !== 'static' || analysis.stages.length !== 1 || analysis.operators.length > 0) return null
  const [stage] = analysis.stages
  const tokens = stage!.argv
  const executable = tokens[0]?.toLowerCase()
  if (executable !== 'git' && executable !== 'git.exe') return null
  if (stage!.environment.length > 0 || stage!.redirects.length > 0) return null
  if (tokens.length !== 4 || tokens[1]?.toLowerCase() !== 'push') return null

  const remote = tokens[2]!
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)
    || remote.includes('..')
    || remote.includes('//')
    || remote.endsWith('/')) {
    return null
  }

  const refspec = tokens[3]!
  const separator = refspec.indexOf(':')
  if (separator <= 0 || refspec.indexOf(':', separator + 1) >= 0) return null
  const source = refspec.slice(0, separator)
  if (source !== 'HEAD') return null
  const destination = normalizeSessionTrustPushDestination(refspec.slice(separator + 1))
  return destination ? { remote, source: 'HEAD', destination } : null
}

const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree',
])

const ENV_OPTIONS_WITH_VALUE = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const TRANSPARENT_COMMAND_WRAPPERS = new Set(['nohup', 'setsid'])
const SUDO_OPTIONS_WITH_VALUE = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-r', '--role', '-t', '--type'])

function shellExecutable(token: string | undefined): string | undefined {
  return token?.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase()
}

function unwrapCommandExecutableParts(parts: readonly (string | undefined)[]): {
  executable: string | undefined
  rest: Array<string | undefined>
} {
  let current = [...parts]
  for (let depth = 0; depth < 6; depth += 1) {
    while (current[0] && ENV_ASSIGNMENT.test(current[0])) current.shift()
    const executable = shellExecutable(current[0])?.replace(/\.exe$/i, '')
    if (!executable) return { executable: undefined, rest: current.slice(1) }
    if (executable === 'env') {
      current.shift()
      while (current.length > 0) {
        const token = current[0]
        if (token === undefined) return { executable: undefined, rest: current.slice(1) }
        if (ENV_ASSIGNMENT.test(token)) {
          current.shift()
          continue
        }
        if (token === '--') {
          current.shift()
          break
        }
        if (!token.startsWith('-')) break
        const option = current.shift()!
        const optionName = option.split('=', 1)[0] ?? option
        if (!option.includes('=') && ENV_OPTIONS_WITH_VALUE.has(optionName)) current.shift()
      }
      continue
    }
    if (executable === 'command') {
      current.shift()
      while (current[0]?.startsWith('-')) current.shift()
      continue
    }
    if (TRANSPARENT_COMMAND_WRAPPERS.has(executable)) {
      current.shift()
      while (current[0]?.startsWith('-')) current.shift()
      continue
    }
    if (executable === 'sudo') {
      current.shift()
      while (current.length > 0) {
        const token = current[0]
        if (token === undefined) return { executable: undefined, rest: current.slice(1) }
        if (token === '--') {
          current.shift()
          break
        }
        if (ENV_ASSIGNMENT.test(token)) {
          current.shift()
          continue
        }
        if (!token.startsWith('-')) break
        const option = current.shift()!
        const optionName = option.split('=', 1)[0] ?? option
        if (!option.includes('=') && SUDO_OPTIONS_WITH_VALUE.has(optionName)) current.shift()
      }
      continue
    }
    return { executable, rest: current.slice(1) }
  }
  return { executable: undefined, rest: current }
}

function extractGitInvocationFromStage(stage: ShellCommandStage): GitInvocation[] {
  // bash/sh/zsh -c 与 eval 的静态 source 已由 Canonical Analysis 产出 wrapper stage；外层不重复分类。
  const { executable, rest } = unwrapCommandExecutableParts(stage.argvParts)
  if (executable !== 'git') return []
  const tokens = [...rest]
  while (typeof tokens[0] === 'string' && tokens[0].startsWith('-')) {
    const option = tokens.shift()!
    const optionName = option.split('=', 1)[0] ?? option
    if (!option.includes('=') && GIT_OPTIONS_WITH_VALUE.has(optionName)) tokens.shift()
  }
  const subcommand = tokens.shift()
  if (typeof subcommand !== 'string') return []
  return [{
    subcommand: subcommand.toLowerCase(),
    args: tokens.filter((token): token is string => token !== undefined),
    argumentsStatic: stage.argumentsStatic && tokens.every((token) => token !== undefined),
  }]
}

/** 只消费 Canonical Analysis 中的 argv facts；禁止重新 tokenize 原始 Shell 文本。 */
function extractGitInvocations(command: string, analysis = shellAnalysis(command)): GitInvocation[] {
  return executableStages(command, analysis).flatMap(extractGitInvocationFromStage)
}

function extractWorktreeAddPath(args: readonly string[]): string | undefined {
  if (args[0]?.toLowerCase() !== 'add') return undefined
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!
    if (token === '--') return args[index + 1]
    if (token === '-b' || token === '-B' || token === '--reason') {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

/** 判断命令是否包含直接或常见包装后的 `git worktree add`。 */
export function hasGitWorktreeAddInvocation(command: string, analysis = shellAnalysis(command)): boolean {
  return extractGitInvocations(command, analysis).some(({ subcommand, args }) => (
    subcommand === 'worktree' && args[0]?.toLowerCase() === 'add'
  ))
}

/** 提取 `git worktree add` 的目标路径，供 Session Target 生命周期硬门禁使用。 */
export function extractGitWorktreeAddPaths(command: string, analysis = shellAnalysis(command)): string[] {
  return extractGitInvocations(command, analysis).flatMap(({ subcommand, args }) => {
    if (subcommand !== 'worktree') return []
    const path = extractWorktreeAddPath(args)
    return path ? [path] : []
  })
}

function hasExplicitBoundaryEscape(analysis: ShellAnalysis): boolean {
  const tokens = analysis.stages.flatMap((stage) => [
    ...stage.argv.slice(1),
    ...stage.rawArgv.slice(1).map((token) => token.replace(/^["']|["']$/g, '')),
    ...stage.environment.flatMap((assignment) => assignment.value === undefined ? [] : [assignment.value]),
  ])
  return tokens.some((token) => {
    const candidate = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token
    return token === '-C'
      || token === '--cwd'
      || token.startsWith('--cwd=')
      || candidate === '~'
      || candidate.startsWith('~/')
      || candidate.startsWith('~\\')
      || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(candidate)
      || /^[A-Za-z]:[\\/]/.test(candidate)
      || /^\\\\/.test(candidate)
      || /^\//.test(candidate)
  })
}

function executableName(token: string | undefined): string | undefined {
  if (!token || token.includes('/') || token.includes('\\')) return undefined
  return token.toLowerCase().replace(/\.exe$/, '')
}

function hasOption(tokens: readonly string[], ...options: string[]): boolean {
  return tokens.some((token) => options.some((option) => token === option || token.startsWith(`${option}=`)))
}

function hasGroupedShortFlag(tokens: readonly string[], flag: string): boolean {
  return tokens.some((token) => /^-[^-]/.test(token) && token.slice(1).includes(flag))
}

/** GNU/Git 长选项通常接受唯一前缀缩写；危险项按前缀一并拒绝。 */
function hasLongOptionOrAbbreviation(tokens: readonly string[], ...options: string[]): boolean {
  return tokens.some((token) => {
    const optionName = token.split('=', 1)[0] ?? token
    return optionName.startsWith('--')
      && optionName.length > 2
      && options.some((option) => option === optionName || option.startsWith(optionName))
  })
}

function isSafeGitConfigRead(args: readonly string[]): boolean {
  const mutatingOptions = [
    '--add', '--replace-all', '--unset', '--unset-all', '--rename-section', '--remove-section', '--edit',
  ]
  if (hasOption(args, '-e') || hasLongOptionOrAbbreviation(args, ...mutatingOptions)) return false
  const readSelectors = [
    '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool',
    '--list', '-l', 'get', 'get-all', 'get-regexp', 'get-urlmatch', 'list',
  ]
  return args.some((arg) => readSelectors.includes(arg))
}

function isSafeGitRead(tokens: readonly string[]): boolean {
  const subcommand = tokens[0]?.toLowerCase()
  if (!subcommand) return false
  const args = tokens.slice(1)
  if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand)) {
    return !hasOption(
      args,
      '--output',
      '--ext-diff',
      '--textconv',
      '--show-signature',
      '--pathspec-from-file',
      '--pathspec-file-nul',
    ) && !args.some((arg) => /%G[A-Za-z?]?/.test(arg))
  }
  if (subcommand === 'branch') {
    return args.length === 0 || args.every((arg) => (
      arg === '--list'
      || arg.startsWith('--list=')
      || arg === '--show-current'
      || arg === '--contains'
      || arg.startsWith('--contains=')
      || arg === '--no-contains'
      || arg.startsWith('--no-contains=')
      || arg === '--merged'
      || arg.startsWith('--merged=')
      || arg === '--no-merged'
      || arg.startsWith('--no-merged=')
      || arg === '-a'
      || arg === '--all'
      || arg === '-r'
      || arg === '--remotes'
      || arg === '-v'
      || arg === '-vv'
      || arg === '--verbose'
      || arg === '--color'
      || arg.startsWith('--color=')
      || arg === '--sort'
      || arg.startsWith('--sort=')
      || (!arg.startsWith('-') && args.some((candidate) => ['--contains', '--no-contains', '--merged', '--no-merged', '--sort'].includes(candidate)))
    ))
  }
  if (subcommand === 'remote') {
    return args.length === 0
      || args.every((arg) => arg === '-v' || arg === '--verbose')
      || (args[0]?.toLowerCase() === 'get-url'
        && args.slice(1).every((arg) => arg === '--all' || arg === '--push' || !arg.startsWith('-')))
  }
  if (subcommand === 'tag') {
    return args.length === 0 || args.every((arg) => (
      arg === '-l'
      || arg === '--list'
      || arg.startsWith('--list=')
      || arg === '--contains'
      || arg.startsWith('--contains=')
      || arg === '--no-contains'
      || arg.startsWith('--no-contains=')
      || arg === '--merged'
      || arg.startsWith('--merged=')
      || arg === '--no-merged'
      || arg.startsWith('--no-merged=')
      || arg === '--sort'
      || arg.startsWith('--sort=')
      || (!arg.startsWith('-') && args.some((candidate) => ['--contains', '--no-contains', '--merged', '--no-merged', '--sort'].includes(candidate)))
    ))
  }
  if (subcommand === 'ls-files') {
    return !hasOption(args, '--error-unmatch')
  }
  if (subcommand === 'worktree') {
    return args[0]?.toLowerCase() === 'list'
      && args.slice(1).every((arg) => arg === '--porcelain' || arg === '-v' || arg === '--verbose')
  }
  if (subcommand === 'ls-remote') {
    return !hasLongOptionOrAbbreviation(args, '--upload-pack', '--exec', '--server-option')
      && !args.some((arg) => /^ext::/i.test(arg))
  }
  if (['describe', 'merge-base', 'name-rev', 'shortlog', 'ls-tree', 'show-ref', 'check-ignore', 'count-objects'].includes(subcommand)) {
    return true
  }
  if (subcommand === 'blame') {
    return !hasLongOptionOrAbbreviation(args, '--textconv')
  }
  if (subcommand === 'grep') {
    return !hasLongOptionOrAbbreviation(args, '--open-files-in-pager', '--ext-grep')
  }
  if (subcommand === 'cat-file') {
    return !hasLongOptionOrAbbreviation(args, '--filters', '--textconv')
  }
  if (subcommand === 'for-each-ref') {
    return !args.some((arg) => /signature(?::|\))/i.test(arg))
  }
  if (subcommand === 'reflog') {
    const action = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
    return action === undefined || action === 'show' || action === 'exists'
  }
  if (subcommand === 'stash') {
    const action = args[0]?.toLowerCase()
    return (action === 'list' || action === 'show')
      && !hasLongOptionOrAbbreviation(args.slice(1), '--ext-diff', '--textconv', '--show-signature')
  }
  if (subcommand === 'submodule') {
    return args[0]?.toLowerCase() === 'status'
      && args.slice(1).every((arg) => arg === '--cached' || arg === '--recursive' || !arg.startsWith('-'))
  }
  if (subcommand === 'config') return isSafeGitConfigRead(args)
  return false
}

function readCliOptionValue(tokens: readonly string[], index: number, shortOption: string, longOption: string): string | undefined {
  const token = tokens[index]
  if ((shortOption && token === shortOption) || token === longOption) return tokens[index + 1]
  if (token?.startsWith(`${longOption}=`)) return token.slice(longOption.length + 1)
  if (shortOption && token?.startsWith(shortOption) && token.length > shortOption.length) return token.slice(shortOption.length)
  return undefined
}

function isUnsafeHeaderValue(value: string | undefined): boolean {
  if (!value || value.startsWith('@')) return true
  return /^(?:x-http-method-override|x-method-override|x-http-method)\s*:/i.test(value)
}

function isSafeCurlRead(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false
  const dangerousLongOptions = [
    '--output', '--remote-name', '--remote-name-all', '--output-dir', '--remote-header-name',
    '--upload-file', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode',
    '--json', '--form', '--form-string', '--config', '--cookie-jar', '--dump-header', '--trace',
    '--trace-ascii', '--trace-config', '--libcurl', '--etag-save', '--hsts', '--alt-svc',
    '--write-out', '--stderr', '--netrc', '--netrc-file', '--cert', '--key', '--proxy-cert',
    '--proxy-key', '--proto', '--proto-redir', '--unix-socket', '--abstract-unix-socket',
    '--next', '--variable', '--url-query', '--cookie', '--engine', '--quote',
  ]
  if (hasOption(tokens, ...dangerousLongOptions)) return false
  if (tokens.some((token) => token.startsWith('--expand-'))) return false
  if (tokens.some((token) => /^-[^-]/.test(token) && /[oOdFTKcbD wEJ]/.test(token.slice(1).replace(/X(?:GET|HEAD)?/i, '')))) {
    return false
  }

  let method = 'GET'
  let hasHttpUrl = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const requestedMethod = readCliOptionValue(tokens, index, '-X', '--request')
    if (requestedMethod !== undefined) {
      method = requestedMethod.toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') return false
    }
    if (token === '-I' || token === '--head' || (/^-[^-]/.test(token) && token.slice(1).includes('I'))) method = 'HEAD'

    const header = readCliOptionValue(tokens, index, '-H', '--header')
      ?? readCliOptionValue(tokens, index, '', '--proxy-header')
    if (header !== undefined && isUnsafeHeaderValue(header)) return false
    if (token.startsWith('@')) return false
    if (/^https?:\/\//i.test(token) || /^--url=https?:\/\//i.test(token)) hasHttpUrl = true
  }
  return hasHttpUrl && (method === 'GET' || method === 'HEAD')
}

const GH_READ_ACTIONS = new Map<string, ReadonlySet<string>>([
  ['release', new Set(['list', 'view'])],
  ['pr', new Set(['list', 'view', 'status', 'checks', 'diff'])],
  ['issue', new Set(['list', 'view', 'status'])],
  ['repo', new Set(['list', 'view'])],
  ['run', new Set(['list', 'view'])],
  ['workflow', new Set(['list', 'view'])],
  ['search', new Set(['code', 'commits', 'issues', 'prs', 'repos'])],
])

function isSafeGhApiRead(tokens: readonly string[]): boolean {
  let method: string | undefined
  let endpoint: string | undefined
  const optionsWithValues = new Set([
    '--method', '-X', '--hostname', '--preview', '-H', '--header', '--jq', '-q', '--template', '-t',
  ])
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (/^-[fF](?:.|$)/.test(token)
      || ['--raw-field', '--field', '--input', '--cache'].some((option) => token === option || token.startsWith(`${option}=`))) {
      return false
    }
    const requestedMethod = readCliOptionValue(tokens, index, '-X', '--method')
    if (requestedMethod !== undefined) {
      method = requestedMethod.toUpperCase()
      if (method !== 'GET') return false
    }
    const header = readCliOptionValue(tokens, index, '-H', '--header')
    if (header !== undefined && isUnsafeHeaderValue(header)) return false
    if (token.startsWith('@')) return false

    if (optionsWithValues.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    endpoint ??= token
  }
  return method === 'GET' && endpoint !== undefined && endpoint.toLowerCase() !== 'graphql'
}

function isSafeGhRead(tokens: readonly string[]): boolean {
  if (tokens.some((token) => token === '--web' || token.startsWith('--web=') || token === '--output' || token.startsWith('--output='))) {
    return false
  }
  const family = tokens[0]?.toLowerCase()
  if (!family) return false
  if (family === 'api') return isSafeGhApiRead(tokens)
  const action = tokens[1]?.toLowerCase()
  return action !== undefined && GH_READ_ACTIONS.get(family)?.has(action) === true
}

function isSafeRestrictedReadOnlyStage(stage: ShellCommandStage): boolean {
  if (isSafeKnownReadOnlyStage(stage)) return true
  if (stage.environment.length > 0) return false
  const tokens = [...stage.argv]
  const executable = executableName(tokens.shift())
  if (executable === 'curl') return isSafeCurlRead(tokens)
  if (executable === 'gh') return isSafeGhRead(tokens)
  return false
}


const FIND_SIDE_EFFECT_OPTIONS = [
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls',
]

function isSafeSedProgram(program: string): boolean {
  // Bounded subset: stdout-only numeric/regex selection or one substitution expression.
  // This avoids trying to implement sed's full language, where e executes a shell and w writes files.
  const source = program.trim()
  if (/^(?:\d+|\$)(?:,(?:\d+|\$))?[pPdDqQnN=]$/.test(source)) return true
  if (/^\/(?:\\.|[^/])+\/[pPdDqQnN=]$/.test(source)) return true
  if (source[0] !== 's') return false
  const delimiter = source[1]
  if (!delimiter || /[A-Za-z0-9\\\r\n]/.test(delimiter)) return false
  let index = 2
  const consumeSection = (): boolean => {
    let escaped = false
    while (index < source.length) {
      const char = source[index++]!
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === delimiter) return true
    }
    return false
  }
  if (!consumeSection() || !consumeSection()) return false
  return /^[0-9gpimM]*$/.test(source.slice(index))
}

function isSafeAwkRead(tokens: readonly string[]): boolean {
  let program: string | undefined
  const safeSwitches = new Set([
    '--bignum', '--characters-as-bytes', '--csv', '--lint', '--lint-old', '--non-decimal-data',
    '--optimize', '--posix', '--re-interval', '--sandbox', '--traditional', '--use-lc-numeric',
  ])
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') {
      program = tokens[index + 1]
      break
    }
    if (token === '-F' || token === '--field-separator' || token === '-v' || token === '--assign') {
      if (tokens[++index] === undefined) return false
      continue
    }
    if (/^-F.+/.test(token) || /^-v.+/.test(token)
      || token.startsWith('--field-separator=') || token.startsWith('--assign=')) continue
    if (token === '-e' || token === '--source') {
      program = tokens[++index]
      if (program === undefined) return false
      break
    }
    if (token.startsWith('-e') && token.length > 2) {
      program = token.slice(2)
      break
    }
    if (token.startsWith('--source=')) {
      program = token.slice('--source='.length)
      break
    }
    if (safeSwitches.has(token)) continue
    if (token.startsWith('-')) return false
    program = token
    break
  }
  if (!program) return false
  // This intentionally recognizes a bounded inline program subset rather than attempting to
  // parse awk. GNU awk --sandbox is also injected at runtime as defense in depth.
  if (/\b(?:system|getline|close)\s*(?:\(|\b)/i.test(program)) return false
  if (/@(?:load|include)\b/i.test(program)) return false
  if (/\b(?:print|printf)\b[^;\n}]*?(?:>>?|\|&?)/i.test(program)) return false
  return true
}

function isSafeSedRead(tokens: readonly string[]): boolean {
  const programs: string[] = []
  let positionalProgramSeen = false
  const safeSwitches = new Set([
    '-E', '-r', '-n', '-u', '-z', '--regexp-extended', '--quiet', '--silent', '--sandbox',
    '--separate', '--unbuffered', '--zero-terminated', '--posix', '--debug',
  ])
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') {
      if (!positionalProgramSeen && tokens[index + 1] !== undefined) programs.push(tokens[++index]!)
      positionalProgramSeen = true
      continue
    }
    if (token === '-e' || token === '--expression') {
      const program = tokens[++index]
      if (program === undefined) return false
      programs.push(program)
      continue
    }
    if (token.startsWith('-e') && token.length > 2) {
      programs.push(token.slice(2))
      continue
    }
    if (token.startsWith('--expression=')) {
      programs.push(token.slice('--expression='.length))
      continue
    }
    if (token === '-l' || token === '--line-length') {
      if (tokens[++index] === undefined) return false
      continue
    }
    if (token.startsWith('--line-length=')) continue
    if (safeSwitches.has(token) || /^-[Enruz]+$/.test(token)) continue
    if (token.startsWith('-')) return false
    if (!positionalProgramSeen) {
      programs.push(token)
      positionalProgramSeen = true
    }
  }
  return programs.length > 0 && programs.every(isSafeSedProgram)
}

function isSafeTarExtractToStdout(tokens: readonly string[]): boolean {
  let hasExtract = false
  let hasToStdout = false
  let archiveSource: string | undefined
  let memberCount = 0

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') {
      if (archiveSource === undefined) return false
      memberCount += tokens.length - index - 1
      break
    }

    if (token.startsWith('--')) {
      const [optionName, inlineValue] = token.split('=', 2)
      switch (optionName) {
        case '--extract':
        case '--get':
          if (inlineValue !== undefined) return false
          hasExtract = true
          break
        case '--to-stdout':
          if (inlineValue !== undefined) return false
          hasToStdout = true
          break
        case '--file': {
          const archive = inlineValue ?? tokens[++index]
          if (!archive || archiveSource !== undefined) return false
          archiveSource = archive
          break
        }
        case '--gzip':
        case '--gunzip':
        case '--ungzip':
        case '--bzip2':
        case '--xz':
        case '--auto-compress':
        case '--verbose':
          if (inlineValue !== undefined) return false
          break
        default:
          return false
      }
      continue
    }

    if (/^-[^-]/.test(token)) {
      const flags = token.slice(1)
      for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
        const flag = flags[flagIndex]!
        if (flag === 'x') {
          hasExtract = true
          continue
        }
        if (flag === 'O') {
          hasToStdout = true
          continue
        }
        if (['z', 'j', 'J', 'v'].includes(flag)) continue
        if (flag === 'f') {
          const attachedArchive = flags.slice(flagIndex + 1)
          const archive = attachedArchive || tokens[++index]
          if (!archive || archiveSource !== undefined) return false
          archiveSource = archive
          break
        }
        return false
      }
      continue
    }

    if (archiveSource === undefined) return false
    memberCount += 1
  }

  return hasExtract && hasToStdout && archiveSource === '-' && memberCount > 0
}

function isSafeTarRead(tokens: readonly string[]): boolean {
  if (isSafeTarExtractToStdout(tokens)) return true
  return (hasOption(tokens, '--list') || hasGroupedShortFlag(tokens, 't'))
    && !hasLongOptionOrAbbreviation(
      tokens,
      '--extract', '--get', '--create', '--append', '--update', '--concatenate',
      '--delete', '--to-command', '--checkpoint-action', '--use-compress-program',
      '--info-script', '--new-volume-script', '--rsh-command', '--index-file', '--listed-incremental',
      '--files-from',
    )
    && !['c', 'x', 'r', 'u', 'A', 'F', 'I', 'T'].some((flag) => hasGroupedShortFlag(tokens, flag))
}

function isSafeKnownReadOnlyInvocation(command: string, analysis = shellAnalysis(command)): boolean {
  return analysis.status === 'static'
    && analysis.stages.length === 1
    && analysis.operators.length === 0
    && analysis.stages[0]!.provenance === 'top-level'
    && analysis.stages[0]!.redirects.length === 0
    && isSafeKnownReadOnlyStage(analysis.stages[0]!)
}

function isSafeKnownReadOnlyStage(stage: ShellCommandStage): boolean {
  if (stage.environment.length > 0) return false
  const tokens = [...stage.argv]
  const executable = executableName(tokens.shift())
  if (!executable) return false

  switch (executable) {
    case 'pwd':
      return tokens.every((token) => token === '-L' || token === '-P')
    case 'echo':
    case 'printf':
    case 'basename':
    case 'dirname':
    case 'cut':
    case 'tr':
    case 'uniq':
    case 'id':
    case 'printenv':
    case 'ps':
    case 'zipinfo':
    case 'true':
    case 'false':
      return true
    case 'tasklist':
      return !tokens.some((token) => /^\/(?:S|U|P)(?::|$)/i.test(token))
    case 'sort':
      return !hasLongOptionOrAbbreviation(tokens, '--output', '--compress-program', '--temporary-directory')
        && !hasGroupedShortFlag(tokens, 'o')
        && !hasGroupedShortFlag(tokens, 'T')
    case 'date':
      return !hasLongOptionOrAbbreviation(tokens, '--set') && !hasGroupedShortFlag(tokens, 's')
    case 'tar':
      return isSafeTarRead(tokens)
    case 'unzip':
      return hasOption(tokens, '-l') && !hasOption(tokens, '-p')
    case 'ls':
    case 'dir':
    case 'cat':
    case 'head':
      return true
    case 'wc':
      return true
    case 'tail':
      return !hasOption(tokens, '--follow', '--pid')
        && !hasGroupedShortFlag(tokens, 'f')
        && !hasGroupedShortFlag(tokens, 'F')
    case 'grep':
      return true
    case 'awk':
    case 'gawk':
      return isSafeAwkRead(tokens)
    case 'sed':
      return isSafeSedRead(tokens)
    case 'rg':
      return !hasOption(tokens, '--pre', '--pre-glob', '--hostname-bin', '--search-zip')
        && !hasGroupedShortFlag(tokens, 'z')
    case 'fd':
    case 'fdfind':
      return !hasOption(tokens, '--exec', '--exec-batch', '--list-details')
        && !hasGroupedShortFlag(tokens, 'x')
        && !hasGroupedShortFlag(tokens, 'X')
        && !hasGroupedShortFlag(tokens, 'l')
    case 'tree':
      return !hasOption(tokens, '--output')
        && !hasGroupedShortFlag(tokens, 'o')
    case 'file':
      return !hasOption(tokens, '--compile', '--preserve-date', '--uncompress', '--uncompress-noreport')
        && !hasGroupedShortFlag(tokens, 'C')
        && !hasGroupedShortFlag(tokens, 'p')
        && !hasGroupedShortFlag(tokens, 'z')
        && !hasGroupedShortFlag(tokens, 'Z')
    case 'env':
      return tokens.length === 0
    case 'whoami':
      return tokens.length === 0
    case 'uname':
      return tokens.every((token) => /^-[asnrvmpio]+$/i.test(token) || token === '--all')
    case 'node':
    case 'bun':
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return tokens.length === 1 && (tokens[0] === '--version' || tokens[0] === '-v')
    case 'stat':
    case 'realpath':
    case 'readlink':
    case 'which':
    case 'where':
    case 'du':
    case 'df':
    case 'jq':
    case 'diff':
    case 'cmp':
    case 'md5sum':
    case 'sha1sum':
    case 'sha224sum':
    case 'sha256sum':
    case 'sha384sum':
    case 'sha512sum':
      return true
    case 'git':
      return isSafeGitRead(tokens)
    case 'find':
      return !hasOption(tokens, ...FIND_SIDE_EFFECT_OPTIONS)
    default:
      return false
  }
}

function stageExecutableAndArgs(stage: ShellCommandStage): { executable?: string; args: string[]; argumentsStatic: boolean } {
  const { executable, rest } = unwrapCommandExecutableParts(stage.argvParts)
  return {
    executable,
    args: rest.filter((token): token is string => token !== undefined),
    argumentsStatic: stage.argumentsStatic && rest.every((token) => token !== undefined),
  }
}

interface DeletionPathFacts {
  paths: string[]
  complete: boolean
}

const POWERSHELL_DELETE_COMMANDS = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'])
const DIRECT_DELETE_COMMANDS = new Set(['rm', 'unlink', 'rmdir', 'del', 'erase', 'remove-item', 'ri', 'rd'])

const POWERSHELL_REMOVE_ITEM_SWITCHES = new Set([
  'force', 'recurse', 'confirm', 'whatif', 'verbose', 'debug',
])
const POWERSHELL_REMOVE_ITEM_VALUE_OPTIONS = new Set([
  'filter', 'include', 'exclude', 'credential', 'stream',
  'erroraction', 'warningaction', 'informationaction', 'progressaction',
  'errorvariable', 'warningvariable', 'informationvariable', 'outvariable',
  'outbuffer', 'pipelinevariable',
])

function extractPowerShellRemoveItemFacts(stage: ShellCommandStage): DeletionPathFacts {
  const { rest } = unwrapCommandExecutableParts(stage.argvParts)
  const paths: string[] = []
  let complete = stage.receivesPipelineInput !== true
  let mode: 'positional' | 'paths' | 'skip-value' = 'positional'
  for (const token of rest) {
    if (token === undefined) {
      complete = false
      mode = 'positional'
      continue
    }
    if (token.startsWith('-')) {
      const option = token.replace(/^-+/, '').toLowerCase()
      if (option === 'path' || option === 'literalpath') mode = 'paths'
      else if (POWERSHELL_REMOVE_ITEM_SWITCHES.has(option)) mode = 'positional'
      else if (POWERSHELL_REMOVE_ITEM_VALUE_OPTIONS.has(option)) mode = 'skip-value'
      else {
        complete = false
        mode = 'skip-value'
      }
      continue
    }
    if (mode === 'skip-value') {
      mode = 'positional'
      continue
    }
    paths.push(token)
  }
  return { paths, complete }
}

function extractDeletionPathFactsFromStage(stage: ShellCommandStage): DeletionPathFacts {
  const { executable, args, argumentsStatic } = stageExecutableAndArgs(stage)
  if (!executable || !DIRECT_DELETE_COMMANDS.has(executable)) return { paths: [], complete: true }
  if (stage.dialect === 'powershell' && POWERSHELL_DELETE_COMMANDS.has(executable)) {
    return extractPowerShellRemoveItemFacts(stage)
  }
  if (executable === 'remove-item' || executable === 'ri' || executable === 'rd') return { paths: [], complete: false }
  return {
    paths: args.filter((token) => {
      if (!token || token.startsWith('-')) return false
      return !(['del', 'erase'].includes(executable) && /^\/[a-z]+$/i.test(token))
    }),
    complete: argumentsStatic,
  }
}

function extractDeletionPathsFromStage(stage: ShellCommandStage): string[] {
  return extractDeletionPathFactsFromStage(stage).paths
}

export function extractDirectDeletionPaths(command: string, analysis = shellAnalysis(command)): string[] {
  return executableStages(command, analysis).flatMap(extractDeletionPathsFromStage)
}

/** PowerShell 有界数据流解析出的变量删除目标；Policy 只可在宿主提供的 managed roots 内信任。 */
export function extractVariableResolvedDeletionPaths(command: string, analysis = shellAnalysis(command)): string[] {
  return executableStages(command, analysis).flatMap((stage) => (
    stage.argumentsResolvedFromVariables ? extractDeletionPathsFromStage(stage) : []
  ))
}


/** 已看见真实删除 executable，但动态参数使目标路径无法完整证明。 */
export function hasUnresolvedDirectDeletion(command: string, analysis = shellAnalysis(command)): boolean {
  if (analysis.reasonCodes.some((code) => [
    'powershell-parser-unavailable',
    'powershell-parser-returned-null',
    'powershell-parser-threw',
    'powershell-unparsed-delete',
    'powershell-unmodeled-execution',
  ].includes(code))) return true
  return executableStages(command, analysis).some((stage) => {
    const { executable } = stageExecutableAndArgs(stage)
    return executable !== undefined
      && DIRECT_DELETE_COMMANDS.has(executable)
      && !extractDeletionPathFactsFromStage(stage).complete
  })
}

function stageMayUseProcessNetwork(stage: ShellCommandStage): boolean {
  const { executable, args } = stageExecutableAndArgs(stage)
  const firstArg = args[0]?.toLowerCase()
  if (executable && ['bun', 'npm', 'pnpm', 'yarn'].includes(executable)) {
    return firstArg !== undefined && ['install', 'add', 'update', 'upgrade'].includes(firstArg)
  }
  if ((executable === 'pip' || executable === 'pip3') && firstArg === 'install') return true
  if (executable && ['gh', 'curl', 'wget', 'invoke-webrequest', 'invoke-restmethod'].includes(executable)) return true
  if (executable === 'git') {
    const invocation = extractGitInvocationFromStage(stage)[0]
    return invocation !== undefined && ['clone', 'fetch', 'pull', 'ls-remote'].includes(invocation.subcommand)
  }
  return false
}

export function mayUseProcessNetwork(command: string, analysis = shellAnalysis(command)): boolean {
  const stages = executableStages(command, analysis)
  return stages.some(stageMayUseProcessNetwork)
    || extractGitInvocations(command, analysis).some(({ subcommand }) => ['clone', 'fetch', 'pull', 'ls-remote'].includes(subcommand))
}

function stageHasExternalImpact(stage: ShellCommandStage): boolean {
  const { executable, args } = stageExecutableAndArgs(stage)
  const first = args[0]?.toLowerCase()
  const second = args[1]?.toLowerCase()
  if (executable === 'gh' && first === 'release' && ['create', 'upload', 'edit', 'delete'].includes(second ?? '')) return true
  if (executable && ['npm', 'pnpm', 'yarn', 'bun', 'cargo'].includes(executable) && first === 'publish') return true
  if (executable === 'dotnet' && first === 'nuget' && second === 'push') return true
  if (executable && ['vercel', 'netlify', 'wrangler', 'flyctl', 'railway'].includes(executable) && first === 'deploy') return true
  if (executable === 'terraform' && first === 'apply') return true
  if (executable === 'kubectl' && first === 'apply') return true
  return executable === 'helm' && (first === 'install' || first === 'upgrade')
}

export function hasExternalImpact(command: string, analysis = shellAnalysis(command)): boolean {
  return extractGitInvocations(command, analysis).some(({ subcommand }) => subcommand === 'push')
    || executableStages(command, analysis).some(stageHasExternalImpact)
}

export function isDestructiveGitCommand(command: string, analysis = shellAnalysis(command)): boolean {
  return extractGitInvocations(command, analysis).some(({ subcommand, args, argumentsStatic }) => {
    if (subcommand === 'restore' || subcommand === 'clean') return true
    if (subcommand === 'reset') return args.includes('--hard') || !argumentsStatic
    if (subcommand === 'checkout') {
      return !argumentsStatic || args.includes('--') || args.some((arg) => arg === '-f' || arg === '--force')
    }
    return subcommand === 'switch'
      && (!argumentsStatic || args.some((arg) => arg === '-f' || arg === '--force' || arg === '--discard-changes'))
  })
}

/**
 * 从命令中提取可能指向文件系统的路径候选，供 Workspace Boundary 做真实路径校验。
 * 覆盖三种拼写：Windows 盘符（G:/、G:\）、POSIX/MSYS（/g/foo）、相对路径（./、../、~/）。
 * 环境变量赋值、纯选项与命令名等无法证明是路径的 token 不参与判定。
 */
export function extractCommandPathCandidates(command: string, analysis = shellAnalysis(command)): string[] {
  const candidates: string[] = []
  const addCandidate = (raw: string): void => {
    if (!raw || raw === '-') return
    const candidate = (raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw)
      .replace(/^["']|["']$/g, '')
    if (!candidate) return
    if (
      /^[A-Za-z]:[\\/]/.test(candidate)
      || candidate.startsWith('/')
      || candidate.startsWith('~')
      || candidate.startsWith('\\\\')
      || /^[.][\\/]/.test(candidate)
      || /^\.[.][\\/]/.test(candidate)
    ) candidates.push(candidate)
  }

  for (const stage of executableStages(command, analysis)) {
    for (const token of stage.rawArgv.slice(1)) addCandidate(token.replace(/^["']|["']$/g, ''))
    for (const assignment of stage.environment) if (assignment.value !== undefined) addCandidate(assignment.value)
    for (const redirect of stage.redirects) if (redirect.target) addCandidate(redirect.target)
  }
  return candidates
}

/**
 * 提取已证明为只读的命令参数，交给 Workspace Boundary 做 canonical path 校验。
 * 非路径参数按相对路径处理只会更保守；Git 子命令本身不参与路径判断。
 */
export function extractKnownReadOnlyCommandPaths(command: string, analysis = shellAnalysis(command)): string[] {
  if (analysis.status !== 'static' || analysis.stages.length !== 1 || analysis.operators.length > 0) return []
  const [stage] = analysis.stages
  if (!isSafeKnownReadOnlyStage(stage!)) return []
  const tokens = [...stage!.argv]
  const executable = executableName(tokens.shift())
  if (executable === 'pwd') return []
  if (executable === 'git') tokens.shift()
  let optionsEnded = false
  return tokens.flatMap((token) => {
    if (!token || token === '-') return []
    if (token === '--') {
      optionsEnded = true
      return []
    }
    if (optionsEnded || !token.startsWith('-')) return [token]
    const equalsIndex = token.indexOf('=')
    return equalsIndex >= 0 && equalsIndex < token.length - 1
      ? [token.slice(equalsIndex + 1)]
      : []
  })
}

export function isKnownReadOnlyCommand(command: string, analysis = shellAnalysis(command)): boolean {
  return isSafeKnownReadOnlyInvocation(command, analysis)
}

/**
 * Git 的查询命令仍可能刷新 index、调用 fsmonitor、pager、external diff 或 textconv。
 * Bash spawn hook 在执行已授权命令前注入这些 Git 原生禁用项，不改变其它命令。
 */
export function hardenKnownReadOnlyGitCommand(command: string): string {
  if (!isKnownReadOnlyCommand(command)) return command
  return command.replace(
    /^(\s*git(?:\.exe)?)\s+(status|diff|log|show|rev-parse|branch|remote|tag|ls-files|worktree|ls-remote|describe|merge-base|name-rev|shortlog|blame|grep|ls-tree|cat-file|for-each-ref|show-ref|check-ignore|count-objects|reflog|stash|submodule|config)\b/i,
    (_match, executable: string, subcommand: string) => {
      const normalizedSubcommand = subcommand.toLowerCase()
      const diffGuards = ['diff', 'log', 'show'].includes(normalizedSubcommand)
        ? ' --no-ext-diff --no-textconv'
        : ''
      const repositoryGuard = normalizedSubcommand === 'config' ? '' : ' -c core.fsmonitor=false'
      const networkGuard = normalizedSubcommand === 'ls-remote'
        ? ' -c protocol.allow=never -c protocol.http.allow=always -c protocol.https.allow=always -c protocol.ssh.allow=always -c protocol.git.allow=always -c protocol.file.allow=always'
        : ''
      return `${executable} --no-pager --no-optional-locks${repositoryGuard}${networkGuard} ${subcommand}${diffGuards}`
    },
  )
}

/** 执行前同时禁用 ripgrep 用户配置，防止配置文件重新开启 `--pre` 等外部程序。 */
export function hardenKnownReadOnlyCommand(command: string): string {
  const hardenedGit = hardenKnownReadOnlyGitCommand(command)
  if (hardenedGit !== command || !isKnownReadOnlyCommand(command)) return hardenedGit
  if (/^\s*(?:g?awk)(?:\.exe)?\b/i.test(command)) {
    if (/\s--sandbox(?:\s|$)/i.test(command)) return command
    return command.replace(/^(\s*(?:g?awk)(?:\.exe)?)\b/i, '$1 --sandbox')
  }
  if (/^\s*sed(?:\.exe)?\b/i.test(command)) {
    if (/\s--sandbox(?:\s|$)/i.test(command)) return command
    return command.replace(/^(\s*sed(?:\.exe)?)\b/i, '$1 --sandbox')
  }
  if (/^\s*tar(?:\.exe)?\b/i.test(command)) {
    return command.replace(/^(\s*)(tar(?:\.exe)?)\b/i, '$1TAR_OPTIONS= $2')
  }
  if (/\s--no-config(?:\s|$)/i.test(command)) return command
  return command.replace(/^(\s*rg(?:\.exe)?)\b/i, '$1 --no-config')
}

/**
 * 剥离只读 `cd <路径> &&|;` 前缀，返回剩余命令；无法剥离时返回 undefined。
 * 仅供 Read Only / Plan First 的宽松授权入口使用，不影响严格单命令分类。
 */
export function stripReadOnlyCdPrefix(command: string, analysis = shellAnalysis(command)): string | undefined {
  if (analysis.status !== 'static' || analysis.stages.length < 2) return undefined
  const [first, second] = analysis.stages
  if (first!.provenance !== 'top-level'
    || first!.executable.toLowerCase().replace(/\.exe$/, '') !== 'cd'
    || first!.environment.length > 0
    || first!.argv.length > 2
    || (analysis.operators[0] !== '&&' && analysis.operators[0] !== ';')) return undefined
  return command.slice(second!.start).trim()
}

/**
 * Read Only / Plan First 的 Bash 授权入口。有限组合中的每个 stage 都必须独立通过
 * 严格只读白名单；普通文件重定向、动态展开和未知命令仍 fail closed。
 */
function hasOnlySafeReadRedirects(stage: ShellCommandStage): boolean {
  return stage.redirects.every((redirect) => {
    if (redirect.operator === '>&') {
      return redirect.target === '1' || redirect.target === '2'
    }
    return (redirect.operator === '<' || redirect.operator === '>' || redirect.operator === '>>')
      && redirect.target === '/dev/null'
  })
}

function isReadOnlyPowerShellWrapper(analysis: ShellAnalysis): boolean {
  const wrapper = analysis.stages.find((stage) => stage.provenance === 'top-level')
  const executable = executableName(wrapper?.executable)
  if (!wrapper || (executable !== 'powershell' && executable !== 'pwsh')) return false
  if (wrapper.environment.length > 0 || wrapper.redirects.length > 0 || !wrapper.argumentsStatic
    || wrapper.embeddedSourceReadOnly !== true) return false

  const args = wrapper.argv.slice(1)
  const commandIndex = args.findIndex((token) => /^-(?:command|c)$/i.test(token))
  if (commandIndex < 0 || commandIndex !== args.length - 2) return false
  if (!args.slice(0, commandIndex).some((token) => /^-(?:noprofile|nop)$/i.test(token))) return false
  if (args.slice(0, commandIndex).some((token) => !/^-(?:noprofile|nop|noninteractive|noni|nologo)$/i.test(token))) return false

  const nested = analysis.stages.filter((stage) => stage !== wrapper)
  return nested.length > 0
    && nested.every((stage) => stage.dialect === 'powershell' && stage.provenance === 'wrapper')
}

export function isReadOnlyBashCommandAllowlisted(command: string, analysis = shellAnalysis(command)): boolean {
  if (isReadOnlyPowerShellWrapper(analysis)) return true
  if (analysis.status !== 'static' || analysis.stages.length === 0) return false
  if (analysis.stages.some((stage) => stage.provenance !== 'top-level' || !hasOnlySafeReadRedirects(stage))) return false

  let stages = analysis.stages
  let operators = analysis.operators
  if (stages[0]?.executable.toLowerCase().replace(/\.exe$/, '') === 'cd') {
    if (stages[0].environment.length > 0 || stages[0].argv.length > 2) return false
    if (operators[0] !== '&&' && operators[0] !== ';') return false
    stages = stages.slice(1)
    operators = operators.slice(1)
  }
  if (stages.length === 0 || operators.length !== stages.length - 1) return false
  return stages.every(isSafeRestrictedReadOnlyStage)
}

function hardenRestrictedReadOnlyCommand(command: string): string {
  const hardenedKnownCommand = hardenKnownReadOnlyCommand(command)
  if (hardenedKnownCommand !== command) return hardenedKnownCommand
  if (/^\s*curl(?:\.exe)?\s/i.test(command)) {
    return command.replace(/^(\s*curl(?:\.exe)?)/i, '$1 --disable --proto =http,https --proto-redir =http,https')
  }
  return command
}

function hardenReadOnlyShellSequence(command: string): string {
  const analysis = shellAnalysis(command)
  if (!isReadOnlyBashCommandAllowlisted(command) || analysis.status !== 'static') return command

  const replacements = analysis.stages
    .filter((stage) => stage.executable.toLowerCase().replace(/\.exe$/, '') !== 'cd')
    .map((stage) => {
      const rawCore = command.slice(stage.start, stage.commandEnd)
      const trailingWhitespace = rawCore.match(/\s+$/)?.[0] ?? ''
      const core = rawCore.slice(0, rawCore.length - trailingWhitespace.length)
      return {
        start: stage.start,
        end: stage.commandEnd,
        value: `${hardenRestrictedReadOnlyCommand(core)}${trailingWhitespace}`,
      }
    })
    .filter((replacement) => replacement.value !== command.slice(replacement.start, replacement.end))
    .sort((left, right) => right.start - left.start)

  return replacements.reduce((current, replacement) => (
    `${current.slice(0, replacement.start)}${replacement.value}${current.slice(replacement.end)}`
  ), command)
}

/** 对受限 workflow 已证明安全的每个真实 executable stage 注入 rg/git/curl/awk/PowerShell 只读护栏。 */
export function hardenReadOnlyBashCommand(command: string): string {
  const analysis = shellAnalysis(command)
  if (isReadOnlyPowerShellWrapper(analysis)) {
    const wrapper = analysis.stages.find((stage) => stage.provenance === 'top-level')
    if (wrapper && !/\s-(?:noninteractive|noni)(?:\s|$)/i.test(wrapper.sourceText)) {
      return `${command.slice(0, wrapper.start)}${wrapper.sourceText.replace(/^(\s*(?:powershell|pwsh)(?:\.exe)?)/i, '$1 -NonInteractive')}${command.slice(wrapper.end)}`
    }
    return command
  }
  return hardenReadOnlyShellSequence(command)
}

export function isKnownValidationCommand(command: string, analysis = shellAnalysis(command)): boolean {
  if (!command || analysis.status !== 'static' || analysis.stages.length !== 1 || analysis.operators.length > 0
    || SHELL_CONTROL_SYNTAX.test(command) || hasExplicitBoundaryEscape(analysis)) return false
  return KNOWN_VALIDATION_COMMANDS.some((pattern) => pattern.test(command))
}

/** 解释器：执行脚本文件或 -c 代码，等价于运行任意代码（参考 Open-ClaudeCode dangerousPatterns.ts）。 */
const CODE_EXECUTION_INTERPRETERS = new Set([
  'python', 'python2', 'python3',
  'node', 'deno', 'tsx',
  'ruby', 'perl', 'php', 'lua',
  'bun',
])

/** 包运行器：npx/bunx 会下载并执行任意包，等价于任意代码执行。 */
const CODE_EXECUTION_PACKAGE_RUNNERS = new Set(['npx', 'bunx'])

/** 脚本运行器：执行 package.json 脚本（任意代码）；bun run 已由解释器分支覆盖。 */
const SCRIPT_RUNNERS = new Map<string, string>([
  ['npm', 'run'],
  ['yarn', 'run'],
  ['pnpm', 'run'],
])

/** shell 包装：bash/sh/zsh 可 -c 执行任意代码或运行脚本文件。 */
const CODE_EXECUTION_SHELLS = new Set(['bash', 'sh', 'zsh'])

/** bun 的包管理子命令（网络/常规操作，由 process-network 等检查覆盖，不算代码执行）。 */
const BUN_PACKAGE_MANAGER_COMMANDS = new Set([
  'install', 'add', 'update', 'upgrade', 'remove', 'link', 'unlink', 'pm', 'plugin',
])

/**
 * 解析命令的（可能被 env/command 包装的）真实可执行名与剩余参数。
 * 归一化 .exe 后缀与路径，并复用 Canonical argv wrapper 规则。
 */
function unwrapCommandExecutable(tokens: readonly string[]): {
  executable: string | undefined
  rest: string[]
} {
  const { executable, rest } = unwrapCommandExecutableParts(tokens)
  return { executable, rest: rest.filter((token): token is string => token !== undefined) }
}

/**
 * 判断命令是否执行任意代码：解释器 / 包运行器 / 脚本运行器 / shell 包装。
 * 已知验证命令（typecheck/test/lint/build 等）不视为任意代码执行。
 * 受控执行用此判定把「解释器跑任意内容」显式归入需审批类别，防止
 * `python script.py`、`npx package`、`bash -c "..."` 等绕过命令白名单。
 */
export function isCodeExecutionCommand(command: string, analysis = shellAnalysis(command)): boolean {
  if (!command) return false
  if (isKnownValidationCommand(command, analysis)) return false
  for (const stage of executableStages(command, analysis)) {
    let { executable, rest } = unwrapCommandExecutable(stage.argv)
    if ((!executable || !CODE_EXECUTION_INTERPRETERS.has(executable)) && stage.rawArgv[0]?.includes('\\')) {
      const rawExecutable = shellExecutable(stage.rawArgv[0])?.replace(/\.exe$/i, '')
      if (rawExecutable) {
        executable = rawExecutable
        rest = stage.argv.slice(1)
      }
    }
    if (!executable) continue
    if (CODE_EXECUTION_INTERPRETERS.has(executable)) {
      // bun 兼解释器与包管理器：包管理子命令不算代码执行，其余（run <script>、<file>）算。
      if (executable === 'bun' && rest[0] && BUN_PACKAGE_MANAGER_COMMANDS.has(rest[0].toLowerCase())) continue
      return true
    }
    if (CODE_EXECUTION_PACKAGE_RUNNERS.has(executable)) return true
    const runFlag = SCRIPT_RUNNERS.get(executable)
    if (runFlag && rest.some((token) => token === runFlag)) return true
    if (CODE_EXECUTION_SHELLS.has(executable)) return true
  }
  return false
}
