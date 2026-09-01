import { beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('./user-profile-service', () => ({
  getUserProfile: () => ({ userName: '测试用户' }),
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: () => undefined,
  getAgentWorkspaceBySlug: () => undefined,
  getProjectFilesPath: () => '/tmp/sample-project',
  getWorkspaceAgentsMdPath: () => '/tmp/domi-workspace/AGENTS.md',
  getWorkspaceAutoMemoryDir: () => '/tmp/memory',
  getWorkspaceMcpConfig: () => ({ servers: {} }),
  listAgentWorkspaces: () => [],
}))

mock.module('./agent-git-attribution', () => ({
  // Claude SDK sidecar attribution migration no longer exists.
  buildGitAttributionPromptSection: () => '',
  isGitAttributionEnabled: () => false,
}))

mock.module('./settings-service', () => ({
  getSettings: () => ({ gitAttributionEnabled: false }),
}))

let buildSystemPrompt: typeof import('./agent-prompt-builder').buildSystemPrompt
let buildDynamicContext: typeof import('./agent-prompt-builder').buildDynamicContext

beforeAll(async () => {
  ({ buildSystemPrompt, buildDynamicContext } = await import('./agent-prompt-builder'))
})

function buildPrompt(agentCwd: string): string {
  return buildSystemPrompt({
    workspaceName: '示例项目',
    workspaceSlug: 'sample-project',
    sessionId: 'session-1',
    agentCwd,
    permissionMode: 'bypassPermissions',
    executionPolicy: 'controlled',
    workflow: 'direct',
  })
}

describe('受信项目指令注入', () => {
  test('Given Domi 与 Session Target 指令 When 构建 system prompt Then 按安全优先级注入验证路径和正文', () => {
    const prompt = buildSystemPrompt({
      workspaceName: '示例项目',
      workspaceSlug: 'sample-project',
      sessionId: 'session-instructions',
      agentCwd: '/tmp/isolated-checkout',
      permissionMode: 'bypassPermissions',
      trustedInstructions: {
        workspace: {
          kind: 'agents',
          absolutePath: '/tmp/domi-workspace/AGENTS.md',
          content: '# Domi rules\n- use bun',
          contentHash: 'workspace-hash',
        },
        project: {
          projectRoot: '/tmp/isolated-checkout',
          source: {
            kind: 'agents',
            relativePath: 'AGENTS.md',
            absolutePath: '/tmp/isolated-checkout/AGENTS.md',
            content: '# Checkout rules\n- run focused tests',
            contentHash: 'project-hash',
          },
          diagnostics: [],
        },
      },
    })

    expect(prompt).toContain('Domi system prompt、权限与 Session Target')
    expect(prompt).toContain('/tmp/domi-workspace/AGENTS.md')
    expect(prompt).toContain('# Domi rules\n- use bun')
    expect(prompt).toContain('/tmp/isolated-checkout/AGENTS.md')
    expect(prompt).toContain('# Checkout rules\n- run focused tests')
    expect(prompt.indexOf('# Domi rules')).toBeLessThan(prompt.indexOf('# Checkout rules'))
  })

  test('Given 项目根只存在 legacy CLAUDE.md When 注入 Then 标记只读兼容且禁止自动改写用户文件', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-legacy',
      permissionMode: 'bypassPermissions',
      trustedInstructions: {
        project: {
          projectRoot: '/tmp/project',
          source: {
            kind: 'claude',
            relativePath: 'CLAUDE.md',
            absolutePath: '/tmp/project/CLAUDE.md',
            content: '# Legacy rules',
            contentHash: 'legacy-hash',
          },
          diagnostics: [],
        },
      },
    })

    expect(prompt).toContain('legacy `CLAUDE.md` 只读兼容来源')
    expect(prompt).toContain('不得自动重命名、删除或覆盖用户项目文件')
  })
})

describe('用户自定义 Work 提示词', () => {
  test('Given Work 提示词已启用 When 构建标准提示词 Then 作为附加偏好注入且不改变宿主控制', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-work-prompt',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      workSystemPrompt: '产品页面只呈现用户完成任务所需的信息。',
    })

    expect(prompt).toContain('## 用户自定义 Work 提示词')
    expect(prompt).toContain('产品页面只呈现用户完成任务所需的信息。')
    expect(prompt).toContain('Execution Policy、Workflow、Session Target 与工具授权继续由 Domi 宿主规则和工具门禁决定')
  })

  test('Given Work 提示词为空 When 构建标准提示词 Then 不生成空的附加段落', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-no-work-prompt',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'controlled',
      workflow: 'direct',
    })

    expect(prompt).not.toContain('## 用户自定义 Work 提示词')
  })
})

describe('Coding Fast Lane 提示词', () => {
  test('Given interactive Direct When building the prompt Then low-risk coding uses the shortest verified path', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-fast-lane',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'controlled',
      workflow: 'direct',
      interaction: 'interactive',
      sessionTarget: { kind: 'isolated', ownership: 'owner' },
    })

    expect(prompt).toContain('## Coding Fast Lane')
    expect(prompt).toContain('一次集中调查 → 修改 → 一次集中验证 → 交付')
    expect(prompt).toContain('可并行且彼此独立的 Read、Grep、Find')
    expect(prompt).toContain('已明确对应测试文件或验证命令时，不调用 `PlanFocusedValidation`')
    expect(prompt).toContain('Fast 默认只运行最相关测试')
    expect(prompt).toContain('不默认运行全仓 typecheck、Electron build、打包或完整安全矩阵')
    expect(prompt).toContain('同一代码快照下已通过的命令不重复运行')
    expect(prompt).toContain('Standard 在开发中只运行相关测试，完成后集中进行一次最终验证')
    expect(prompt).toContain('shared 类型、根配置或跨 package 接口')
    expect(prompt).toContain('权限、安全、凭据、Worktree 生命周期')
    expect(prompt).toContain('Electron 运行时依赖')
    expect(prompt).toContain('调用 `EnterPlanMode`')
    expect(prompt).toContain('根据当前 Workflow、Session Target 和已知工具能力，避免调用必然会被拒绝或当前不可用的工具')
    expect(prompt).toContain('不能改变 Execution Policy、Workflow 的宿主语义或 Session Target')
  })

  test('Given Plan First or Read Only When building the prompt Then coding fast lane is not injected', () => {
    for (const workflow of ['plan-first', 'read-only'] as const) {
      const prompt = buildSystemPrompt({
        sessionId: `session-${workflow}`,
        permissionMode: 'bypassPermissions',
        executionPolicy: 'autonomous',
        workflow,
        interaction: 'interactive',
      })

      expect(prompt).not.toContain('## Coding Fast Lane')
      expect(prompt).not.toContain('一次集中调查 → 修改 → 一次集中验证 → 交付')
    }
  })

  test('Given unattended or delivered follow-up Direct When building the prompt Then it does not suggest an interactive fast lane', () => {
    const unattended = buildSystemPrompt({
      sessionId: 'session-automation',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'autonomous',
      workflow: 'direct',
      interaction: 'unattended',
    })
    const followup = buildSystemPrompt({
      sessionId: 'session-followup',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'controlled',
      workflow: 'direct',
      interaction: 'interactive',
      sessionTarget: { kind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'delivered' },
    })

    expect(unattended).not.toContain('## Coding Fast Lane')
    expect(unattended).not.toContain('调用 `EnterPlanMode`')
    expect(followup).not.toContain('## Coding Fast Lane')
    expect(followup).toContain('`RequestNextWorktreeIteration`')
  })

  test('Given discarded follow-up When building the prompt Then it preserves chat but starts future edits in a clean iteration', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-discarded-followup',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'controlled',
      workflow: 'direct',
      interaction: 'interactive',
      sessionTarget: { kind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'discarded' },
    })

    expect(prompt).toContain('当前 Worktree 迭代已被用户放弃并清理')
    expect(prompt).toContain('`RequestNextWorktreeIteration`')
    expect(prompt).toContain('创建全新的下一轮 Worktree')
    expect(prompt).toContain('已放弃迭代的修改不得恢复或带入新环境')
  })
})

describe('Pi Bash shell 方言提示词', () => {
  test('Given a long-running service When guiding tool selection Then requires TerminalRun so the service remains monitored', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('启动或重启 dev server')
    expect(prompt).toContain('必须使用 TerminalRun')
    expect(prompt).toContain('禁止通过 Bash 的 `&` / `nohup` 等方式脱管后台启动')
    expect(prompt).toContain('顶部服务监控只跟踪 TerminalRun 托管进程')
  })

  test('Given a Pi system prompt When describing Bash usage Then warns against CMD null redirection under Git Bash', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('Windows Git Bash 重定向')
    expect(prompt).toContain('`/dev/null`')
    expect(prompt).toContain('`>nul` / `2>nul`')
    expect(prompt).toContain('`cmd.exe /c "..."`')
  })
})

describe('Pi Execution Controls 提示词', () => {
  test('Given Execute When building the prompt Then it states the two-mode and no-sandbox contract', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('当前持久模式：执行')
    expect(prompt).toContain('当前 Windows 用户权限')
    expect(prompt).toContain('未经过 OS 沙箱隔离')
    expect(prompt).toContain('宿主管理事务仍有独立确认边界')
    expect(prompt).not.toContain('bypassPermissions')
    expect(prompt).not.toContain('Controlled')
    expect(prompt).not.toContain('Autonomous')
  })

  test('Given Pi Full Access Plan First When building the prompt Then it requires the complete plan and exposes the fixed session file path', () => {
    const prompt = buildSystemPrompt({
      workspaceName: '示例项目',
      workspaceSlug: 'sample-project',
      sessionId: 'session-1',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'plan-first',
    })

    expect(prompt).toContain('当前持久模式：研究')
    expect(prompt).toContain('当前处于本轮临时计划阶段')
    expect(prompt).toContain('批准时默认只为当前计划开放执行')
    expect(prompt).toContain('注册时声明为只读且非破坏性的可信 Product/MCP 工具')
    expect(prompt).toContain('只读 Bash 命令')
    expect(prompt).toContain('纯读取可访问任意本机路径，不受 Workspace Boundary 限制')
    expect(prompt).toContain('## 计划文件与审批')
    expect(prompt).toContain('完整 Markdown 计划放入必填的 `plan` 参数')
    expect(prompt).toContain('不要只把计划留在聊天正文')
    expect(prompt.replace(/\\/g, '/')).toContain('agent-workspaces/sample-project/session-1/.context/plan/current-plan.md')
    expect(prompt).toContain('每次获批版本另存到同目录的 `approved/` 子目录')
  })

  test('Given Direct workflow When entering Plan later Then the prompt explains the same durable current-plan entry', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('通过 `ExitPlanMode.plan` 提交完整 Markdown 计划')
    expect(prompt).toContain('current-plan.md')
    expect(prompt).toContain('并在批准后保留')
  })

  test('Given Pi Read Only When building the prompt Then sidecar writes and executable project commands are explicitly denied', () => {
    const prompt = buildSystemPrompt({
        sessionId: 'session-read-only',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'autonomous',
      workflow: 'read-only',
    })

    expect(prompt).toContain('当前持久模式：研究')
    expect(prompt).toContain('只读 Bash 命令')
    expect(prompt).toContain('纯读取可访问任意本机路径，不受 Workspace Boundary 限制')
    expect(prompt).toContain('不允许写入项目或计划 sidecar')
    expect(prompt).toContain('测试、构建、安装、发布和未知命令均拒绝')
    expect(prompt).toContain('优先批量使用 Read、Grep、Find、LS')
    expect(prompt).toContain('不要在 grep、awk、PowerShell 等解释器之间循环试错')
    expect(prompt).toContain('小调整不必强制生成完整计划')
    expect(prompt).toContain('先完成足以理解用户意图和修改范围的必要探索')
    expect(prompt).toContain('自然组织的 Markdown 反馈')
    expect(prompt).toContain('默认批准只为当前任务临时开放执行')
    expect(prompt).toContain('只有用户明确选择“切换到执行”才改变后续消息的持久模式')
    expect(prompt).toContain('范围复杂、风险较高或需要正式方案时调用 EnterPlanMode')
    expect(prompt).toContain('不要用 AskUserQuestion 要求用户手动切换')
  })


})

describe('Session Target 提示词', () => {
  test('Given Pi Local Target When 构建提示词 Then 明示 Local 语义并禁止手工切换 checkout', () => {
    const prompt = buildSystemPrompt({
        sessionId: 'session-local',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      worktreeHandoffAvailable: true,
      sessionTarget: { kind: 'local', ownership: 'owner' },
    })

    expect(prompt).toContain('当前 Session Target：Local Checkout')
    expect(prompt).toContain('本身也可能是 Git linked worktree')
    expect(prompt).toContain('不要用 `git worktree add`')
    expect(prompt).toContain('使用 `ForkToWorktree` 请求 Domi 创建 managed Worktree 子会话并自动继续')
    expect(prompt).toContain('不要让用户手工新建会话')
  })

  test('Given unattended Local Pi When 未注入 handoff tool Then 不指示调用不可用工具', () => {
    const prompt = buildSystemPrompt({
        sessionId: 'automation-local',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      sessionTarget: { kind: 'local', ownership: 'owner' },
    })
    expect(prompt).not.toContain('使用 `ForkToWorktree`')
    expect(prompt).toContain('不要用 `git worktree add`')
  })

  test('Given direct owner Isolated Target When 构建提示词 Then 仅在存在可交付变更时指引 Agent 准备验收卡', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-isolated-owner',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      worktreeApplyAvailable: true,
      sessionTarget: {
        kind: 'isolated',
        ownership: 'owner',
        deliveryBaseOid: 'a'.repeat(40),
        previousReview: {
          summary: '新增完整工作动态侧栏',
          suggestedCommitMessage: 'feat(electron): 添加工作动态侧栏\n\n- 展示任务分组和会话状态\n- 支持悬浮预览',
        },
      },
    })

    expect(prompt).toContain('按可交付变更决定是否生成验收卡')
    expect(prompt).toContain('只有当前 owner Isolated Worktree 相对交付基线存在文件/内容变更')
    expect(prompt).toContain('最终没有可交付文件变更的任务，直接正常回复')
    expect(prompt).toContain('宿主会拒绝 0 个可交付变更的 `ReadyForReview`')
    expect(prompt).toContain('本轮交付基线')
    expect(prompt).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(prompt).toContain('用户可见的 changed files、details、summary 和 suggestedCommitMessage')
    expect(prompt).toContain('本轮原始交付基线')
    expect(prompt).toContain('当前 turn 的宿主 Apply 冲突续跑明确给出一个 Local HEAD')
    expect(prompt).toContain('该 HEAD 立即成为本次有效验收基线')
    expect(prompt).toContain('主要功能必须保持在标题和主要 bullets')
    expect(prompt).toContain('最后一次顺序、文案或样式微调只能作为次要项')
    expect(prompt).toContain('不能仅根据最后一条用户消息')
    expect(prompt).toContain('上一版验收仅是辅助线索，不是最终结论')
    expect(prompt).toContain('新增完整工作动态侧栏')
    expect(prompt).toContain('需要验收时，把 `ReadyForReview` 作为本轮最后一个、单独的工具调用')
    expect(prompt).toContain('只生成“同步到 Local 验收”卡')
    expect(prompt).toContain('详细内容进入正文，卡片只放标题和摘要')
    expect(prompt).toContain('验收工具的 `details` 参数')
    expect(prompt).toContain('宿主会把 `details` 确定性渲染为会话正文')
    expect(prompt).toContain('正常完成不要调用 `ApplyWorktree`')
    expect(prompt).toContain('Apply 冲突')
    expect(prompt).toContain('重新调用 `ReadyForReview`')
    expect(prompt).toContain('不要再次调用 `ApplyWorktree`')
    expect(prompt).toContain('才调用 `FinishWorktree`')
    expect(prompt).toContain('直接 `FinishWorktree` 也使用同一有效验收范围')
    expect(prompt).toContain('未交付 checkpoints、已提交、暂存、未暂存和未跟踪增量')
    expect(prompt).toContain('主要功能必须保持在标题和主要 bullets')
    expect(prompt).toContain('最后一次顺序、文案或样式微调只能作为次要项')
    expect(prompt).toContain('不得拼接阶段 Commit Message')
    expect(prompt).toContain('用户当前对话的主要语言')
    expect(prompt).toContain('简洁标题 + 空行 + 2–5 条')
    expect(prompt).toContain('可编辑的“提交并清理”确认')
  })

  test('Given Apply conflict was resolved by merging Local HEAD When building the prompt Then review summary excludes features already present in Local', () => {
    const originalBaseOid = 'a'.repeat(40)
    const integratedLocalHeadOid = 'b'.repeat(40)
    const prompt = buildSystemPrompt({
      sessionId: 'session-integrated-local',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      worktreeApplyAvailable: true,
      sessionTarget: {
        kind: 'isolated',
        ownership: 'owner',
        deliveryBaseOid: originalBaseOid,
        reviewBaseOid: integratedLocalHeadOid,
        reviewBaseStrategy: 'isolated_contains_local_head',
        reviewLocalHeadOid: integratedLocalHeadOid,
        previousReview: {
          summary: '精简上下文用量面板',
          suggestedCommitMessage: 'refactor(ui): 精简上下文用量面板',
          changedFiles: ['apps/electron/src/renderer/components/agent/ContextUsageBadge.tsx'],
        },
      },
    })

    expect(prompt).toContain(`本轮原始交付基线是 \`${originalBaseOid}\``)
    expect(prompt).toContain(`宿主确认的有效验收基线 \`${integratedLocalHeadOid}\``)
    expect(prompt).toContain(`对应已整合的 Local HEAD \`${integratedLocalHeadOid}\``)
    expect(prompt).toContain('不得把该有效基线中已经存在的 Local 功能、文件或提交重新写进本次验收或 Commit Message')
    expect(prompt).toContain('当前有效验收基线到最终快照的 changed files/diff')
  })

  test('Given owner Worktree has unpublished checkpoints When building the prompt Then ReadyForReview covers the cumulative delivery and manual Git checkpointing is forbidden', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-checkpointed',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      worktreeApplyAvailable: true,
      sessionTarget: { kind: 'isolated', ownership: 'owner', checkpointCount: 2 },
    })

    expect(prompt).toContain('已保存 2 个尚未交付到 Local 的阶段 checkpoint')
    expect(prompt).toContain('Preview/Finish 会包含这些阶段与当前修改的累计结果')
    expect(prompt).toContain('ReadyForReview 的变更说明、验证范围和建议 Commit Message 必须覆盖全部未交付阶段')
    expect(prompt).toContain('不要用 Bash 手工执行 git commit')
  })

  test('Given active Local Preview follow-up When 新请求需要修改 Then 先请求撤回并自动续跑', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-preview',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      sessionTarget: { kind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'preview_active' },
    })

    expect(prompt).toContain('`RequestWorktreePreviewRevision`')
    expect(prompt).toContain('安全撤回 Preview')
    expect(prompt).toContain('释放验收槽位')
    expect(prompt).toContain('不要静默撤回')
    expect(prompt).toContain('完整调整内容放入 `details`')
    expect(prompt).toContain('宿主会把 `details` 确定性渲染为会话正文')
    expect(prompt).toContain('确认卡只显示简短摘要')
    expect(prompt).toContain('不得写绝对本地路径')
    expect(prompt).toContain('当前项目的 Local Checkout')
  })

  test('Given delivered follow-up When 新请求需要修改 Then 使用结构化工具并在确认后自动续跑', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-delivered',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'full-access',
      workflow: 'direct',
      sessionTarget: { kind: 'isolated', ownership: 'owner', followupOnly: true },
    })

    expect(prompt).toContain('`RequestNextWorktreeIteration`')
    expect(prompt).toContain('自包含续跑任务')
    expect(prompt).toContain('自动续跑')
    expect(prompt).toContain('不要要求用户再回复“继续”')
    expect(prompt).toContain('完整调整内容放入 `details`')
    expect(prompt).toContain('宿主会把 `details` 确定性渲染为会话正文')
    expect(prompt).toContain('确认卡只显示简短摘要')
    expect(prompt).toContain('强制 Read Only follow-up')
    expect(prompt).toContain('不得写绝对本地路径')
    expect(prompt).toContain('[路径]')
    expect(prompt).toContain('当前项目的 Local Checkout')
  })

  test('Given Pi inherited Isolated Target When 构建提示词 Then 告知已处于 Domi Worktree 且继承自父会话', () => {
    const prompt = buildSystemPrompt({
        sessionId: 'session-isolated-child',
      permissionMode: 'bypassPermissions',
      executionPolicy: 'controlled',
      workflow: 'direct',
      sessionTarget: { kind: 'isolated', ownership: 'inherited' },
    })

    expect(prompt).toContain('当前 Session Target：Domi-managed Isolated Checkout')
    expect(prompt).toContain('继承自父会话')
    expect(prompt).toContain('已经位于专用 Git worktree')
    expect(prompt).not.toContain('使用 `ApplyWorktree`')
  })


})

describe('项目与会话工作台提示词', () => {
  test('Given 项目根 cwd When 构建提示词 Then 标明会话直接在项目中工作', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('## 项目')
    expect(prompt).toContain('项目名称: 示例项目')
    expect(prompt).toContain('当前会话直接在项目根目录中工作')
    expect(prompt).not.toContain('项目根始终是 cwd')
  })

  test('Given 历史会话工作台 cwd When 构建提示词 Then 不将它误称为项目根', () => {
    const prompt = buildPrompt('/tmp/.domi/agent-workspaces/sample-project/session-1')

    expect(prompt).toContain('当前会话仍使用私有会话工作台，不等同于项目根目录')
    expect(prompt).toContain('项目根与 cwd 不一定相同')
  })

  test('Given 项目动态上下文 When 构建消息前缀 Then 使用项目标签', () => {
    const context = buildDynamicContext({
      workspaceName: '示例项目',
      workspaceSlug: 'sample-project',
      agentCwd: '/tmp/sample-project',
    })

    expect(context).toContain('项目: 示例项目')
    expect(context).not.toContain('工作区: 示例项目')
  })
})
