import { beforeAll, describe, expect, test } from 'bun:test'
import { createExecutionPolicy } from './execution-policy/execution-policy.ts'
import { authorizeToolForWorkflow, resolvePlanToolAccess, resolveReadOnlyToolAccess, transitionAgentWorkflow } from './agent-workflow-policy.ts'
import { initializeShellAnalysis } from './execution-policy/shell-analysis.ts'

beforeAll(async () => {
  await initializeShellAnalysis()
})

describe('Plan tool policy', () => {
  const planSidecarDir = 'C:\\Domi\\sessions\\session-1\\plan'

  test('Given Plan First When builtin research and interaction tools run Then the workflow classifies them as read-only candidates', () => {
    for (const toolName of ['Read', 'Glob', 'Grep', 'Find', 'Ls', 'Bash', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(resolvePlanToolAccess({
        toolName,
        input: toolName === 'Bash' ? { command: 'git status --short' } : {},
        cwd: 'C:\\repo',
        planSidecarDir,
      })).toMatchObject({ outcome: 'allow' })
    }
  })

  test('Given Plan First When Managed Web product tools run Then they are explicit read-only product exceptions', () => {
    for (const toolName of ['WebSearch', 'WebFetch']) {
      expect(resolvePlanToolAccess({
        toolName,
        input: {},
        cwd: 'C:\\repo',
        planSidecarDir,
        toolSource: 'product',
      })).toMatchObject({ outcome: 'allow' })
    }
  })

  test('Given Read Only or Plan First When the user researches with the managed browser Then the bounded browser surface remains available', () => {
    const browserTools = [
      'BrowserOpen',
      'BrowserNavigate',
      'BrowserSnapshot',
      'BrowserClick',
      'BrowserType',
      'BrowserScroll',
      'BrowserExtract',
      'BrowserClose',
    ]
    for (const workflow of ['read-only', 'plan-first'] as const) {
      const resolveAccess = workflow === 'read-only' ? resolveReadOnlyToolAccess : resolvePlanToolAccess
      for (const toolName of browserTools) {
        expect(resolveAccess({
          toolName,
          input: {},
          cwd: 'C:\\repo',
          planSidecarDir,
          toolSource: 'product',
          toolAnnotations: { readOnlyHint: false, destructiveHint: false },
        })).toMatchObject({ outcome: 'allow' })
      }
    }
  })

  test('Given Plan First When a plan file is written Then only the injected session sidecar directory is writable', () => {
    expect(resolvePlanToolAccess({
      toolName: 'Write',
      input: { file_path: 'C:\\Domi\\sessions\\session-1\\plan\\proposal.md' },
      cwd: 'C:\\repo',
      planSidecarDir,
    })).toMatchObject({ outcome: 'allow' })
    expect(resolvePlanToolAccess({
      toolName: 'Write',
      input: { file_path: 'C:\\repo\\PLAN.md' },
      cwd: 'C:\\repo',
      planSidecarDir,
    })).toMatchObject({ outcome: 'deny' })
  })

  test('Given Plan First When MCP tools are considered Then trusted capability metadata and explicit fallbacks pass', () => {
    expect(resolvePlanToolAccess({ toolName: 'mcp__chrome_devtools__take_snapshot', input: {}, cwd: 'C:\\repo', planSidecarDir, toolSource: 'builtin-mcp' }).outcome).toBe('allow')
    expect(resolvePlanToolAccess({ toolName: 'mcp__chrome_devtools__click', input: {}, cwd: 'C:\\repo', planSidecarDir, toolSource: 'builtin-mcp' }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({ toolName: 'TaskGet', input: { taskId: '1' }, cwd: 'C:\\repo', planSidecarDir, toolSource: 'product' }).outcome).toBe('allow')
    expect(resolvePlanToolAccess({ toolName: 'mcp__planning__list_todos', input: {}, cwd: 'C:\\repo', planSidecarDir, toolSource: 'product' }).outcome).toBe('allow')
    for (const toolName of [
      'mcp__exa__web_search_exa',
      'mcp__exa__web_fetch_exa',
      'mcp__context7__resolve_library_id',
      'mcp__context7__query_docs',
      'mcp__searchcode__code_analyze',
      'mcp__searchcode__code_search',
      'mcp__searchcode__code_get_file',
      'mcp__searchcode__code_file_tree',
      'mcp__searchcode__code_get_files',
      'mcp__searchcode__code_get_findings',
    ]) {
      expect(resolvePlanToolAccess({
        toolName, input: {}, cwd: 'C:\\repo', planSidecarDir,
        toolSource: 'mcp', toolAnnotations: { readOnlyHint: true },
      }).outcome).toBe('allow')
    }
    expect(resolveReadOnlyToolAccess({
      toolName: 'mcp__exa__web_fetch_exa', input: {}, cwd: 'C:\\repo', planSidecarDir,
      toolSource: 'mcp', toolAnnotations: { readOnlyHint: true },
    }).outcome).toBe('allow')
    expect(resolvePlanToolAccess({
      toolName: 'mcp__future_server__inspect', input: {}, cwd: 'C:\\repo', planSidecarDir,
      toolSource: 'mcp', toolAnnotations: { readOnlyHint: true },
    }).outcome).toBe('allow')
    expect(resolvePlanToolAccess({
      toolName: 'mcp__future_server__contradictory', input: {}, cwd: 'C:\\repo', planSidecarDir,
      toolSource: 'mcp', toolAnnotations: { readOnlyHint: true, destructiveHint: true },
    }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({
      toolName: 'mcp__resource__spoof', input: {}, cwd: 'C:\\repo', planSidecarDir,
      toolSource: 'resource', toolAnnotations: { readOnlyHint: true },
    }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({
      toolName: 'host_spoof', input: {}, cwd: 'C:\\repo', planSidecarDir,
      toolSource: 'host', toolAnnotations: { readOnlyHint: true },
    }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({ toolName: 'mcp__planning__update_todo', input: {}, cwd: 'C:\\repo', planSidecarDir }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({ toolName: 'mcp__untrusted__claims_read_only', input: {}, cwd: 'C:\\repo', planSidecarDir, toolSource: 'mcp' }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({ toolName: 'mcp__exa__web_search_exa', input: {}, cwd: 'C:\\repo', planSidecarDir, toolSource: 'mcp' }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({ toolName: 'Read', input: {}, cwd: 'C:\\repo', planSidecarDir, toolSource: 'resource' }).outcome).toBe('deny')
    expect(resolvePlanToolAccess({ toolName: 'mcp__planning__list_todos', input: {}, cwd: 'C:\\repo', planSidecarDir, toolSource: 'mcp' }).outcome).toBe('deny')
  })

  test('Given unattended Plan First When a tool needs user interaction Then it is visibly denied', () => {
    expect(resolvePlanToolAccess({
      toolName: 'AskUserQuestion',
      input: {},
      cwd: 'C:\\repo',
      planSidecarDir,
      interaction: 'unattended',
    })).toMatchObject({ outcome: 'deny' })
  })

  test('Given Read Only or Plan First When explicit read tools target any local path Then reads stay allowed without Workspace Boundary approval', async () => {
    for (const workflow of ['read-only', 'plan-first'] as const) {
      for (const executionPolicyMode of ['controlled', 'full-access'] as const) {
        let approvalCount = 0
        const executionPolicy = createExecutionPolicy({
          executionPolicy: executionPolicyMode,
          workspaceRoot: 'C:\\repo',
          canonicalize: async (path) => path,
          requestApproval: async () => {
            approvalCount += 1
            return 'denied'
          },
        })

        const calls = [
          { toolName: 'Read', input: { path: 'C:\\outside\\image.png' } },
          { toolName: 'Glob', input: { pattern: '..\\outside\\*.md' } },
          { toolName: 'Bash', input: { command: 'cat C:\\outside\\MEMORY.md' } },
          { toolName: 'Bash', input: { command: 'fd image C:\\outside' } },
        ]
        for (const call of calls) {
          expect(await authorizeToolForWorkflow({
            workflow,
            call: { ...call, cwd: 'C:\\repo', planSidecarDir },
            executionPolicy,
          })).toMatchObject({ outcome: 'allow' })
        }
        expect(approvalCount).toBe(0)
      }
    }
  })

  test('Given restricted workflows When finite read-only Bash or network GET runs Then Workflow and Execution Policy remain separate', async () => {
    for (const workflow of ['read-only', 'plan-first'] as const) {
      const localApprovals: string[] = []
      const controlledLocalPolicy = createExecutionPolicy({
        executionPolicy: 'controlled',
        workspaceRoot: 'C:\\repo',
        canonicalize: async (path) => path,
        requestApproval: async (request) => {
          localApprovals.push(request.category)
          return 'denied'
        },
      })
      for (const command of [
        'cat C:\\outside\\MEMORY.md | head -n 5',
        "rg 'curl|gh api' src",
        "wc -l session.jsonl && grep -n 'permission_request\\|git restore --worktree pnpm-lock.yaml' session.jsonl | tail -20",
      ]) {
        expect(await authorizeToolForWorkflow({
          workflow,
          call: {
            toolName: 'Bash',
            input: { command },
            cwd: 'C:\\repo',
            planSidecarDir,
          },
          executionPolicy: controlledLocalPolicy,
        })).toMatchObject({ outcome: 'allow' })
      }
      expect(localApprovals).toEqual([])

      const networkApprovals: string[] = []
      const controlledNetworkPolicy = createExecutionPolicy({
        executionPolicy: 'controlled',
        workspaceRoot: 'C:\\repo',
        requestApproval: async (request) => {
          networkApprovals.push(request.category)
          return 'approved'
        },
      })
      expect(await authorizeToolForWorkflow({
        workflow,
        call: {
          toolName: 'Bash',
          input: {
            command: "curl -fsSL https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.4.tgz | tar -xzOf - package/dist/core/agent-session.d.ts | grep -nE 'retryNow|supportsInline'",
          },
          cwd: 'C:\\repo',
          planSidecarDir,
        },
        executionPolicy: controlledNetworkPolicy,
      })).toMatchObject({ outcome: 'allow' })
      expect(networkApprovals).toEqual(['process-network'])

      const fullAccessApprovals: string[] = []
      const fullAccessPolicy = createExecutionPolicy({
        executionPolicy: 'full-access',
        workspaceRoot: 'C:\\repo',
        requestApproval: async (request) => {
          fullAccessApprovals.push(request.category)
          return 'denied'
        },
      })
      expect(await authorizeToolForWorkflow({
        workflow,
        call: {
          toolName: 'Bash',
          input: { command: 'gh release list --repo restflux/domi' },
          cwd: 'C:\\repo',
          planSidecarDir,
        },
        executionPolicy: fullAccessPolicy,
      })).toMatchObject({ outcome: 'allow' })
      expect(fullAccessApprovals).toEqual([])
    }
  })

  test('Given Read Only When screenshot-style log inspection runs Then stdout-only Bash, awk, and PowerShell reads stay frictionless', () => {
    for (const command of [
      `grep '"category":"pi_run_timing","action":"compaction"' 'C:/Users/A/.domi/audit/events.jsonl' | grep -E '"timestamp":"2026-08-(23|24|25)' | sed -E 's/.*"strategy":"([^"]+)".*/\\1/' | sort | uniq -c | sort -nr`,
      `awk '/"category":"pi_run_timing","action":"compaction"/ && /"timestamp":"2026-08-(23|24|25)/ { s=$0; sub(/.*"stage":"/,"",s); sub(/".*$/,"",s); c[s]++ } END { for (k in c) print c[k], k }' 'C:/Users/A/.domi/audit/events.jsonl'`,
      `powershell.exe -NoProfile -Command "(Select-String -Path 'C:\\Users\\A\\.domi\\audit\\events.jsonl' -SimpleMatch '\"action\":\"compaction\"').Count"`,
    ]) {
      expect(resolveReadOnlyToolAccess({
        toolName: 'Bash',
        input: { command },
        cwd: 'C:\\repo',
        planSidecarDir,
      })).toMatchObject({ outcome: 'allow' })
    }
  })

  test('Given Read Only When a terminal read cannot be proven Then the denial points the Agent to builtin read tools', () => {
    expect(resolveReadOnlyToolAccess({
      toolName: 'Bash',
      input: { command: `awk '{ system("rm victim") }' audit.log` },
      cwd: 'C:\\repo',
      planSidecarDir,
    })).toEqual({
      outcome: 'deny',
      reason: expect.stringContaining('优先改用内置 Read、Grep、Find 或 Ls'),
    })
  })

  test('Given Read Only or Plan First When Bash is authorized Then both allow safe reads and reject writes before approval', async () => {
    for (const workflow of ['read-only', 'plan-first'] as const) {
      const approvals: string[] = []
      const executionPolicy = createExecutionPolicy({
        executionPolicy: 'full-access',
        workspaceRoot: 'C:\\repo',
        canonicalize: async (path) => path,
        requestApproval: async (request) => {
          approvals.push(request.category)
          return 'approved'
        },
      })
      const safe = await authorizeToolForWorkflow({
        workflow,
        call: { toolName: 'Bash', input: { command: 'git status --short' }, cwd: 'C:\\repo', planSidecarDir },
        executionPolicy,
      })
      const safeWithCdPrefix = await authorizeToolForWorkflow({
        workflow,
        call: { toolName: 'Bash', input: { command: 'cd src && git status --short' }, cwd: 'C:\\repo', planSidecarDir },
        executionPolicy,
      })
      const write = await authorizeToolForWorkflow({
        workflow,
        call: { toolName: 'Bash', input: { command: 'git add .' }, cwd: 'C:\\repo', planSidecarDir },
        executionPolicy,
      })
      const writeAfterCd = await authorizeToolForWorkflow({
        workflow,
        call: { toolName: 'Bash', input: { command: 'cd src && git add .' }, cwd: 'C:\\repo', planSidecarDir },
        executionPolicy,
      })
      expect(safe).toMatchObject({ outcome: 'allow' })
      expect(safeWithCdPrefix).toMatchObject({ outcome: 'allow' })
      expect(write).toMatchObject({ outcome: 'deny' })
      expect(writeAfterCd).toMatchObject({ outcome: 'deny' })
      expect(approvals).toEqual([])
    }
  })

  test('Given Read Only When Agent requests a host-managed Direct switch Then the request is allowed, but Plan First must use plan approval', () => {
    expect(resolveReadOnlyToolAccess({
      toolName: 'RequestDirectWorkflow',
      input: { details: '已定位查询构造，准备调整 SQL 并补测试。' },
      cwd: 'C:\\repo',
      planSidecarDir,
    })).toMatchObject({ outcome: 'allow' })
    expect(resolvePlanToolAccess({
      toolName: 'RequestDirectWorkflow',
      input: { details: '已定位查询构造，准备调整 SQL 并补测试。' },
      cwd: 'C:\\repo',
      planSidecarDir,
    })).toMatchObject({ outcome: 'deny' })
  })

  test('Given built-in image generation targets only session attachments When invoked in Read Only Then it stays available without opening project execution', () => {
    for (const toolName of ['mcp__gpt_image__imagegen', 'mcp__nano_banana__generate_image']) {
      expect(resolveReadOnlyToolAccess({
        toolName,
        input: { prompt: 'draw a cat', outputMode: 'session' },
        cwd: 'C:\\repo',
        planSidecarDir,
        toolSource: 'product',
      })).toMatchObject({ outcome: 'allow' })
    }
  })

  test('Given built-in image generation requests a workspace file When invoked in a restricted workflow Then normal execution promotion is still required', () => {
    for (const resolveAccess of [resolveReadOnlyToolAccess, resolvePlanToolAccess]) {
      expect(resolveAccess({
        toolName: 'mcp__gpt_image__imagegen',
        input: { prompt: 'draw a cat', outputMode: 'workspace' },
        cwd: 'C:\\repo',
        planSidecarDir,
        toolSource: 'product',
      })).toMatchObject({ outcome: 'deny' })
    }
  })

  test('Given Plan First When built-in image generation targets session attachments Then planning remains side-effect free', () => {
    expect(resolvePlanToolAccess({
      toolName: 'mcp__gpt_image__imagegen',
      input: { prompt: 'draw a cat', outputMode: 'session' },
      cwd: 'C:\\repo',
      planSidecarDir,
      toolSource: 'product',
    })).toMatchObject({ outcome: 'deny' })
  })

  test('Given Read Only When session progress tools are used Then exploration can stay observable without opening project writes', () => {
    for (const toolName of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoRead']) {
      expect(resolveReadOnlyToolAccess({
        toolName,
        input: {},
        cwd: 'C:\\repo',
        planSidecarDir,
        toolSource: 'product',
      })).toMatchObject({ outcome: 'allow' })
    }
  })

  test('Given Read Only When sidecar or project writes are attempted Then neither is allowed', () => {
    expect(resolveReadOnlyToolAccess({
      toolName: 'Write',
      input: { file_path: 'C:\\Domi\\sessions\\session-1\\plan\\proposal.md' },
      cwd: 'C:\\repo',
      planSidecarDir,
    })).toMatchObject({ outcome: 'deny' })
    expect(resolveReadOnlyToolAccess({
      toolName: 'Write',
      input: { file_path: 'C:\\repo\\src\\change.ts' },
      cwd: 'C:\\repo',
      planSidecarDir,
    })).toMatchObject({ outcome: 'deny' })
  })

  test('Given any Execution Policy with Plan First When project code is written Then workflow read-only wins', async () => {
    for (const executionPolicyMode of ['controlled', 'full-access'] as const) {
      const executionPolicy = createExecutionPolicy({ executionPolicy: executionPolicyMode, workspaceRoot: 'C:\\repo' })
      const decision = await authorizeToolForWorkflow({
        workflow: 'plan-first',
        call: { toolName: 'Write', input: { file_path: 'C:\\repo\\src\\change.ts' }, cwd: 'C:\\repo', planSidecarDir },
        executionPolicy,
      })
      expect(decision).toMatchObject({ outcome: 'deny' })
    }
  })
})

describe('Workflow transitions', () => {
  test('Given Direct workflow When EnterPlanMode runs Then only workflow changes to Plan First', () => {
    expect(transitionAgentWorkflow('direct', { type: 'enter-plan' })).toEqual({ workflow: 'plan-first', outcome: 'allow' })
  })

  test('Given Read Only workflow When Agent requests EnterPlanMode Then it can escalate to the still-restricted Plan First workflow', () => {
    expect(transitionAgentWorkflow('read-only', { type: 'enter-plan' })).toEqual({ workflow: 'plan-first', outcome: 'allow' })
  })

  test('Given Read Only When the user approves the host switch Then workflow returns to Direct without an execution policy value', () => {
    const transition = transitionAgentWorkflow('read-only', { type: 'approve-read-only' })
    expect(transition).toEqual({ workflow: 'direct', outcome: 'allow' })
    expect(transition).not.toHaveProperty('executionPolicy')
  })

  test('Given Plan First When the user approves the plan Then workflow returns to Direct without an execution policy value', () => {
    const transition = transitionAgentWorkflow('plan-first', { type: 'approve-plan' })
    expect(transition).toEqual({ workflow: 'direct', outcome: 'allow' })
    expect(transition).not.toHaveProperty('executionPolicy')
  })

  test('Given Plan First When feedback or denial is chosen Then workflow stays Plan First', () => {
    expect(transitionAgentWorkflow('plan-first', { type: 'feedback' })).toEqual({ workflow: 'plan-first', outcome: 'deny' })
    expect(transitionAgentWorkflow('plan-first', { type: 'deny-plan' })).toEqual({ workflow: 'plan-first', outcome: 'deny' })
  })
})
