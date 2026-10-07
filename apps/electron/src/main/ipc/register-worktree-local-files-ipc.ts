import {
  WORKTREE_LOCAL_FILES_IPC_CHANNELS as CHANNELS,
  type WorktreeLocalFileOverwrite,
  type WorktreeLocalFilesResult,
} from '@domi/shared'
import type { WorktreeLocalFilesProject, WorktreeLocalFilesService } from '../lib/worktree-local-files/service.ts'
import type { SessionCheckoutModule } from '../lib/session-checkout/index.ts'

interface IpcEvent {
  sender: { id: number }
  senderFrame?: unknown
}
interface Registrar {
  handle(channel: string, listener: (event: IpcEvent, input: unknown) => unknown): void
}
export interface WorktreeLocalFilesIpcOptions {
  service: Pick<WorktreeLocalFilesService, 'inspect' | 'save' | 'confirm' | 'listDirectory' | 'resolveSelection'>
  checkout: Pick<SessionCheckoutModule, 'runExclusiveProjectConfiguration' | 'inspectLocalFilesTarget' | 'prepareLocalFiles'>
  resolveProject(projectId: string): WorktreeLocalFilesProject
  assertSender(event: IpcEvent): void | Promise<void>
  assertProjectIdle(projectId: string): void
}

function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input)
}
function text(value: unknown, maximum = 1000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
}
function keys(input: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(input, key))
    && Object.keys(input).every((key) => required.includes(key) || optional.includes(key))
}
function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every((entry: unknown) => text(entry, 1024))
}
function overwrites(value: unknown): value is WorktreeLocalFileOverwrite[] {
  return Array.isArray(value) && value.length <= 128 && value.every((item: unknown) => record(item)
    && keys(item, ['path', 'expectedFingerprint']) && text(item.path, 1024) && text(item.expectedFingerprint))
}

/** 只有可信应用主窗口可发起；Main 解析项目/checkout，Renderer 不指定源/目标根。 */
export function registerWorktreeLocalFilesIpc(ipc: Registrar, options: WorktreeLocalFilesIpcOptions): void {
  const register = <T>(channel: string, run: (input: Record<string, unknown>) => Promise<T>): void => {
    ipc.handle(channel, async (event, raw): Promise<WorktreeLocalFilesResult<T>> => {
      try {
        await options.assertSender(event)
        if (!record(raw)) throw new Error('无效的本地配置请求')
        return { ok: true, value: await run(raw) }
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'invalid_input'
        return { ok: false, error: { code, message: error instanceof Error ? error.message : '本地配置操作失败，请重试' } }
      }
    })
  }
  const requireProject = (input: Record<string, unknown>, required: string[], optional: string[] = []): WorktreeLocalFilesProject => {
    if (!keys(input, ['projectId', ...required], optional) || !text(input.projectId)) throw new Error('无效的项目请求')
    return options.resolveProject(input.projectId)
  }
  const configure = async <T>(project: WorktreeLocalFilesProject, operation: () => Promise<T>): Promise<T> => {
    if (!options.checkout.runExclusiveProjectConfiguration) throw new Error('本地配置保存服务不可用')
    return options.checkout.runExclusiveProjectConfiguration(project.id, async () => {
      options.assertProjectIdle(project.id)
      return operation()
    })
  }
  register(CHANNELS.INSPECT, async (input) => {
    const project = requireProject(input, [], ['sessionId'])
    if (input.sessionId !== undefined && !text(input.sessionId)) throw new Error('无效的会话请求')
    const view = await options.service.inspect(project)
    const target = typeof input.sessionId === 'string'
      ? await options.checkout.inspectLocalFilesTarget?.(input.sessionId, project.id, view.entries.map((entry) => entry.path)) : undefined
    return { ...view, ...(target ? { target } : {}) }
  })
  register(CHANNELS.LIST_DIRECTORY, async (input) => {
    const project = requireProject(input, ['directory'], ['query'])
    if (typeof input.directory !== 'string' || input.directory.length > 1024 || input.directory.includes('\0')
      || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 128 || input.query.includes('\0')))) throw new Error('无效的文件夹或搜索请求')
    return options.service.listDirectory(project, input.directory, typeof input.query === 'string' ? input.query : '')
  })
  register(CHANNELS.RESOLVE_SELECTION, async (input) => {
    const project = requireProject(input, ['paths', 'existingPaths'])
    if (!paths(input.paths) || !paths(input.existingPaths)) throw new Error('无效的文件选择请求')
    return options.service.resolveSelection(project, input.paths, input.existingPaths)
  })
  register(CHANNELS.SAVE, async (input) => {
    const project = requireProject(input, ['expectedVersion', 'paths'])
    if (!text(input.expectedVersion) || !paths(input.paths)) throw new Error('无效的文件清单')
    const version = input.expectedVersion
    const selected = input.paths
    return configure(project, () => options.service.save(project, selected, version))
  })
  register(CHANNELS.CONFIRM, async (input) => {
    const project = requireProject(input, ['expectedVersion'])
    if (!text(input.expectedVersion)) throw new Error('无效的清单版本')
    const version = input.expectedVersion
    return configure(project, () => options.service.confirm(project, version))
  })
  register(CHANNELS.PREPARE, async (input) => {
    if (!keys(input, ['sessionId', 'expectedRevision'], ['overwriteFiles']) || !text(input.sessionId)
      || typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || (input.overwriteFiles !== undefined && !overwrites(input.overwriteFiles))) throw new Error('无效的配置准备请求')
    if (!options.checkout.prepareLocalFiles) throw new Error('本地配置准备服务不可用')
    return options.checkout.prepareLocalFiles(input.sessionId, input.expectedRevision, input.overwriteFiles as WorktreeLocalFileOverwrite[] | undefined)
  })
}
