import { beforeAll, describe, expect, test } from 'bun:test'
import { extractDirectDeletionPaths, hasUnresolvedDirectDeletion } from './shell-command-classifier.ts'
import { analyzeShellCommand, initializeShellAnalysis } from './shell-analysis.ts'

beforeAll(async () => {
  await initializeShellAnalysis()
})

describe('analyzeShellCommand', () => {
  test('keeps quoted grep patterns literal instead of inventing executable Git stages', () => {
    const analysis = analyzeShellCommand(
      "wc -l session.jsonl && grep -n 'permission_request\\|git restore --worktree pnpm-lock.yaml' session.jsonl | tail -20",
    )

    expect(analysis.status).toBe('static')
    expect(analysis.stages.map((stage) => stage.argv?.[0])).toEqual(['wc', 'grep', 'tail'])
    expect(analysis.stages[1]?.argv).toEqual([
      'grep',
      '-n',
      'permission_request\\|git restore --worktree pnpm-lock.yaml',
      'session.jsonl',
    ])
    expect(analysis.stages.some((stage) => stage.argv?.[0] === 'git')).toBe(false)
  })

  test('never reinterprets quoted command text from search, JSON, SQL, or inline code', () => {
    for (const source of [
      "rg 'git reset --hard' docs",
      "grep 'git push origin' session.jsonl",
      "grep 'npm publish' README.md",
      "grep 'rm -rf' audit.log",
      `printf '%s' '{"command":"git clean -fd"}'`,
      `grep "SELECT 'git push' FROM audit" query.sql`,
      `node -e "console.log('git restore -- file')"`,
      "rg 'literal && text ; with | operators' docs",
    ]) {
      const analysis = analyzeShellCommand(source)
      expect(analysis.status, source).toBe('static')
      expect(analysis.stages, source).toHaveLength(1)
      expect(analysis.stages[0]!.sourceText, source).toBe(source)
    }
  })

  test('discovers real nested commands without treating the containing word as static', () => {
    const substitution = analyzeShellCommand(`echo "$(git push origin main)"`)
    expect(substitution.status).toBe('opaque')
    expect(substitution.stages.map((stage) => [stage.provenance, stage.argv[0]])).toContainEqual([
      'substitution',
      'git',
    ])

    for (const source of [
      'echo $((1 + $(git push origin main)))',
      'FOO=$(git push origin main) env',
      'cat >$(git push origin main)',
    ]) {
      const nested = analyzeShellCommand(source)
      expect(nested.status, source).toBe('opaque')
      expect(nested.stages.some((stage) => stage.provenance === 'substitution' && stage.argv[0] === 'git'), source)
        .toBe(true)
    }

    const wrapper = analyzeShellCommand(`bash -lc 'git worktree add C:/nested/wt && git status'`)
    expect(wrapper.status).toBe('static')
    expect(wrapper.stages.map((stage) => [stage.provenance, stage.argv[0]])).toEqual([
      ['top-level', 'bash'],
      ['wrapper', 'git'],
      ['wrapper', 'git'],
    ])
  })

  test('retains visible executable facts when arguments, redirects, or compound syntax stay opaque', () => {
    const dynamicArgument = analyzeShellCommand('git restore "$TARGET"')
    expect(dynamicArgument.status).toBe('opaque')
    expect(dynamicArgument.stages[0]).toMatchObject({
      executable: 'git',
      argvParts: ['git', 'restore', undefined],
      argumentsStatic: false,
    })

    const dynamicRedirect = analyzeShellCommand('git restore . > "$OUT"')
    expect(dynamicRedirect.status).toBe('opaque')
    expect(dynamicRedirect.stages[0]).toMatchObject({
      argvParts: ['git', 'restore', '.'],
      redirectsStatic: false,
    })

    const compound = analyzeShellCommand('(git reset --hard HEAD); { rm C:/local/dirty.txt; }')
    expect(compound.status).toBe('opaque')
    expect(compound.stages.map((stage) => stage.argv[0])).toEqual(['git', 'rm'])
  })

  test('uses PowerShell AST facts to resolve static Join-Path deletions without trusting runtime variables', () => {
    const staticCommand = String.raw`powershell.exe -NoProfile -Command '$logDir="C:\Users\A\.domi\agent-workspaces\app\session\.context";$stdout=Join-Path $logDir "backend.out.log";$stderr=Join-Path $logDir "backend.err.log";Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue'`
    const staticAnalysis = analyzeShellCommand(staticCommand)

    expect(staticAnalysis.reasonCodes).toContain('opaque-powershell-wrapper')
    expect(staticAnalysis.stages.filter((stage) => stage.executable.toLowerCase() === 'remove-item')).toHaveLength(1)
    expect(extractDirectDeletionPaths(staticCommand, staticAnalysis)).toEqual([
      'C:\\Users\\A\\.domi\\agent-workspaces\\app\\session\\.context\\backend.out.log',
      'C:\\Users\\A\\.domi\\agent-workspaces\\app\\session\\.context\\backend.err.log',
    ])
    expect(hasUnresolvedDirectDeletion(staticCommand, staticAnalysis)).toBeFalse()

    const aliasPath = String.raw`powershell.exe -Command 'rm "C:\workspace\alias-baseline.txt" -Force'`
    const aliasAnalysis = analyzeShellCommand(aliasPath)
    expect(extractDirectDeletionPaths(aliasPath, aliasAnalysis)).toEqual(['C:\\workspace\\alias-baseline.txt'])

    const switchedPath = String.raw`powershell.exe -Command 'Remove-Item -Force "C:\workspace\baseline.txt"'`
    const switchedAnalysis = analyzeShellCommand(switchedPath)
    expect(extractDirectDeletionPaths(switchedPath, switchedAnalysis)).toEqual(['C:\\workspace\\baseline.txt'])
    expect(hasUnresolvedDirectDeletion(switchedPath, switchedAnalysis)).toBeFalse()

    for (const source of [
      String.raw`powershell.exe -Command 'Remove-Item $TARGET -Force'`,
      String.raw`powershell.exe -Command 'Remove-Item $env:TEMP -Force'`,
      String.raw`powershell.exe -Command '$target="D:\local\dirty.txt"; if ($enabled) { $target="C:\safe.log" }; Remove-Item $target -Force'`,
      String.raw`powershell.exe -Command 'Remove-Item -FutureOption "C:\maybe-a-value-or-path"'`,
    ]) {
      const analysis = analyzeShellCommand(source)
      expect(hasUnresolvedDirectDeletion(source, analysis), source).toBeTrue()
    }
  })

  test('does not execute PowerShell strings or declaration bodies while retaining live wrapped commands', () => {
    const literal = analyzeShellCommand(String.raw`powershell.exe -Command 'Write-Output "git reset --hard; Remove-Item $TARGET"'`)
    expect(literal.stages.map((stage) => stage.executable.toLowerCase())).toEqual(['powershell.exe', 'write-output'])
    expect(hasUnresolvedDirectDeletion(literal.source, literal)).toBeFalse()

    const declaration = analyzeShellCommand(String.raw`powershell.exe -Command 'function Cleanup { Remove-Item $TARGET }; Write-Output done'`)
    expect(declaration.stages.map((stage) => stage.executable.toLowerCase())).toEqual(['powershell.exe', 'write-output'])
    expect(hasUnresolvedDirectDeletion(declaration.source, declaration)).toBeFalse()

    const liveGit = analyzeShellCommand(String.raw`powershell.exe -Command 'git reset --hard HEAD'`)
    expect(liveGit.stages.map((stage) => stage.executable.toLowerCase())).toEqual(['powershell.exe', 'git'])

    const invokedGit = analyzeShellCommand(String.raw`powershell.exe -Command '& "git" reset --hard HEAD'`)
    expect(invokedGit.stages.map((stage) => stage.executable.toLowerCase())).toEqual(['powershell.exe', 'git'])

    const deferredBlock = analyzeShellCommand(String.raw`powershell.exe -Command '$cleanup = { Remove-Item $TARGET }; Write-Output ready'`)
    expect(deferredBlock.stages.some((stage) => stage.executable.toLowerCase() === 'remove-item')).toBeFalse()

    const invokedBlock = analyzeShellCommand(String.raw`powershell.exe -Command '& { Remove-Item $TARGET }'`)
    expect(invokedBlock.stages.some((stage) => stage.executable.toLowerCase() === 'remove-item')).toBeTrue()
    expect(hasUnresolvedDirectDeletion(invokedBlock.source, invokedBlock)).toBeTrue()
  })

  test('keeps explicit CMD wrapper stages in the CMD dialect instead of applying Git Bash redirection rules', () => {
    const analysis = analyzeShellCommand('cmd.exe /c "dir C:\\\\missing >nul 2>nul"')
    expect(analysis.stages.slice(1).map((stage) => stage.dialect)).toEqual(['cmd'])
  })

  test('returns an honest opaque or invalid reason instead of guessing a concrete risk category', () => {
    const dynamicExecutable = analyzeShellCommand('$RUNNER --force')
    expect(dynamicExecutable.status).toBe('opaque')
    expect(dynamicExecutable.reasonCodes).toContain('dynamic-or-missing-executable')

    const invalid = analyzeShellCommand("echo 'unterminated")
    expect(invalid.status).toBe('invalid')
    expect(invalid.reasonCodes).toEqual(['parse-error'])
  })
})
