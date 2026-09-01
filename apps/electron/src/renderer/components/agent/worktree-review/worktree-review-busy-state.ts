import type { SessionCheckoutAction } from '@domi/shared'

export function worktreeOperationBusyLabel(action: SessionCheckoutAction): string {
  switch (action) {
    case 'preview':
      return '正在创建预览…'
    case 'checkpoint':
      return '正在保存进度…'
    case 'rollback_preview':
      return '正在撤回预览…'
    case 'finish':
    case 'finalize_preview':
      return '正在保存修改…'
    case 'retry_cleanup':
      return '正在清理环境…'
    case 'discard':
      return '正在放弃任务…'
    case 'recover':
      return '正在恢复预览…'
    case 'release_collaborator':
    case 'release_collaborators':
      return '正在结束协作占用…'
    case 'apply':
      return '正在同步修改…'
  }
}
