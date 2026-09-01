import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createExecutionPolicy, resolvePolicyDecision } from './execution-policy.ts'

const identityCanonicalizer = async (path: string): Promise<string> => path

function createPolicy(overrides: Parameters<typeof createExecutionPolicy>[0] = {}) {
  return createExecutionPolicy({
    executionPolicy: 'controlled',
    workspaceRoot: '/workspace/project',
    interaction: 'interactive',
    canonicalize: identityCanonicalizer,
    requestApproval: async () => 'approved',
    ...overrides,
  })
}

function routineResolutionFacts() {
  return {
    executionPolicy: 'controlled' as const,
    unresolvedShellDeletion: false,
    hasLocalBaseline: false,
    localBaselineStatus: 'captured' as const,
    deletionMayTouchLocalBaselineRoot: false,
    destructiveGit: false,
    externalImpact: false,
    processNetwork: false,
    codeExecution: false,
    opaqueAction: false,
    shellAction: false,
    shellIsRoutine: false,
    aborted: false,
    interaction: 'interactive' as const,
  }
}

describe('resolvePolicyDecision', () => {
  test('returns one closed decision union for allow, approval, and non-interactive deny', () => {
    expect(resolvePolicyDecision(routineResolutionFacts())).toEqual({
      kind: 'allow', reason: '常规操作', decisionCode: 'routine',
    })
    expect(resolvePolicyDecision({ ...routineResolutionFacts(), destructiveGit: true })).toMatchObject({
      kind: 'require-approval', category: 'destructive-git', decisionCode: 'session-target-destructive-git',
    })
    expect(resolvePolicyDecision({
      ...routineResolutionFacts(), destructiveGit: true, interaction: 'unattended',
    })).toMatchObject({
      kind: 'deny', category: 'unattended', decisionCode: 'unattended-session-target-destructive-git',
    })
    expect(resolvePolicyDecision({
      ...routineResolutionFacts(), executionPolicy: 'full-access', destructiveGit: true,
    })).toEqual({
      kind: 'allow',
      reason: 'Full Access 已由用户明确选择，普通工具风险由用户承担',
      decisionCode: 'full-access-bypass',
    })
  })
})

describe('ExecutionPolicy.authorize', () => {
  test('Given Controlled execution When ordinary project files are read or edited Then both calls are allowed', async () => {
    const policy = createPolicy()

    const readDecision = await policy.authorize({
      toolName: 'Read',
      input: { file_path: '/workspace/project/src/index.ts' },
    })
    const editDecision = await policy.authorize({
      toolName: 'Edit',
      input: { file_path: '/workspace/project/src/index.ts' },
    })

    expect(readDecision.outcome).toBe('allow')
    expect(editDecision.outcome).toBe('allow')
  })

  test('Given Controlled execution When MultiEdit writes one project file Then it remains a routine file action', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'MultiEdit',
      input: { file_path: '/workspace/project/src/index.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
    })

    expect(decision).toMatchObject({ outcome: 'allow', category: 'routine' })
    expect(approvalCount).toBe(0)
  })

  test('Given Controlled execution When exact known validation commands run Then typecheck, test, build, and lint need no approval', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decisions = await Promise.all([
      policy.authorize({ toolName: 'Bash', input: { command: 'bun run typecheck' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'bun test' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'npm run build' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'pnpm lint' } }),
    ])

    expect(decisions.map((decision) => decision.outcome)).toEqual(['allow', 'allow', 'allow', 'allow'])
    expect(approvalCount).toBe(0)
  })

  test('Given a known validation command with an explicit boundary escape When authorized Then it becomes opaque and needs approval', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    for (const command of [
      'bun test ../outside/test.ts',
      'bun test /workspace/outside/test.ts',
      'bun test C:\\outside\\test.ts',
    ]) {
      await policy.authorize({ toolName: 'Bash', input: { command } })
    }

    expect(approvals).toEqual(['opaque-command', 'opaque-command', 'opaque-command'])
  })

  test('Given Controlled execution When a known validation command is combined with another command Then it remains opaque and needs approval', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'bun test && echo done' },
    })

    expect(approvals).toEqual(['opaque-command'])
  })

  test('Given Controlled execution When an opaque shell command is requested Then it needs one-time approval', async () => {
    const approvalCategories: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvalCategories.push(request.category)
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Bash',
      input: { command: 'python scripts/custom-task.py' },
    })

    expect(approvalCategories).toEqual(['opaque-command'])
    expect(decision).toMatchObject({ outcome: 'allow', approval: 'single' })
  })

  test('Given Autonomous execution When normal edit, typecheck, and test calls stay in the project Then they run without approval', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      executionPolicy: 'autonomous',
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const edit = await policy.authorize({
      toolName: 'Edit',
      input: { file_path: '/workspace/project/src/app.ts' },
    })
    const typecheck = await policy.authorize({ toolName: 'Bash', input: { command: 'bun run typecheck' } })
    const testRun = await policy.authorize({ toolName: 'Bash', input: { command: 'bun test' } })

    expect([edit.outcome, typecheck.outcome, testRun.outcome]).toEqual(['allow', 'allow', 'allow'])
    expect(approvalCount).toBe(0)
  })

  test('Given a Workspace Boundary When a file target crosses it Then one-time approval is required', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'autonomous',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Write',
      input: { file_path: '/workspace/other/secrets.txt' },
    })

    expect(approvals).toEqual(['workspace-boundary'])
    expect(decision).toMatchObject({ outcome: 'allow', approval: 'single' })
  })

  test('Given a read-only Workflow exemption When paths cross the boundary Then only proven reads bypass it', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    const read = await policy.authorize({
      toolName: 'Read',
      input: { file_path: '/outside/image.png' },
      skipWorkspaceBoundary: true,
    })
    const write = await policy.authorize({
      toolName: 'Write',
      input: { file_path: '/outside/changed.txt' },
      skipWorkspaceBoundary: true,
    })

    expect(read).toMatchObject({ outcome: 'allow', category: 'routine' })
    expect(write).toMatchObject({ outcome: 'allow', category: 'workspace-boundary', approval: 'single' })
    expect(approvals).toEqual(['workspace-boundary'])
  })

  test('Given a Windows Workspace Boundary When path case and separators differ Then the target remains inside', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      workspaceRoot: 'C:\\Work\\Repo',
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Edit',
      input: { file_path: 'c:/work/repo/src/app.ts' },
    })

    expect(decision.outcome).toBe('allow')
    expect(approvalCount).toBe(0)
  })

  test('Given a project symlink or junction When its canonical target is outside Then the boundary crossing needs approval', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      canonicalize: async (path) => path.endsWith('/linked/file.txt')
        ? '/outside/private/file.txt'
        : path,
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Write',
      input: { file_path: '/workspace/project/linked/file.txt' },
    })

    expect(approvals).toEqual(['workspace-boundary'])
  })

  test('Given a Local Baseline file When Autonomous execution deletes it Then the deletion only proceeds after one-time approval', async () => {
    const approvals: Array<{ category: string; scope: string }> = []
    const policy = createPolicy({
      executionPolicy: 'autonomous',
      localBaselinePaths: ['/workspace/project/notes.txt'],
      requestApproval: async (request) => {
        approvals.push({ category: request.category, scope: request.scope })
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Delete',
      input: { file_path: '/workspace/project/notes.txt' },
    })

    expect(approvals).toEqual([{ category: 'local-baseline', scope: 'single' }])
    expect(decision).toMatchObject({ outcome: 'allow', approval: 'single' })
  })

  test('Given Full Access owner Isolated host tools When destructive Git stays inside its managed Worktree Then it runs without approval', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decisions = await Promise.all([
      policy.authorize({ toolName: 'Bash', input: { command: 'git reset --hard HEAD~1' }, toolSource: 'host' }),
      policy.authorize({ toolName: 'Bash', input: { command: 'git clean -fd' }, toolSource: 'host' }),
      policy.authorize({ toolName: 'Bash', input: { command: 'git checkout -- src/app.ts' }, toolSource: 'host' }),
    ])

    expect(decisions.map(({ outcome, category }) => ({ outcome, category }))).toEqual([
      { outcome: 'allow', category: 'routine' },
      { outcome: 'allow', category: 'routine' },
      { outcome: 'allow', category: 'routine' },
    ])
    expect(approvalCount).toBe(0)
  })

  test('Given Full Access When destructive Git is wrapped or redirects repository context Then generic Policy does not prompt', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'GIT_WORK_TREE=D:/local git clean -fd' },
      toolSource: 'host',
    })
    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'bash -lc "git reset --hard HEAD"' },
      toolSource: 'host',
    })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When an externally owned tool runs destructive Git Then generic Policy trust does not prompt', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'Bash', input: { command: 'git clean -fd' }, toolSource: 'mcp' })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When destructive Git runs without target provenance Then generic Policy still bypasses permissions', async () => {
    const approvals: Array<{ category: string; scope: string }> = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push({ category: request.category, scope: request.scope })
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'Bash', input: { command: 'git reset --hard HEAD~1 && git status' } })
    await policy.authorize({ toolName: 'Bash', input: { command: 'git clean -fd' } })
    await policy.authorize({ toolName: 'Bash', input: { command: 'git checkout -- src/app.ts' } })

    expect(approvals).toEqual([])
  })

  test('Given an ordinary Bash git push When Full Access authorizes it Then explicit Full Access trust skips generic external-impact approval', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Bash',
      input: { command: 'git push origin HEAD:main' },
      toolSource: 'host',
    })

    expect(decision).toMatchObject({ outcome: 'allow', category: 'routine' })
    expect(approvals).toEqual([])
  })

  test('Given Full Access When push, release, or deployment commands run Then explicit trust allows them without ordinary approval', async () => {
    const approvals: Array<{ category: string; scope: string }> = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push({ category: request.category, scope: request.scope })
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'Bash', input: { command: 'git push origin feature' } })
    await policy.authorize({ toolName: 'Bash', input: { command: 'npm publish' } })
    await policy.authorize({ toolName: 'Bash', input: { command: 'vercel deploy --prod' } })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When ordinary opaque shell and cross-boundary file calls are made Then they are allowed without approval', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const shellDecision = await policy.authorize({
      toolName: 'Bash',
      input: { command: 'python scripts/custom-task.py' },
    })
    const fileDecision = await policy.authorize({
      toolName: 'Write',
      input: { file_path: '/workspace/other/result.txt' },
    })

    expect([shellDecision.outcome, fileDecision.outcome]).toEqual(['allow', 'allow'])
    expect(approvalCount).toBe(0)
  })

  test('Given Full Access When generic risk heuristics fire Then bypassPermissions trust allows them without Policy approval', async () => {
    const approvals: string[] = []
    const auditCodes: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselineRoot: '/workspace/project',
      localBaselinePaths: ['/workspace/project/notes.txt'],
      localBaselineStatus: 'unknown',
      requestApproval: async (request) => {
        approvals.push(request.decisionCode ?? request.category)
        return 'approved'
      },
      audit: (event) => {
        auditCodes.push(event.decisionCode)
      },
    })

    const decisions = await Promise.all([
      policy.authorize({
        toolName: 'Edit',
        input: { file_path: 'C:/Users/A/.domi/agent-workspaces/domi/.claude/memory/product-preferences.md' },
      }),
      policy.authorize({ toolName: 'Write', input: { file_path: '/workspace/project/.git/config' } }),
      policy.authorize({ toolName: 'Delete', input: { file_path: '/workspace/project/notes.txt' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'rm "$TARGET"' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'bash -lc "git reset --hard HEAD"' } }),
      policy.authorize({ toolName: 'Bash', input: { command: String.raw`powershell.exe -Command '& $runtimeCommand ./ordinary.txt'` } }),
    ])

    expect(decisions.every((decision) => decision.outcome === 'allow' && decision.category === 'routine')).toBe(true)
    expect(approvals).toEqual([])
    expect(auditCodes).toEqual(Array(decisions.length).fill('full-access-bypass'))
  })

  test('Given Full Access When generic path evidence cannot be canonicalized Then analysis failure does not block bypassPermissions', async () => {
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselineStatus: 'unknown',
      canonicalize: async () => {
        throw new Error('canonicalization unavailable')
      },
    })

    await expect(policy.authorize({
      toolName: 'Delete',
      input: { file_path: '/runtime/target' },
    })).resolves.toMatchObject({ outcome: 'allow', category: 'routine' })
  })

  test('Given an unattended call When policy would ask for approval Then it fails closed with a visible denial', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      interaction: 'unattended',
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Bash',
      input: { command: 'python scripts/custom-task.py' },
    })

    expect(decision).toMatchObject({ outcome: 'deny', category: 'unattended' })
    expect(decision.reason).toContain('无人值守')
    expect(approvalCount).toBe(0)
  })

  test('Given Autonomous execution When a process may access the network Then package installation requires approval', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'autonomous',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'bun install' },
    })

    expect(approvals).toEqual(['process-network'])
  })

  test('Given Full Access and a Local Baseline file When a direct shell deletion targets it Then generic baseline heuristics do not prompt', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselinePaths: ['/workspace/project/notes.txt'],
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'rm notes.txt && echo removed' },
    })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When PowerShell only replaces managed workbench logs Then dynamic Local Baseline approval is not requested', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselinePaths: ['D:/workspace/project/notes.txt'],
      trustedVariableDeletionRoots: ['C:/Users/A/.domi/agent-workspaces/wisdom-product-app/session/.context'],
      requestApproval: async (request) => {
        approvals.push(request.decisionCode ?? request.category)
        return 'approved'
      },
    })
    const command = String.raw`powershell.exe -NoProfile -Command '$logDir="C:\Users\A\.domi\agent-workspaces\wisdom-product-app\session\.context";New-Item -ItemType Directory -Force -Path $logDir|Out-Null;$stdout=Join-Path $logDir "backend-main-workspace.out.log";$stderr=Join-Path $logDir "backend-main-workspace.err.log";Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue;$node=(Get-Command node.exe).Source;$child=Start-Process -FilePath $node -ArgumentList "--require","ts-node/register","src/main.ts" -WorkingDirectory "D:\workspace\wisdom-product-app\service" -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru;Write-Output BACKEND_DIRECT_MAIN:\${child.Id}'`

    const decision = await policy.authorize({ toolName: 'Bash', input: { command } })

    expect(approvals).toEqual([])
    expect(decision).toMatchObject({ outcome: 'allow' })
  })

  test('Given Full Access When a resolved PowerShell variable leaves the managed workbench Then generic deletion heuristics still do not prompt', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselinePaths: ['D:/workspace/project/notes.txt'],
      trustedVariableDeletionRoots: ['C:/Users/A/.domi/agent-workspaces/app/session/.context'],
      requestApproval: async (request) => {
        approvals.push(request.decisionCode ?? request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: String.raw`powershell.exe -NoProfile -Command '$target="C:\outside\other.log";Remove-Item $target -Force'` },
    })
    await policy.authorize({
      toolName: 'Bash',
      input: { command: String.raw`powershell.exe -NoProfile -Command '$target="D:\workspace\project\notes.txt";Remove-Item $target -Force'` },
    })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When a PowerShell deletion target remains runtime-dependent Then bypassPermissions does not require static proof', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselinePaths: ['D:/workspace/project/notes.txt'],
      requestApproval: async (request) => {
        approvals.push(request.decisionCode ?? request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: String.raw`powershell.exe -NoProfile -Command 'Remove-Item $TARGET -Force'` },
    })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When PowerShell hides deletion behind nested execution Then generic Policy remains bypassed', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselineRoot: 'D:/local',
      localBaselinePaths: ['D:/local/dirty.txt'],
      requestApproval: async (request) => {
        approvals.push(request.decisionCode ?? request.category)
        return 'approved'
      },
    })

    for (const command of [
      String.raw`powershell.exe -Command 'Write-Output $(Remove-Item D:/local/dirty.txt -Force)'`,
      String.raw`powershell.exe -Command 'function Cleanup { Remove-Item D:/local/dirty.txt -Force }; Cleanup'`,
      String.raw`powershell.exe -Command '"D:/local/dirty.txt" | Remove-Item -Force'`,
      String.raw`powershell.exe -Command '$cmd="git"; & $cmd reset --hard HEAD'`,
    ]) {
      await policy.authorize({ toolName: 'Bash', input: { command } })
    }

    expect(approvals).toEqual([])
  })

  test('Given Full Access When PowerShell mutates a tracked variable or uses named Join-Path options Then Policy does not demand trusted-root proof', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      localBaselineRoot: 'D:/local',
      localBaselinePaths: ['D:/local/dirty.txt'],
      trustedVariableDeletionRoots: ['D:/agent/session/.context'],
      requestApproval: async (request) => {
        approvals.push(request.decisionCode ?? request.category)
        return 'approved'
      },
    })

    for (const command of [
      String.raw`powershell.exe -Command '$target="D:/agent/session/.context/safe.log"; Set-Variable -Name target -Value "D:/local/dirty.txt"; Remove-Item $target -Force'`,
      String.raw`powershell.exe -Command '$root="D:/agent/session/.context"; $target=Join-Path $root -ChildPath "../../../local/dirty.txt"; Remove-Item $target -Force'`,
    ]) {
      await policy.authorize({ toolName: 'Bash', input: { command } })
    }

    expect(approvals).toEqual([])
  })

  test('Given Full Access and an externally owned Bash-like tool When it pushes Then Full Access still skips ordinary external-impact approval', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'git push origin main' },
      toolSource: 'resource',
    })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When common Git global options expose push or destructive Git Then generic Policy does not prompt', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'Bash', input: { command: 'git -C . push origin main' } })
    await policy.authorize({ toolName: 'Bash', input: { command: 'git restore .' } })
    await policy.authorize({ toolName: 'Bash', input: { command: 'git --work-tree=. reset --hard HEAD' } })

    expect(approvals).toEqual([])
  })

  test('Given Controlled execution When product WebFetch uses Managed Web Then it is a routine host-owned call', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'WebFetch',
      input: { url: 'https://example.com' },
      toolSource: 'product',
    })

    expect(decision).toMatchObject({ outcome: 'allow', category: 'routine' })
    expect(approvalCount).toBe(0)
  })

  test.each(['resource', 'mcp'] as const)('Given Controlled execution When %s exposes a WebFetch namesake Then provenance still requires approval', async (toolSource) => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'WebFetch',
      input: { url: 'https://example.com' },
      toolSource,
    })

    expect(approvals).toEqual(['opaque-command'])
  })

  test('Given unattended Controlled execution When an extension exposes a WebSearch namesake Then it is denied closed', async () => {
    const policy = createPolicy({ interaction: 'unattended' })

    const decision = await policy.authorize({
      toolName: 'WebSearch',
      input: { query: 'security' },
      toolSource: 'resource',
    })

    expect(decision).toMatchObject({ outcome: 'deny', category: 'unattended' })
  })

  test('Given Controlled execution When an ordinary product tool runs Then it remains opaque', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'CreateTodo', input: {}, toolSource: 'product' })

    expect(approvals).toEqual(['opaque-command'])
  })

  test('Given a Trusted Extension reports a readonly-looking tool name When Controlled authorizes it Then provenance prevents readonly bypass', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Read',
      input: { file_path: '/workspace/project/file.ts' },
      toolSource: 'resource',
    })

    expect(approvals).toEqual(['opaque-command'])
  })

  test('Given Controlled execution When a tool action is not recognized Then it is not assumed safe', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'custom_system_action',
      input: {},
    })

    expect(approvals).toEqual(['opaque-command'])
  })

  test('Given an authorization decision When the audit sink fails Then the decision survives without exposing tool input', async () => {
    let recordedEvent: unknown
    const policy = createPolicy({
      sessionId: 'session-policy',
      workspaceId: 'workspace-policy',
      audit: async (event) => {
        recordedEvent = event
        throw new Error('audit storage unavailable')
      },
    })

    const decision = await policy.authorize({
      toolName: 'Bash',
      input: { command: 'python custom.py --token super-secret' },
    })

    expect(decision).toMatchObject({ outcome: 'allow', approval: 'single' })
    expect(recordedEvent).toMatchObject({
      sessionId: 'session-policy',
      workspaceId: 'workspace-policy',
      executionPolicy: 'controlled',
      decisionCode: 'code-execution',
      shellAnalysisStatus: 'static',
      shellStageCount: 1,
    })
    expect(JSON.stringify(recordedEvent)).not.toContain('super-secret')
  })

  test('Given a running session When execution policy changes to Full Access Then the existing policy object observes the new mode', async () => {
    let mode: 'controlled' | 'full-access' = 'controlled'
    let approvalCount = 0
    const policy = createPolicy({
      executionPolicy: () => mode,
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'Bash', input: { command: 'python custom.py' } })
    mode = 'full-access'
    await policy.authorize({ toolName: 'Bash', input: { command: 'python custom.py' } })

    expect(approvalCount).toBe(1)
  })

  test('Given Local Baseline capture failed When a direct deletion is requested Then policy asks instead of assuming a clean checkout', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      localBaselineStatus: 'unknown',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'Delete', input: { file_path: '/workspace/project/unknown.txt' } })

    expect(approvals).toEqual(['local-baseline'])
  })

  test('Given an already aborted tool call When approval would be required Then it denies without opening approval UI', async () => {
    const controller = new AbortController()
    controller.abort()
    let approvalCount = 0
    const policy = createPolicy({
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Bash',
      input: { command: 'python custom.py' },
      signal: controller.signal,
    })

    expect(decision).toMatchObject({ outcome: 'deny' })
    expect(approvalCount).toBe(0)
  })

  test('Given approval is required When the policy adapter is called Then actual input and AbortSignal remain available to the UI adapter', async () => {
    const signal = new AbortController().signal
    let receivedContext: unknown
    const policy = createPolicy({
      requestApproval: async (_request, context) => {
        receivedContext = context
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'python custom.py' },
      signal,
      toolCallId: 'tool-1',
    })

    expect(receivedContext).toMatchObject({
      call: { toolName: 'Bash', input: { command: 'python custom.py' }, toolCallId: 'tool-1' },
      signal,
    })
  })

  test('Given a policy dependency failure When authorization cannot be evaluated Then the policy error is not swallowed', async () => {
    const policy = createPolicy({
      canonicalize: async () => {
        throw new Error('canonicalization failed')
      },
    })

    await expect(policy.authorize({
      toolName: 'Read',
      input: { file_path: '/workspace/project/file.ts' },
    })).rejects.toThrow('canonicalization failed')
  })

  test('Given Controlled execution When writing a sensitive file Then it requires a sensitive-file approval', async () => {
    const approvalCategories: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvalCategories.push(request.category)
        return 'approved'
      },
    })

    const decisions = await Promise.all([
      policy.authorize({ toolName: 'Write', input: { file_path: '/workspace/project/.env' } }),
      policy.authorize({ toolName: 'Write', input: { file_path: '/workspace/project/sub/.npmrc' } }),
      policy.authorize({ toolName: 'Edit', input: { file_path: '/workspace/project/.gitconfig' } }),
      policy.authorize({ toolName: 'Write', input: { file_path: join(homedir(), '.ssh', 'id_rsa') } }),
    ])

    expect(decisions.map((decision) => decision.category)).toEqual([
      'sensitive-file',
      'sensitive-file',
      'sensitive-file',
      'sensitive-file',
    ])
    expect(approvalCategories).toEqual(['sensitive-file', 'sensitive-file', 'sensitive-file', 'sensitive-file'])
  })

  test('Given Controlled execution When reading a sensitive file Then it stays a routine read', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Read',
      input: { file_path: '/workspace/project/.env' },
    })

    expect(decision).toMatchObject({ outcome: 'allow', category: 'routine' })
    expect(approvalCount).toBe(0)
  })

  test('Given Full Access execution When writing an ordinary project secret Then it does not need approval', async () => {
    let approvalCount = 0
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async () => {
        approvalCount += 1
        return 'approved'
      },
    })

    const decision = await policy.authorize({
      toolName: 'Write',
      input: { file_path: '/workspace/project/.env' },
    })

    expect(decision).toMatchObject({ outcome: 'allow', category: 'routine' })
    expect(approvalCount).toBe(0)
  })

  test('Given Full Access execution When writing path-name classified control files Then bypassPermissions does not prompt', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({ toolName: 'Write', input: { file_path: '/workspace/project/.git/config' } })
    await policy.authorize({ toolName: 'Write', input: { file_path: join(homedir(), '.ssh', 'config') } })
    await policy.authorize({ toolName: 'Edit', input: { file_path: join(homedir(), '.bashrc') } })
    await policy.authorize({ toolName: 'Bash', input: { command: 'printf x > /workspace/project/.git/config' } })
    await policy.authorize({ toolName: 'Bash', input: { command: `rm "${join(homedir(), '.bashrc')}"` } })

    expect(approvals).toEqual([])
  })

  test('Given Full Access When PowerShell writes path-name classified control files Then parser facts stay audit-only', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      executionPolicy: 'full-access',
      requestApproval: async (request) => {
        approvals.push(request.decisionCode ?? request.category)
        return 'approved'
      },
    })

    for (const command of [
      String.raw`powershell.exe -Command 'Set-Content -LiteralPath "D:\workspace\project\.git\config" -Value pwned'`,
      String.raw`powershell.exe -Command '"pwned" | Out-File -LiteralPath "D:\workspace\project\.claude\memory\MEMORY.md"'`,
      String.raw`powershell.exe -Command 'Move-Item "D:\workspace\project\file" "D:\workspace\project\.git\config"'`,
      String.raw`powershell.exe -Command 'Move-Item -Destination "D:\workspace\project\.git\config" -Path "D:\source.txt"'`,
      String.raw`powershell.exe -Command 'Copy-Item -Destination "D:\workspace\project\.claude\MEMORY.md" -LiteralPath "D:\source.txt"'`,
      String.raw`powershell.exe -Command '"pwned" > "D:\workspace\project\.git\config"'`,
      String.raw`powershell.exe -Command 'Start-Process node -RedirectStandardOutput "D:\workspace\project\.git\config"'`,
    ]) {
      await policy.authorize({ toolName: 'Bash', input: { command } })
    }

    expect(approvals).toEqual([])
  })

  test('Given Controlled execution When running an interpreter or package runner Then it requires approval with a precise reason', async () => {
    const reasons: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        reasons.push(request.reason)
        return 'approved'
      },
    })

    const decisions = await Promise.all([
      policy.authorize({ toolName: 'Bash', input: { command: 'python custom.py' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'node scripts/deploy.js' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'npx some-package' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'bun run dev' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'bash -c "rm -rf /tmp/x"' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'env FOO=1 python custom.py' } }),
      policy.authorize({ toolName: 'Bash', input: { command: 'command python -m http.server' } }),
    ])

    expect(decisions.map((decision) => decision.category)).toEqual([
      'opaque-command',
      'opaque-command',
      'opaque-command',
      'opaque-command',
      'opaque-command',
      'opaque-command',
      'opaque-command',
    ])
    expect(reasons.every((reason) => reason.includes('任意代码'))).toBe(true)
  })

  test('Given Controlled execution When a known validation command is run through an interpreter wrapper Then it still needs approval', async () => {
    const approvals: string[] = []
    const policy = createPolicy({
      requestApproval: async (request) => {
        approvals.push(request.category)
        return 'approved'
      },
    })

    await policy.authorize({
      toolName: 'Bash',
      input: { command: 'bash -c "bun run typecheck"' },
    })

    expect(approvals).toEqual(['opaque-command'])
  })
})
