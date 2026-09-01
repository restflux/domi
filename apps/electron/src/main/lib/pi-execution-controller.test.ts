import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY } from '@domi/shared'
import type { AgentWorkflow, ExecutionPolicyMode } from '@domi/shared'
import type { PermissionResult } from './agent-permission-service.ts'
import { createPiExecutionController } from './pi-execution-controller.ts'

async function createHarness(options: {
  askUser?: (input: Record<string, unknown>) => Promise<PermissionResult>
  approval?: 'approved' | 'denied'
  workflowChangeAccepted?: boolean
  runActive?: boolean
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pi-execution-controller-'))
  const planSidecarDir = join(workspaceRoot, '.domi', 'plans')
  await mkdir(planSidecarDir, { recursive: true })
  let executionPolicy: ExecutionPolicyMode = 'autonomous'
  let workflow: AgentWorkflow = 'plan-first'
  const workflowChanges: Array<{ workflow: AgentWorkflow; source: string }> = []
  const approvals: string[] = []
  const approvalInputs: Record<string, unknown>[] = []
  const asks: Record<string, unknown>[] = []

  const authorize = await createPiExecutionController({
    sessionId: 'session-controller',
    workspaceRoot,
    localBaselineRoot: workspaceRoot,
    planSidecarDir,
    interaction: 'interactive',
    getExecutionPolicy: () => executionPolicy,
    getWorkflow: () => workflow,
    isRunActive: () => options.runActive !== false,
    requestApproval: async (request, context) => {
      approvals.push(request.toolName)
      approvalInputs.push(context.call.input)
      return options.approval ?? 'approved'
    },
    audit: () => undefined,
    askUser: async (input) => {
      asks.push(input)
      return options.askUser?.(input)
        ?? { behavior: 'allow', updatedInput: { answers: { choice: 'A' } } }
    },
    exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
    onWorkflowChanged: (nextWorkflow, source) => {
      if (options.workflowChangeAccepted === false) return false
      workflow = nextWorkflow
      workflowChanges.push({ workflow: nextWorkflow, source })
      return true
    },
  })

  return {
    authorize,
    workspaceRoot,
    planSidecarDir,
    approvals,
    approvalInputs,
    asks,
    workflowChanges,
    get executionPolicy() { return executionPolicy },
    set executionPolicy(value: ExecutionPolicyMode) { executionPolicy = value },
    get workflow() { return workflow },
    set workflow(value: AgentWorkflow) { workflow = value },
    dispose: () => rm(workspaceRoot, { recursive: true, force: true }),
  }
}

function toolOptions(
  toolSource: 'host' | 'product' | 'builtin-mcp' | 'mcp' | 'resource' = 'host',
  toolAnnotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
) {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tool-1',
    toolSource,
    ...(toolAnnotations && { toolAnnotations }),
  }
}

describe('PiExecutionController', () => {
  test('Given a product browser mutation in Direct When authorized repeatedly Then one session-scoped external-impact approval is reused', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'direct'
      await expect(harness.authorize({
        type: 'tool', toolName: 'BrowserClick', input: { ref: 'e1' }, options: toolOptions('product'),
      })).resolves.toMatchObject({ behavior: 'allow' })
      await expect(harness.authorize({
        type: 'tool', toolName: 'BrowserType', input: { ref: 'e2', text: 'hello' }, options: toolOptions('product'),
      })).resolves.toMatchObject({ behavior: 'allow' })
      expect(harness.approvals).toEqual(['BrowserClick'])
      expect(harness.approvalInputs).toEqual([{ ref: 'e1' }])
    } finally {
      await harness.dispose()
    }
  })

  test('Given BrowserType requires first approval When requesting it Then the approval payload contains only ref and length', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'direct'
      await expect(harness.authorize({
        type: 'tool', toolName: 'BrowserType', input: { ref: 'e2', text: 'private note', replace: true }, options: toolOptions('product'),
      })).resolves.toMatchObject({ behavior: 'allow' })
      expect(harness.approvalInputs).toEqual([{ ref: 'e2', replace: true, textLength: 12 }])
      expect(JSON.stringify(harness.approvalInputs)).not.toContain('private note')
    } finally {
      await harness.dispose()
    }
  })

  test('Given Read Only managed browser interaction When authorizing Then the bounded browser remains available without a policy approval', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'read-only'
      await expect(harness.authorize({
        type: 'tool', toolName: 'BrowserClick', input: { ref: 'e1' }, options: toolOptions('product'),
      })).resolves.toMatchObject({ behavior: 'allow' })
      expect(harness.approvals).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
  test('Given Full Access owner Isolated When host Git cleans its managed Worktree Then no approval is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-owner-isolated-git-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    const outsideRoot = join(root, 'outside')
    await mkdir(localRoot)
    await mkdir(isolatedRoot)
    await mkdir(outsideRoot)
    const approvals: string[] = []
    try {
      const authorize = await createPiExecutionController({
        sessionId: 'owner-session',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        sessionTarget: { kind: 'isolated', ownership: 'owner' },
        planSidecarDir: join(root, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestApproval: async (request) => {
          approvals.push(request.category)
          return 'approved'
        },
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      const input = { command: 'git clean -fd' }
      expect(await authorize({ type: 'tool', toolName: 'Bash', input, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: input })
      const composedInputs = [
        { command: 'git restore --worktree pnpm-lock.yaml && git status --short && git diff --check && git diff --stat' },
        { command: 'bash -lc "git reset --hard HEAD"' },
        { command: '(git clean -fd)' },
        { command: `git -C "${isolatedRoot}" restore .` },
        { command: `cd "${isolatedRoot}" && git reset --hard HEAD` },
        { command: `env -C "${isolatedRoot}" git reset --hard HEAD` },
        { command: `sudo -D "${isolatedRoot}" git reset --hard HEAD` },
      ]
      for (const composedInput of composedInputs) {
        expect(await authorize({ type: 'tool', toolName: 'Bash', input: composedInput, options: toolOptions() }))
          .toEqual({ behavior: 'allow', updatedInput: composedInput })
      }
      for (const command of [
        `env -C "${outsideRoot}" git reset --hard HEAD`,
        `sudo -D "${outsideRoot}" git reset --hard HEAD`,
      ]) {
        const result = await authorize({ type: 'tool', toolName: 'Bash', input: { command }, options: toolOptions() })
        expect(result.behavior).toBe('deny')
      }
      expect(approvals).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given Full Access inherited Isolated When destructive Git is requested Then ownership denies it without an ordinary approval escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-inherited-isolated-git-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    await mkdir(localRoot)
    await mkdir(isolatedRoot)
    const approvals: string[] = []
    try {
      const authorize = await createPiExecutionController({
        sessionId: 'child-session',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        sessionTarget: { kind: 'isolated', ownership: 'inherited' },
        planSidecarDir: join(root, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestApproval: async (request) => {
          approvals.push(request.category)
          return 'approved'
        },
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      for (const command of [
        'git clean -fd',
        'git restore "$TARGET"',
        'git restore . > "$OUT"',
        '(git reset --hard HEAD)',
        'nohup git restore .',
        'sudo git reset --hard HEAD',
        "env NOTE='a b' git restore .",
      ]) {
        const result = await authorize({ type: 'tool', toolName: 'Bash', input: { command }, options: toolOptions() })
        expect(result.behavior).toBe('deny')
        if (result.behavior === 'deny') expect(result.message).toContain('inherited')
      }
      expect(approvals).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given Full Access owner Isolated When a deletion target is dynamic Then the Local host boundary still denies it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-owner-isolated-dynamic-delete-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    await mkdir(localRoot)
    await mkdir(isolatedRoot)
    const approvals: string[] = []
    try {
      const authorize = await createPiExecutionController({
        sessionId: 'owner-session',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        sessionTarget: { kind: 'isolated', ownership: 'owner' },
        planSidecarDir: join(root, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestApproval: async (request) => {
          approvals.push(request.category)
          return 'approved'
        },
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      for (const command of ['rm "$TARGET"', String.raw`powershell.exe -Command 'Remove-Item $TARGET -Force'`]) {
        const result = await authorize({ type: 'tool', toolName: 'Bash', input: { command }, options: toolOptions() })
        expect(result.behavior).toBe('deny')
        if (result.behavior === 'deny') {
          expect(result.message).toContain('Full Access')
          expect(result.message).toContain('Local')
        }
      }
      expect(approvals).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given Full Access Direct When Domi Auto Memory is edited Then path-name heuristics do not request approval', async () => {
    const harness = await createHarness()
    try {
      harness.executionPolicy = 'full-access'
      harness.workflow = 'direct'
      const input = {
        file_path: 'C:/Users/A/.domi/agent-workspaces/domi/.claude/memory/product-preferences.md',
        old_string: 'old',
        new_string: 'new',
      }

      expect(await harness.authorize({
        type: 'tool',
        toolName: 'Edit',
        input,
        options: toolOptions(),
      })).toEqual({ behavior: 'allow', updatedInput: input })
      expect(harness.approvals).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test('Given a legacy matching Git push session trust When the host-owned tool runs Then Full Access Bash push is independently allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-push-session-trust-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    await mkdir(localRoot)
    await mkdir(isolatedRoot)
    const approvals: string[] = []
    let trustChecks = 0
    const audits: Array<{ action: string; approval?: string }> = []
    try {
      const authorize = await createPiExecutionController({
        sessionId: 'push-session',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        sessionTarget: { kind: 'isolated', ownership: 'owner' },
        planSidecarDir: join(root, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        hasGitPushSessionTrust: async () => {
          trustChecks += 1
          return true
        },
        requestApproval: async (request) => {
          approvals.push(request.category)
          return 'approved'
        },
        audit: (event) => { audits.push({ action: event.action, approval: event.approval }) },
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      const productInput = {}
      expect(await authorize({
        type: 'tool',
        toolName: 'GitPushWithSessionTrust',
        input: productInput,
        options: toolOptions('product', { readOnlyHint: false, destructiveHint: true }),
      })).toEqual({ behavior: 'allow', updatedInput: productInput })
      expect(trustChecks).toBe(1)
      expect(approvals).toEqual([])
      expect(audits).toContainEqual({ action: 'session-git-push', approval: 'session' })

      await authorize({ type: 'tool', toolName: 'Bash', input: { command: 'git push origin HEAD:main' }, options: toolOptions() })
      expect(approvals).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given an interactive Full Access owner Isolated session When the product requests Git push trust Then the bounded approval callback runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-request-push-trust-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    await mkdir(localRoot)
    await mkdir(isolatedRoot)
    const requests: Record<string, unknown>[] = []
    try {
      const authorize = await createPiExecutionController({
        sessionId: 'push-trust-request-session',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        sessionTarget: { kind: 'isolated', ownership: 'owner' },
        planSidecarDir: join(root, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestGitPushSessionTrust: async (input) => {
          requests.push(input)
          return { behavior: 'allow', updatedInput: input }
        },
        requestApproval: async () => 'approved',
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      const input = { reason: '用户明确要求完成后推送' }
      expect(await authorize({
        type: 'tool',
        toolName: 'RequestGitPushSessionTrust',
        input,
        options: toolOptions('product', { readOnlyHint: false, destructiveHint: true }),
      })).toEqual({ behavior: 'allow', updatedInput: input })
      expect(requests).toEqual([input])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given Git push trust request is not owner Isolated Full Access Direct interactive Then it is denied without callback', async () => {
    const harness = await createHarness()
    try {
      harness.executionPolicy = 'controlled'
      harness.workflow = 'direct'
      const result = await harness.authorize({
        type: 'tool',
        toolName: 'RequestGitPushSessionTrust',
        input: { reason: 'push' },
        options: toolOptions('product', { readOnlyHint: false, destructiveHint: true }),
      })
      expect(result).toMatchObject({ behavior: 'deny' })
    } finally {
      await harness.dispose()
    }
  })

  test('Given Isolated Full Access When ordinary tools target Local Then reads are automatic but writes are routed through Local maintenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-dual-root-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    await mkdir(localRoot)
    await mkdir(isolatedRoot)
    for (const cwd of [localRoot, isolatedRoot]) {
      const init = Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd })
      if (init.exitCode !== 0) throw new Error(init.stderr.toString())
    }
    const localDirtyFile = join(localRoot, 'local-dirty.txt')
    const isolatedFile = join(isolatedRoot, 'isolated-edit.txt')
    await writeFile(localDirtyFile, '用户未提交内容\n')
    await writeFile(isolatedFile, 'isolated\n')
    let executionPolicy: ExecutionPolicyMode = 'full-access'
    const approvals: string[] = []

    try {
      const authorize = await createPiExecutionController({
        sessionId: 'isolated-session',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        planSidecarDir: join(root, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => executionPolicy,
        getWorkflow: () => 'direct',
        requestApproval: async (request) => {
          approvals.push(request.category)
          return 'approved'
        },
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      const readInput = { file_path: localDirtyFile }
      expect(await authorize({ type: 'tool', toolName: 'Read', input: readInput, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: readInput })
      const writeInput = { file_path: localDirtyFile, content: 'overwrite' }
      for (const source of ['host', 'mcp', 'resource'] as const) {
        expect(await authorize({ type: 'tool', toolName: 'Write', input: writeInput, options: toolOptions(source) }))
          .toMatchObject({ behavior: 'deny' })
      }
      const deleteInput = { command: `rm "${localDirtyFile}"` }
      for (const source of ['host', 'mcp', 'resource'] as const) {
        expect(await authorize({ type: 'tool', toolName: 'Bash', input: deleteInput, options: toolOptions(source) }))
          .toMatchObject({ behavior: 'deny' })
      }
      expect(await authorize({
        type: 'tool',
        toolName: 'custom_system_action',
        input: { path: localDirtyFile },
        options: toolOptions('mcp'),
      })).toMatchObject({ behavior: 'deny' })
      expect(await authorize({ type: 'tool', toolName: 'Bash', input: { command: 'rm "$TARGET"' }, options: toolOptions() }))
        .toMatchObject({ behavior: 'deny' })
      expect(await authorize({
        type: 'tool',
        toolName: 'Bash',
        input: { command: `TARGET="${localDirtyFile}" rm "$TARGET"` },
        options: toolOptions(),
      })).toMatchObject({ behavior: 'deny' })
      expect(await authorize({
        type: 'tool',
        toolName: 'Bash',
        input: { command: `powershell.exe -Command '$target="${localDirtyFile}"; Remove-Item $target -Force'` },
        options: toolOptions(),
      })).toMatchObject({ behavior: 'deny' })
      expect(await authorize({ type: 'tool', toolName: 'Bash', input: { command: `(rm "${localDirtyFile}")` }, options: toolOptions() }))
        .toMatchObject({ behavior: 'deny' })
      expect(await authorize({ type: 'tool', toolName: 'Bash', input: { command: 'cd ../local && git status' }, options: toolOptions() }))
        .toMatchObject({ behavior: 'deny' })
      expect(approvals).toEqual([])

      executionPolicy = 'controlled'
      const editInput = { file_path: isolatedFile, old_string: 'isolated', new_string: 'isolated edit' }
      expect(await authorize({ type: 'tool', toolName: 'Edit', input: editInput, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: editInput })
      expect(approvals).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given Isolated Full Access When Bash targets the isolated checkout by absolute path in any spelling Then it is allowed, while Local paths in any spelling stay denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-path-spelling-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    await mkdir(localRoot)
    await mkdir(isolatedRoot)
    for (const cwd of [localRoot, isolatedRoot]) {
      const init = Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd })
      if (init.exitCode !== 0) throw new Error(init.stderr.toString())
    }
    const localFile = join(localRoot, 'target.txt')
    const isolatedFile = join(isolatedRoot, 'target.txt')
    await writeFile(localFile, 'local')
    await writeFile(isolatedFile, 'isolated')

    try {
      const authorize = await createPiExecutionController({
        sessionId: 'path-spelling-session',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        planSidecarDir: join(root, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestApproval: async () => 'approved',
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      const isolatedSlash = isolatedFile.replace(/\\/g, '/')
      const isolatedBackslash = isolatedFile
      const localSlash = localFile.replace(/\\/g, '/')
      const localBackslash = localFile

      // worktree 绝对路径（G:/、G:\ 两种拼写）→ 允许
      for (const command of [
        `bun test "${isolatedSlash}"`,
        `bun test "${isolatedBackslash}"`,
      ]) {
        const input = { command }
        expect(await authorize({ type: 'tool', toolName: 'Bash', input, options: toolOptions() }))
          .toEqual({ behavior: 'allow', updatedInput: input })
      }
      // worktree 绝对路径（MSYS /x/ 拼写）→ 允许
      if (process.platform === 'win32') {
        const pathParts = isolatedSlash.match(/^([A-Za-z]):\/(.*)$/)
        if (!pathParts) throw new Error('预期 Windows 绝对路径')
        const msysInput = { command: `bun test "/${pathParts[1]!.toLowerCase()}/${pathParts[2]}"` }
        expect(await authorize({ type: 'tool', toolName: 'Bash', input: msysInput, options: toolOptions() }))
          .toEqual({ behavior: 'allow', updatedInput: msysInput })
      }

      // Local 绝对路径（G:/、G:\ 拼写）→ 拦截
      for (const command of [
        `bun test "${localSlash}"`,
        `rm "${localBackslash}"`,
      ]) {
        expect((await authorize({ type: 'tool', toolName: 'Bash', input: { command }, options: toolOptions() })).behavior)
          .toBe('deny')
      }
      // Local 绝对路径（MSYS /x/ 拼写）→ 拦截（修复漏判）
      if (process.platform === 'win32') {
        const pathParts = localSlash.match(/^([A-Za-z]):\/(.*)$/)
        if (!pathParts) throw new Error('预期 Windows 绝对路径')
        const msysInput = { command: `rm "/${pathParts[1]!.toLowerCase()}/${pathParts[2]}"` }
        expect((await authorize({ type: 'tool', toolName: 'Bash', input: msysInput, options: toolOptions() })).behavior)
          .toBe('deny')
      }

      // 相对路径上跳指向 Local → 拦截
      const relativeToLocal = join('..', 'local', 'target.txt')
      const relativeInput = { command: `rm "${relativeToLocal}"` }
      expect((await authorize({ type: 'tool', toolName: 'Bash', input: relativeInput, options: toolOptions() })).behavior)
        .toBe('deny')

      // 只读命令读 Local → 仍允许
      const catLocal = { command: `cat "${localSlash}"` }
      expect(await authorize({ type: 'tool', toolName: 'Bash', input: catLocal, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: catLocal })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each(['controlled', 'autonomous', 'full-access'] as const)(
    'Given Direct %s When owner Agent invokes ApplyWorktree Then host requires exactly one non-whitelistable Local approval',
    async (executionPolicy) => {
      const harness = await createHarness()
      try {
        harness.workflow = 'direct'
        harness.executionPolicy = executionPolicy
        const input = {}

        expect(await harness.authorize({
          type: 'tool',
          toolName: 'ApplyWorktree',
          input,
          options: toolOptions('product', { readOnlyHint: false, destructiveHint: true }),
        })).toEqual({ behavior: 'allow', updatedInput: input })
        expect(harness.approvals).toEqual(['ApplyWorktree'])
      } finally {
        await harness.dispose()
      }
    },
  )

  test('Given FinishWorktree editable confirmation When host approves Then edited Commit Message becomes the only execution input', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'pi-finish-approval-'))
    try {
      const authorize = await createPiExecutionController({
        sessionId: 'session-finish',
        workspaceRoot,
        localBaselineRoot: workspaceRoot,
        planSidecarDir: join(workspaceRoot, 'plans'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestApproval: async () => 'denied',
        requestProductToolApproval: async () => ({ behavior: 'allow', updatedInput: { commitMessage: 'fix: edited' } }),
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      expect(await authorize({
        type: 'tool',
        toolName: 'FinishWorktree',
        input: { commitMessage: 'fix: original' },
        options: toolOptions('product', { readOnlyHint: false, destructiveHint: true }),
      })).toEqual({ behavior: 'allow', updatedInput: { commitMessage: 'fix: edited' } })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('Given Full Access When the user denies ApplyWorktree approval Then Local writeback remains blocked', async () => {
    const harness = await createHarness({ approval: 'denied' })
    try {
      harness.workflow = 'direct'
      harness.executionPolicy = 'full-access'

      expect(await harness.authorize({
        type: 'tool',
        toolName: 'ApplyWorktree',
        input: {},
        options: toolOptions('product', { readOnlyHint: false, destructiveHint: true }),
      })).toEqual({ behavior: 'deny', message: '用户未授权本次 Worktree Apply。' })
      expect(harness.approvals).toEqual(['ApplyWorktree'])
    } finally {
      await harness.dispose()
    }
  })

  test('Given Read Only When Agent invokes ApplyWorktree Then workflow denies before opening a Local approval', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'read-only'
      harness.executionPolicy = 'full-access'

      const result = await harness.authorize({
        type: 'tool',
        toolName: 'ApplyWorktree',
        input: {},
        options: toolOptions('product', { readOnlyHint: false, destructiveHint: true }),
      })

      expect(result.behavior).toBe('deny')
      expect(harness.approvals).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test('Given Full Access When PowerShell rotates logs inside the current session workbench Then the controller does not request Local Baseline approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-powershell-workbench-cleanup-'))
    const localRoot = join(root, 'local')
    const isolatedRoot = join(root, 'isolated')
    const sessionWorkbenchRoot = join(root, 'agent-workspaces', 'project', 'session-1')
    const contextDir = join(sessionWorkbenchRoot, '.context')
    await mkdir(localRoot, { recursive: true })
    await mkdir(isolatedRoot, { recursive: true })
    await mkdir(contextDir, { recursive: true })
    await writeFile(join(localRoot, 'dirty.txt'), 'preserve')
    const approvals: string[] = []

    try {
      const authorize = await createPiExecutionController({
        sessionId: 'session-1',
        workspaceRoot: isolatedRoot,
        localBaselineRoot: localRoot,
        sessionWorkbenchRoot,
        sessionTarget: { kind: 'isolated', ownership: 'owner' },
        planSidecarDir: join(contextDir, 'plan'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestApproval: async (request) => {
          approvals.push(request.decisionCode ?? request.category)
          return 'approved'
        },
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })
      const command = `powershell.exe -NoProfile -Command '$logDir="${contextDir.replaceAll('\\', '/')}";$stdout=Join-Path $logDir "backend.out.log";$stderr=Join-Path $logDir "backend.err.log";Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue'`

      const result = await authorize({ type: 'tool', toolName: 'Bash', input: { command }, options: toolOptions() })

      expect(result.behavior).toBe('allow')
      expect(approvals).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given Full Access When Agent tries to create a Git worktree inside its Domi session workbench Then the host denies it without approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-worktree-guard-'))
    const workspaceRoot = join(root, 'project')
    const sessionWorkbenchRoot = join(root, 'agent-workspaces', 'project', 'session-1')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(sessionWorkbenchRoot, { recursive: true })
    const approvals: string[] = []

    try {
      const authorize = await createPiExecutionController({
        sessionId: 'session-1',
        workspaceRoot,
        localBaselineRoot: workspaceRoot,
        sessionWorkbenchRoot,
        planSidecarDir: join(sessionWorkbenchRoot, '.context', 'plan'),
        interaction: 'interactive',
        getExecutionPolicy: () => 'full-access',
        getWorkflow: () => 'direct',
        requestApproval: async (request) => {
          approvals.push(request.category)
          return 'approved'
        },
        audit: () => undefined,
        askUser: async (input) => ({ behavior: 'allow', updatedInput: input }),
        exitPlan: async (input) => ({ behavior: 'allow', updatedInput: input }),
        onWorkflowChanged: () => true,
      })

      const nestedPath = join(sessionWorkbenchRoot, 'implementation-worktree')
      const blockedInputs = [
        { command: `git worktree add -b feat/example "${nestedPath}"` },
        { command: `git worktree add --orphan "${nestedPath}"` },
        { command: `cd "${sessionWorkbenchRoot}" && git worktree add implementation-worktree` },
        { command: `git -C "${workspaceRoot}" worktree add relative-worktree` },
        { command: `bash -lc 'git worktree add "${nestedPath}"'` },
        { command: `env bash -lc 'git worktree add "${nestedPath}"'` },
        { command: `command git worktree add "${nestedPath}"` },
        { command: `GIT_OPTIONAL_LOCKS=0 git worktree add "${nestedPath}"` },
        { command: `(git worktree add "${nestedPath}")` },
        { command: `sudo git worktree add "${nestedPath}"` },
        { command: `eval 'git worktree add "${nestedPath}"'` },
        { command: `powershell.exe -Command '$cmd="git"; & $cmd worktree add "${nestedPath}"'` },
        { command: `env -C "${sessionWorkbenchRoot}" git worktree add implementation-worktree` },
        { command: `sudo -D "${sessionWorkbenchRoot}" git worktree add implementation-worktree` },
        { command: 'git worktree add "$TARGET"' },
      ]
      if (process.platform === 'win32') {
        const pathParts = nestedPath.replace(/\\/g, '/').match(/^([A-Za-z]):\/(.*)$/)
        if (!pathParts) throw new Error('预期 Windows 绝对路径')
        blockedInputs.push(
          { command: `git worktree add "/${pathParts[1]!.toLowerCase()}/${pathParts[2]}"` },
          { command: `git worktree add "/mnt/${pathParts[1]!.toLowerCase()}/${pathParts[2]}"` },
        )
      }
      for (const blockedInput of blockedInputs) {
        const blocked = await authorize({
          type: 'tool',
          toolName: 'Bash',
          input: blockedInput,
          options: toolOptions(),
        })
        expect(blocked.behavior).toBe('deny')
      }

      const externalPath = join(root, 'user-managed-worktree')
      const allowedInput = { command: `git worktree add "${externalPath}"` }
      expect(await authorize({
        type: 'tool',
        toolName: 'Bash',
        input: allowedInput,
        options: toolOptions(),
      })).toEqual({ behavior: 'allow', updatedInput: allowedInput })

      const relativeExternalInput = { command: 'git worktree add ../user-managed-relative' }
      expect(await authorize({
        type: 'tool',
        toolName: 'Bash',
        input: relativeExternalInput,
        options: toolOptions(),
      })).toEqual({ behavior: 'allow', updatedInput: relativeExternalInput })
      expect(approvals).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Given Pi Plan First When ExitPlan is approved by default Then only the current task receives Direct execution', async () => {
    const harness = await createHarness()
    try {
      const input = { plan: 'implement safely' }
      expect(await harness.authorize({ type: 'tool', toolName: 'ExitPlanMode', input, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: input })

      expect(await harness.authorize({
        type: 'exit-plan',
        input,
        signal: new AbortController().signal,
      })).toEqual({ behavior: 'allow', updatedInput: input })

      expect(harness.workflowChanges).toEqual([{ workflow: 'direct', source: 'approve-plan-once' }])
      expect(harness.workflow).toBe('direct')
      expect(harness.executionPolicy).toBe('autonomous')
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Research When the user approves free-form Markdown feedback Then only the current task switches to execution', async () => {
    const approvalLabel = '仅执行本次'
    const harness = await createHarness({
      askUser: async (input) => {
        const questions = input.questions as Array<{ question: string }>
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            answers: { [questions[0]!.question]: approvalLabel },
          },
        }
      },
    })
    try {
      harness.workflow = 'read-only'
      harness.executionPolicy = 'controlled'
      const input = {
        summary: '修复 SQL 查询',
        details: '已定位到查询构造。\n\n- 保持现有返回结构\n- 调整 SQL 并补聚焦测试\n- 不改数据库结构',
      }

      expect(await harness.authorize({
        type: 'tool', toolName: 'RequestDirectWorkflow', input, options: toolOptions(),
      })).toEqual({ behavior: 'allow', updatedInput: input })
      expect(await harness.authorize({
        type: 'request-direct-workflow', input, signal: new AbortController().signal,
      })).toEqual({ behavior: 'allow', updatedInput: input })

      expect(harness.asks).toHaveLength(1)
      const requestQuestions = harness.asks[0]!.questions as Array<{
        header: string
        question: string
        allowCustom: boolean
        options: Array<{ label: string; description: string }>
      }>
      expect(harness.asks[0]).toMatchObject({
        presentation: {
          kind: 'direct-workflow',
          summary: '修复 SQL 查询',
          details: '已定位到查询构造。\n\n- 保持现有返回结构\n- 调整 SQL 并补聚焦测试\n- 不改数据库结构',
        },
      })
      expect(requestQuestions[0]!.header).toBe('批准执行')
      expect(requestQuestions[0]!.allowCustom).toBe(true)
      expect(requestQuestions[0]!.question).toBe('实施反馈已展示在主会话区。如何继续？')
      expect(requestQuestions[0]!.options[0]!.label).toBe(approvalLabel)
      expect(requestQuestions[0]!.options[0]!.description).toContain('自动回到研究')
      expect(requestQuestions[0]!.options[1]!.label).toBe('切换到执行')
      expect(requestQuestions[0]!.options[2]!.label).toBe('保持研究')
      expect(requestQuestions[0]!.options[2]!.description).toContain('不会实施')
      expect(harness.workflowChanges).toEqual([{ workflow: 'direct', source: 'approve-read-only-once' }])
      expect(harness.workflow as AgentWorkflow).toBe('direct')
      expect(harness.executionPolicy as ExecutionPolicyMode).toBe('controlled')
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Research When the user explicitly switches to Execute Then the transition is session-scoped', async () => {
    const harness = await createHarness({
      askUser: async (input) => {
        const questions = input.questions as Array<{ question: string }>
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            answers: { [questions[0]!.question]: '切换到执行' },
          },
        }
      },
    })
    try {
      harness.workflow = 'read-only'
      expect(await harness.authorize({
        type: 'request-direct-workflow',
        input: { details: '实施当前修改。' },
        signal: new AbortController().signal,
      })).toEqual({ behavior: 'allow', updatedInput: { details: '实施当前修改。' } })
      expect(harness.workflowChanges).toEqual([{ workflow: 'direct', source: 'approve-read-only-persistent' }])
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Research approval arrives after its run ended When applying the workflow change Then execution remains denied', async () => {
    const harness = await createHarness({
      runActive: false,
      askUser: async (input) => {
        const questions = input.questions as Array<{ question: string }>
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            answers: { [questions[0]!.question]: '切换到执行' },
          },
        }
      },
    })
    try {
      harness.workflow = 'read-only'
      expect(await harness.authorize({
        type: 'request-direct-workflow',
        input: { details: 'stale approval' },
        signal: new AbortController().signal,
      })).toEqual({ behavior: 'deny', message: '审批对应的 run 已结束，未授权执行。' })
      expect(harness.workflowChanges).toEqual([])
      expect(harness.workflow).toBe('read-only')
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Read Only When the user declines Direct Workflow Then Read Only and Execution Policy remain unchanged', async () => {
    const harness = await createHarness({
      askUser: async (input) => {
        const questions = input.questions as Array<{ question: string }>
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            answers: { [questions[0]!.question]: '保持研究' },
          },
        }
      },
    })
    try {
      harness.workflow = 'read-only'
      harness.executionPolicy = 'full-access'
      const result = await harness.authorize({
        type: 'request-direct-workflow',
        input: { details: '准备写入文件完成修改。' },
        signal: new AbortController().signal,
      })

      expect(result).toEqual({ behavior: 'deny', message: '用户选择保持研究，未授权执行。' })
      expect(harness.workflowChanges).toEqual([])
      expect(harness.workflow).toBe('read-only')
      expect(harness.executionPolicy).toBe('full-access')
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Read Only When the user requests adjustments Then feedback returns to the Agent without switching Workflow or Execution Policy', async () => {
    const adjustment = '先补充关闭弹窗后的持久化回归测试，再申请实施。'
    const harness = await createHarness({
      askUser: async (input) => ({
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: { [DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY]: adjustment },
        },
      }),
    })
    try {
      harness.workflow = 'read-only'
      harness.executionPolicy = 'controlled'

      const result = await harness.authorize({
        type: 'request-direct-workflow',
        input: { details: '准备直接修改 renderer。' },
        signal: new AbortController().signal,
      })

      expect(result).toEqual({
        behavior: 'deny',
        message: `用户要求先调整实施方向，当前仍保持研究；请按以下意见修订实施反馈并重新调用 RequestDirectWorkflow，不能按原方向实施：${adjustment}`,
      })
      expect(harness.workflowChanges).toEqual([])
      expect(harness.workflow).toBe('read-only')
      expect(harness.executionPolicy).toBe('controlled')
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Read Only When a legacy structured handoff is restored Then it remains approvable without enforcing the old template', async () => {
    const approvalLabel = '仅执行本次'
    const harness = await createHarness({
      askUser: async (input) => {
        const questions = input.questions as Array<{ question: string }>
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            answers: { [questions[0]!.question]: approvalLabel },
          },
        }
      },
    })
    try {
      harness.workflow = 'read-only'
      const input = {
        intent: '修复查询',
        direction: '调整 SQL 并补测试',
        reason: '需要写文件',
      }
      expect(await harness.authorize({
        type: 'request-direct-workflow', input, signal: new AbortController().signal,
      })).toEqual({ behavior: 'allow', updatedInput: input })
      expect(harness.asks[0]).toMatchObject({
        presentation: {
          kind: 'direct-workflow',
          details: '修复查询\n\n调整 SQL 并补测试\n\n需要写文件',
        },
      })
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Read Only When tools are authorized Then safe exploration and planning escalation are allowed while writes remain denied', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'read-only'
      const safeBashInputs = [
        { command: 'git status --short' },
        { command: `grep error audit.log | sed -n '1,20p' | sort | uniq -c` },
        { command: `awk '{ count++ } END { print count }' audit.log` },
        { command: `powershell.exe -NoProfile -Command "Get-Content 'audit.log' | Measure-Object -Line"` },
      ]
      for (const safeBash of safeBashInputs) {
        expect(await harness.authorize({ type: 'tool', toolName: 'Bash', input: safeBash, options: toolOptions() }))
          .toEqual({ behavior: 'allow', updatedInput: safeBash })
      }

      const progressInput = { subject: '调研权限', description: '记录只读调研进度' }
      expect(await harness.authorize({
        type: 'tool', toolName: 'TaskCreate', input: progressInput, options: toolOptions('product'),
      })).toEqual({ behavior: 'allow', updatedInput: progressInput })

      const writeBash = { command: 'git add .' }
      expect((await harness.authorize({ type: 'tool', toolName: 'Bash', input: writeBash, options: toolOptions() })).behavior)
        .toBe('deny')

      const planWrite = { file_path: join(harness.planSidecarDir, 'implementation.md'), content: '# Plan' }
      expect((await harness.authorize({ type: 'tool', toolName: 'Write', input: planWrite, options: toolOptions() })).behavior)
        .toBe('deny')
      expect(await harness.authorize({ type: 'tool', toolName: 'EnterPlanMode', input: {}, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: {} })
      expect(harness.workflow as AgentWorkflow).toBe('plan-first')
      expect(harness.workflowChanges).toEqual([{ workflow: 'plan-first', source: 'enter-plan' }])
      expect(harness.approvals).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Read Only When an image is outside the project Then pure reads are allowed but mutation remains denied', async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), 'pi-read-only-external-'))
    const imagePath = join(externalRoot, 'image.png')
    await writeFile(imagePath, 'fixture')
    const harness = await createHarness()
    try {
      harness.workflow = 'read-only'
      harness.executionPolicy = 'controlled'

      for (const [toolName, input] of [
        ['Read', { file_path: imagePath }],
        ['LS', { path: externalRoot }],
        ['Bash', { command: `cat "${imagePath}"` }],
      ] as const) {
        expect(await harness.authorize({ type: 'tool', toolName, input, options: toolOptions() }))
          .toEqual({ behavior: 'allow', updatedInput: input })
      }

      const writeInput = { file_path: join(externalRoot, 'changed.txt'), content: 'blocked' }
      expect((await harness.authorize({ type: 'tool', toolName: 'Write', input: writeInput, options: toolOptions() })).behavior)
        .toBe('deny')
      expect(harness.approvals).toEqual([])
    } finally {
      await Promise.all([
        harness.dispose(),
        rm(externalRoot, { recursive: true, force: true }),
      ])
    }
  })

  test('Given Pi Read Only When a future MCP declares trusted read-only capability Then metadata allows the read but not contradictory destructive claims', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'read-only'
      const input = { query: 'inspect' }
      expect(await harness.authorize({
        type: 'tool', toolName: 'mcp__future__inspect', input,
        options: toolOptions('mcp', { readOnlyHint: true }),
      })).toEqual({ behavior: 'allow', updatedInput: input })
      expect((await harness.authorize({
        type: 'tool', toolName: 'mcp__future__contradictory', input,
        options: toolOptions('mcp', { readOnlyHint: true, destructiveHint: true }),
      })).behavior).toBe('deny')
    } finally {
      await harness.dispose()
    }
  })

  test.each(['direct', 'plan-first', 'read-only'] as const)(
    'Given Pi %s When the exact product PlanFocusedValidation carries trusted read-only annotations Then it is allowed without policy approval',
    async (workflow) => {
      const harness = await createHarness()
      try {
        harness.workflow = workflow
        harness.executionPolicy = 'controlled'
        const input = { changedFiles: ['src/example.ts'] }
        expect(await harness.authorize({
          type: 'tool',
          toolName: 'PlanFocusedValidation',
          input,
          options: toolOptions('product', { readOnlyHint: true, destructiveHint: false }),
        })).toEqual({ behavior: 'allow', updatedInput: input })
        expect(harness.approvals).toEqual([])
      } finally {
        await harness.dispose()
      }
    },
  )

  test.each(['host', 'builtin-mcp', 'mcp', 'resource'] as const)(
    'Given a %s tool spoofs the PlanFocusedValidation name When it claims read-only annotations Then exact product provenance is still required',
    async (toolSource) => {
      const harness = await createHarness()
      try {
        harness.workflow = 'read-only'
        const result = await harness.authorize({
          type: 'tool',
          toolName: 'PlanFocusedValidation',
          input: { changedFiles: ['src/example.ts'] },
          options: toolOptions(toolSource, { readOnlyHint: true, destructiveHint: false }),
        })
        expect(result.behavior).toBe('deny')
        expect(harness.approvals).toEqual([])
      } finally {
        await harness.dispose()
      }
    },
  )

  test('Given the product planner lacks trustworthy non-destructive annotations When authorized Then it fails closed', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'read-only'
      expect((await harness.authorize({
        type: 'tool',
        toolName: 'PlanFocusedValidation',
        input: { changedFiles: ['src/example.ts'] },
        options: toolOptions('product', { readOnlyHint: true, destructiveHint: true }),
      })).behavior).toBe('deny')
    } finally {
      await harness.dispose()
    }
  })

  test('Given Pi Plan First When tools are authorized Then safe Bash, canonical sidecar Markdown, and Managed Web are allowed but project writes are denied', async () => {
    const harness = await createHarness()
    try {
      const safeBash = { command: 'rg TODO src' }
      expect(await harness.authorize({ type: 'tool', toolName: 'Bash', input: safeBash, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: safeBash })

      const planPath = join(harness.planSidecarDir, 'implementation.md')
      const writeInput = { file_path: planPath, content: '# Plan' }
      expect(await harness.authorize({ type: 'tool', toolName: 'Write', input: writeInput, options: toolOptions() }))
        .toEqual({ behavior: 'allow', updatedInput: writeInput })

      const projectWrite = { file_path: join(harness.workspaceRoot, 'src.ts'), content: 'change' }
      expect((await harness.authorize({ type: 'tool', toolName: 'Write', input: projectWrite, options: toolOptions() })).behavior)
        .toBe('deny')
      expect((await harness.authorize({ type: 'tool', toolName: 'WebSearch', input: {}, options: toolOptions('product') })).behavior)
        .toBe('allow')
      expect((await harness.authorize({ type: 'tool', toolName: 'WebSearch', input: {}, options: toolOptions('host') })).behavior)
        .toBe('deny')
    } finally {
      await harness.dispose()
    }
  })

  test('Given a live Pi run When controls hot-switch Then the next authorization reads the new Workflow and Execution Policy', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'direct'
      harness.executionPolicy = 'controlled'
      const externalWrite = { file_path: join(harness.workspaceRoot, '..', 'outside.txt'), content: 'x' }
      expect((await harness.authorize({ type: 'tool', toolName: 'Write', input: externalWrite, options: toolOptions() })).behavior)
        .toBe('allow')
      expect(harness.approvals).toEqual(['Write'])

      harness.executionPolicy = 'full-access'
      expect((await harness.authorize({ type: 'tool', toolName: 'Write', input: externalWrite, options: toolOptions() })).behavior)
        .toBe('allow')
      expect(harness.approvals).toEqual(['Write'])
    } finally {
      await harness.dispose()
    }
  })

  test('Given an interactive Pi run When AskUser executes Then the existing AskUser adapter result is returned unchanged', async () => {
    const harness = await createHarness()
    try {
      const input = { questions: [{ question: 'Choose?' }] }
      expect(await harness.authorize({ type: 'ask-user', input, signal: new AbortController().signal }))
        .toEqual({ behavior: 'allow', updatedInput: { answers: { choice: 'A' } } })
      expect(harness.asks).toEqual([input])
    } finally {
      await harness.dispose()
    }
  })
})

describe('Pi terminal tool execution controls', () => {
  test('TerminalRun is denied in Read Only while TerminalRead remains trusted product read', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'read-only'
      expect((await harness.authorize({
        type: 'tool', toolName: 'TerminalRun', input: { command: 'bun run dev' }, options: toolOptions('product'),
      })).behavior).toBe('deny')
      expect((await harness.authorize({
        type: 'tool', toolName: 'TerminalRead', input: { terminalId: 't1' },
        options: toolOptions('product', { readOnlyHint: true, destructiveHint: false }),
      })).behavior).toBe('allow')
    } finally {
      await harness.dispose()
    }
  })

  test('TerminalRun uses shell policy and terminal stop controls do not request write approval', async () => {
    const harness = await createHarness()
    try {
      harness.workflow = 'direct'
      harness.executionPolicy = 'autonomous'
      const run = await harness.authorize({
        type: 'tool', toolName: 'TerminalRun', input: { command: 'git clean -fd' }, options: toolOptions('product'),
      })
      expect(run.behavior).toBe('allow')
      expect(harness.approvals).toContain('TerminalRun')

      const before = harness.approvals.length
      expect((await harness.authorize({
        type: 'tool', toolName: 'TerminalClose', input: { terminalId: 't1' }, options: toolOptions('product'),
      })).behavior).toBe('allow')
      expect(harness.approvals).toHaveLength(before)
    } finally {
      await harness.dispose()
    }
  })
})
