import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, relative } from 'node:path'
import { canonicalRoot } from './filesystem'
import { WorktreeLocalFilesError } from './errors'

const execute = promisify(execFile)

async function git(root: string, args: readonly string[], allowMissingHead = false): Promise<string> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith('GIT_')) env[key] = value
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null'
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile,
    GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C', LANG: 'C',
  })
  try {
    const result = await execute('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${nullFile}`, ...args], {
      cwd: root, env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    })
    return result.stdout
  } catch (error) {
    if (allowMissingHead && error instanceof Error && 'code' in error && error.code === 1) return ''
    throw new WorktreeLocalFilesError('git_check_failed', '无法安全检查本地文件的 Git 管理状态')
  }
}

export interface LocalFilesGitState { isTracked(path: string): boolean }

/** 单次枚举共享同一份有界 index/HEAD 检查，不为每个文件启动 Git。 */
export async function readLocalFilesGitState(root: string, targetHeadOid?: string): Promise<LocalFilesGitState> {
  if (targetHeadOid !== undefined && !/^[0-9a-f]{40,64}$/i.test(targetHeadOid)) throw new WorktreeLocalFilesError('git_check_failed', '目标分支提交身份无效')
  const repositoryRoot = await canonicalRoot((await git(root, ['rev-parse', '--show-toplevel'])).trim())
  const prefix = relative(repositoryRoot, root).replace(/\\/g, '/')
  if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) {
    throw new WorktreeLocalFilesError('invalid_root', '项目根目录不属于当前 Git 仓库')
  }
  const portable = (path: string): string => path.normalize('NFD').toLowerCase()
  const index = await git(repositoryRoot, ['ls-files', '--cached', '-z'])
  const head = targetHeadOid ?? await git(repositoryRoot, ['rev-parse', '--quiet', '--verify', 'HEAD'], true)
  const committed = head ? await git(repositoryRoot, ['ls-tree', '-r', '--name-only', '-z', head.trim()]) : ''
  const tracked = new Set([...index.split('\0'), ...committed.split('\0')].filter(Boolean).map(portable))
  return {
    isTracked(path) {
      const fullPath = prefix ? `${prefix}/${path}` : path
      return fullPath.split('/').some((_, index, parts) => tracked.has(portable(parts.slice(0, index + 1).join('/'))))
    },
  }
}

export async function assertUntracked(root: string, paths: readonly string[], targetHeadOid?: string): Promise<void> {
  const state = await readLocalFilesGitState(root, targetHeadOid)
  if (paths.some(path => state.isTracked(path))) {
    throw new WorktreeLocalFilesError('tracked_file', '不能准备由 Git 管理的源文件或目标文件')
  }
}
