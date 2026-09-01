import { beforeAll, describe, expect, test } from 'bun:test'
import type { AgentWorkflow } from '@domi/shared'
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent'
import { buildWslBashArgs, createDomiBashToolOptions, windowsPathToWslPath } from './pi-agent-adapter'
import { initializeShellAnalysis } from '../execution-policy/shell-analysis.ts'

beforeAll(async () => {
  await initializeShellAnalysis()
})

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

  test('Given Workflow hot-switches When Bash spawns Then only restricted workflows harden read-only commands', async () => {
    let workflow: AgentWorkflow = 'direct'
    const options = createDomiBashToolOptions(undefined, () => workflow)

    expect(await options.spawnHook?.({ command: 'git status --short', cwd: '/repo', env: {} }))
      .toMatchObject({ command: 'git status --short' })

    workflow = 'read-only'
    expect(await options.spawnHook?.({ command: 'git status --short', cwd: '/repo', env: {} }))
      .toMatchObject({
        command: 'git --no-pager --no-optional-locks -c core.fsmonitor=false status --short',
        env: { GIT_OPTIONAL_LOCKS: '0' },
      })
    expect(await options.spawnHook?.({ command: 'rg TODO src', cwd: '/repo', env: {} }))
      .toMatchObject({ command: 'rg --no-config TODO src' })
    expect(await options.spawnHook?.({
      command: `grep error audit.log | sed -E 's/error/warn/g' | awk '{ count++ } END { print count }'`,
      cwd: '/repo',
      env: {},
    })).toMatchObject({
      command: `grep error audit.log | sed --sandbox -E 's/error/warn/g' | awk --sandbox '{ count++ } END { print count }'`,
    })
    expect(await options.spawnHook?.({
      command: `powershell.exe -NoProfile -Command "Get-Content 'audit.log' | Measure-Object -Line"`,
      cwd: '/repo',
      env: {},
    })).toMatchObject({
      command: `powershell.exe -NonInteractive -NoProfile -Command "Get-Content 'audit.log' | Measure-Object -Line"`,
    })
    expect(await options.spawnHook?.({
      command: 'curl -fsSL https://example.com | gh api --method GET rate_limit',
      cwd: '/repo',
      env: {},
    })).toMatchObject({
      command: 'curl --disable --proto =http,https --proto-redir =http,https -fsSL https://example.com | gh api --method GET rate_limit',
      env: {
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PAGER: 'cat',
        PAGER: 'cat',
        TAR_OPTIONS: '',
        UNZIP: '',
        UNZIPOPT: '',
        ZIPINFO: '',
        ZIPINFOOPT: '',
      },
    })
  })
})

describe('Pi Git Bash CMD null-device redirection guard', () => {
  const runtimeEnv = {
    env: { DOMI_WINDOWS_SHELL: 'git-bash' },
    shellKind: 'git-bash' as const,
    shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  }

  test('Given CMD null-device redirection When Git Bash is about to spawn Then rejects it with a POSIX replacement', () => {
    const options = createDomiBashToolOptions(runtimeEnv, () => 'direct')

    for (const command of [
      'git check-ignore .context 2>nul',
      'bun run build > NUL',
      'bun test > "NUL"',
      'printf "%s\\n" "$(git status 2>nul)"',
      "printf '%s\\n' \"`git status 2>nul`\"",
    ]) {
      expect(() => options.spawnHook?.({ command, cwd: 'D:\\repo', env: {} }))
        .toThrow('/dev/null')
    }

    expect(() => options.spawnHook?.({
      command: 'cmd.exe /c dir C:\\\\missing >nul',
      cwd: 'D:\\repo',
      env: {},
    })).toThrow('引号内参数')
  })

  test('Given a blocked command reaches the SDK Bash tool When resolving its spawn context Then execution never reaches shell operations', async () => {
    let executionCount = 0
    const tool = createBashToolDefinition('D:\\repo', {
      ...createDomiBashToolOptions(runtimeEnv, () => 'direct'),
      operations: {
        async exec() {
          executionCount += 1
          return { exitCode: 0 }
        },
      },
    })

    await expect(tool.execute(
      'bash-call-1',
      { command: 'echo ok 2>nul' },
      undefined,
      undefined,
      undefined as unknown as Parameters<typeof tool.execute>[4],
    )).rejects.toThrow('/dev/null')
    expect(executionCount).toBe(0)
  })

  test('Given POSIX redirection or an explicit quoted CMD command When Git Bash is about to spawn Then preserves it', async () => {
    const options = createDomiBashToolOptions(runtimeEnv, () => 'direct')

    for (const command of [
      'git check-ignore .context 2>/dev/null',
      'cmd.exe /c "dir C:\\\\missing >nul 2>nul"',
    ]) {
      expect(await options.spawnHook?.({ command, cwd: 'D:\\repo', env: {} }))
        .toMatchObject({ command })
    }
  })

  test('Given quoted literal text mentions CMD redirection When Git Bash is about to spawn Then does not mistake it for shell syntax', async () => {
    const options = createDomiBashToolOptions(runtimeEnv, () => 'direct')

    for (const command of [
      "printf '%s\\n' '2>nul > NUL'",
      'node -e "console.log(\'2>nul\')"',
      'printf "%s\\n" "> NUL"',
      'echo ok # a literal example: 2>nul',
    ]) {
      expect(await options.spawnHook?.({ command, cwd: 'D:\\repo', env: {} }))
        .toMatchObject({ command })
    }
  })

  test('Given another shell kind When spawning the same command Then the Git Bash-specific guard stays inactive', async () => {
    const options = createDomiBashToolOptions({ env: {}, shellKind: 'wsl' }, () => 'direct')

    expect(await options.spawnHook?.({ command: 'echo ok 2>nul', cwd: '/repo', env: {} }))
      .toMatchObject({ command: 'echo ok 2>nul' })
  })
})

describe('Pi Bash dependency snapshot capture', () => {
  test('Given an authorized exact frozen Bun install succeeds When Bash finishes Then snapshot capture runs before the successful result returns', async () => {
    const order: string[] = []
    const options = createDomiBashToolOptions(
      undefined,
      () => 'direct',
      async ({ cwd, command }) => {
        order.push(`capture:${cwd}:${command}`)
      },
      () => ({
        async exec() {
          order.push('exec')
          return { exitCode: 0 }
        },
      }),
    )

    const result = await options.operations!.exec('bun install --frozen-lockfile', 'D:\\repo', {
      onData: () => {},
    })

    expect(result).toEqual({ exitCode: 0 })
    expect(order).toEqual(['exec', 'capture:D:\\repo:bun install --frozen-lockfile'])
  })

  test('Given install fails, another command runs, or capture throws When Bash finishes Then command semantics and exit codes stay unchanged', async () => {
    let captureCount = 0
    let exitCode = 1
    const options = createDomiBashToolOptions(
      undefined,
      () => 'direct',
      async () => {
        captureCount += 1
        throw new Error('cache disk locked')
      },
      () => ({ exec: async () => ({ exitCode }) }),
    )

    const previousWarn = console.warn
    console.warn = () => {}
    try {
      expect(await options.operations!.exec('bun install --frozen-lockfile', '/repo', { onData: () => {} }))
        .toEqual({ exitCode: 1 })
      exitCode = 0
      expect(await options.operations!.exec('bun test', '/repo', { onData: () => {} }))
        .toEqual({ exitCode: 0 })
      expect(await options.operations!.exec('bun install --frozen-lockfile', '/repo', { onData: () => {} }))
        .toEqual({ exitCode: 0 })
      expect(captureCount).toBe(1)
    } finally {
      console.warn = previousWarn
    }
  })
})
