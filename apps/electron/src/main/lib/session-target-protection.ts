import { canonicalizePath } from './execution-policy/path-canonicalizer.ts'
import { isWithinWorkspace, resolvePortablePath } from './execution-policy/workspace-boundary.ts'
import { resolveReadOnlyToolAccess, type PlanToolCall, type PlanToolAccessDecision } from './agent-workflow-policy.ts'

/** 交付保护独立于工作方式；允许会话操作，但不把未知工具或任意脚本当成只读诊断。 */
export async function resolveProtectedTargetAccess(
  call: PlanToolCall,
  sessionWorkbenchRoot?: string,
): Promise<PlanToolAccessDecision> {
  const name = call.toolName.toLowerCase()
  if (call.toolSource === 'host' && ['enterplanmode', 'exitplanmode', 'requestdirectworkflow'].includes(name)) {
    return { outcome: 'allow', reason: '工作方式审批不解除项目保护' }
  }
  if (call.toolSource === 'product' && [
    'requestnextworktreeiteration', 'requestworktreepreviewrevision',
    'terminallist', 'terminalread', 'terminalinterrupt', 'terminalclose',
  ].includes(name)) {
    return { outcome: 'allow', reason: '宿主管理的会话操作仍由各自授权入口验证' }
  }
  if (call.toolSource === 'host' && (name === 'write' || name === 'edit') && sessionWorkbenchRoot) {
    const path = call.input.file_path ?? call.input.path
    if (typeof path === 'string') {
      try {
        const target = await canonicalizePath(resolvePortablePath(path, call.cwd))
        const workbench = await canonicalizePath(sessionWorkbenchRoot)
        const project = await canonicalizePath(call.cwd)
        if (isWithinWorkspace(target, workbench) && !isWithinWorkspace(target, project)) {
          return { outcome: 'allow', reason: '只修改会话工作台，不修改受保护项目' }
        }
      } catch { /* 路径无法证明安全时保守拒绝。 */ }
    }
  }
  // PTY 尚无 Bash spawnHook 的只读环境加固，交付后不能通过终端绕过这层保护。
  if (name === 'terminalrun') {
    return { outcome: 'deny', reason: '项目受交付或验收保护，诊断请使用 Bash 的只读命令；启动服务或项目修改需要开启下一轮。' }
  }
  const readAccess = resolveReadOnlyToolAccess(call)
  if (readAccess.outcome === 'allow') return readAccess
  return {
    outcome: 'deny',
    reason: '当前项目处于交付或验收保护中；执行授权不解除项目保护。此操作无法证明不会修改项目，请改用明确只读的查询工具；确需修改项目时调用 RequestNextWorktreeIteration，验收中调用 RequestWorktreePreviewRevision。',
  }
}
