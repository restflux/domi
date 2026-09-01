import { createHash, randomUUID } from 'node:crypto'
import type { GitPushSessionTrustView, SessionCapabilityGrantsChangedPayload } from '@domi/shared'
import { canonicalizePath } from './path-canonicalizer.ts'
import { parseSessionTrustEligibleGitPush } from './shell-command-classifier.ts'
import { runGitCommand } from '../git-workspace/git-command-runner.ts'

export interface GitPushSessionTrustContext {
  sessionId: string
  checkoutId: string
  repositoryRoot: string
  sourceRef: string
}

export interface GitPushSessionTrustProposal {
  view: GitPushSessionTrustView
  checkoutId: string
  repositoryRoot: string
  sourceRef: string
  targetRef: string
  remoteUrlFingerprint: string
  generation: number
}

export interface GitPushSessionTrustExecutionResult {
  ok: boolean
  grant?: GitPushSessionTrustView
  message?: string
}

type GitPushRunner = typeof runGitCommand

type GitPushSessionTrustListener = (event: SessionCapabilityGrantsChangedPayload) => void

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function trimRepositorySuffix(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
}

function describeRemote(rawUrl: string): string | null {
  const value = rawUrl.trim()
  if (!value || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\')) return null

  if (/^(?:https?|ssh):\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) return null
      const repository = trimRepositorySuffix(parsed.pathname)
      return repository ? `${parsed.hostname}/${repository}` : parsed.hostname
    } catch {
      return null
    }
  }

  const scpLike = value.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/)
  if (!scpLike) return null
  const host = scpLike[1]!
  const repository = trimRepositorySuffix(scpLike[2]!)
  return host && repository ? `${host}/${repository}` : null
}

function sourceBranch(sourceRef: string): string | null {
  if (!sourceRef.startsWith('refs/heads/')) return null
  const branch = sourceRef.slice('refs/heads/'.length)
  return branch || null
}

async function runGitRead(cwd: string, args: readonly string[], label: string): Promise<string> {
  const result = await runGitCommand(args, cwd, { timeoutMs: 5_000 })
  const value = result.stdout.trim()
  if (!result.ok || !value) throw new Error(`无法读取 ${label}`)
  return value
}

async function readOptionalGitConfig(cwd: string, key: string): Promise<string | null> {
  const result = await runGitCommand(['config', '--get', key], cwd, { timeoutMs: 5_000 })
  const value = result.stdout.trim()
  return result.ok && value ? value : null
}

async function readSinglePushUrl(cwd: string, remoteName: string): Promise<string> {
  const result = await runGitCommand(['remote', 'get-url', '--push', '--all', remoteName], cwd, { timeoutMs: 5_000 })
  const urls = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  if (!result.ok || urls.length !== 1) throw new Error('remote 必须只有唯一 push URL 才能创建会话授权')
  return urls[0]!
}

/**
 * 当前进程内的普通 push 会话授权。授权不落盘，应用重启后自然失效。
 */
export class GitPushSessionTrustService {
  private readonly grants = new Map<string, GitPushSessionTrustProposal>()
  private readonly generations = new Map<string, number>()
  private readonly listeners = new Set<GitPushSessionTrustListener>()

  constructor(private readonly pushRunner: GitPushRunner = runGitCommand) {}

  async prepare(context: GitPushSessionTrustContext): Promise<GitPushSessionTrustProposal> {
    const branch = sourceBranch(context.sourceRef)
    if (!branch) throw new Error('当前 Session Target 没有可授权的来源分支')

    const topLevel = await runGitRead(context.repositoryRoot, ['rev-parse', '--show-toplevel'], 'Git 仓库根目录')
    const repositoryRoot = await canonicalizePath(topLevel)
    const remoteName = await runGitRead(repositoryRoot, ['config', '--get', `branch.${branch}.remote`], '来源分支 remote')
    const mergeRef = await runGitRead(repositoryRoot, ['config', '--get', `branch.${branch}.merge`], '来源分支 merge ref')
    if (mergeRef !== context.sourceRef) throw new Error('来源分支配置已变化，不能创建会话授权')
    if (remoteName === '.' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remoteName)) {
      throw new Error('来源分支没有可安全授权的命名 remote')
    }

    const mirror = await readOptionalGitConfig(repositoryRoot, `remote.${remoteName}.mirror`)
    const receivePack = await readOptionalGitConfig(repositoryRoot, `remote.${remoteName}.receivepack`)
    if (mirror?.toLowerCase() === 'true' || receivePack) {
      throw new Error('remote 包含 mirror/receivepack 扩展，不能创建普通 push 会话授权')
    }

    const remoteUrl = await readSinglePushUrl(repositoryRoot, remoteName)
    const remoteDisplay = describeRemote(remoteUrl)
    if (!remoteDisplay) throw new Error('远程地址不是可安全授权的网络 Git remote')

    const ordinaryCommand = `git push ${remoteName} HEAD:${branch}`
    const parsedCommand = parseSessionTrustEligibleGitPush(ordinaryCommand)
    if (!parsedCommand || parsedCommand.destination !== context.sourceRef) {
      throw new Error('来源分支或 remote 名称不能安全表示为普通 push 命令')
    }
    const recommendedCommand = `git push --no-verify --no-follow-tags --no-push-option ${remoteName} HEAD:${branch}`
    return {
      view: {
        grantId: randomUUID(),
        kind: 'git_push_current_source',
        sessionId: context.sessionId,
        remoteName,
        remoteDisplay,
        targetBranch: branch,
        recommendedCommand,
        createdAt: Date.now(),
      },
      checkoutId: context.checkoutId,
      repositoryRoot,
      sourceRef: context.sourceRef,
      targetRef: context.sourceRef,
      remoteUrlFingerprint: fingerprint(remoteUrl),
      generation: this.generation(context.sessionId),
    }
  }

  async grant(proposal: GitPushSessionTrustProposal): Promise<GitPushSessionTrustView> {
    if (proposal.generation !== this.generation(proposal.view.sessionId)) {
      throw new Error('Git push 会话授权请求已失效，请重新请求')
    }
    const current = await this.prepare({
      sessionId: proposal.view.sessionId,
      checkoutId: proposal.checkoutId,
      repositoryRoot: proposal.repositoryRoot,
      sourceRef: proposal.sourceRef,
    })
    if (!this.sameBinding(current, proposal)) {
      throw new Error('Git push 授权目标在确认前已变化，请重新请求')
    }
    this.grants.set(proposal.view.sessionId, proposal)
    this.bumpGeneration(proposal.view.sessionId)
    this.emit(proposal.view.sessionId)
    return proposal.view
  }

  async reconcile(context: GitPushSessionTrustContext): Promise<boolean> {
    const grant = this.grants.get(context.sessionId)
    if (!grant) return false
    if (grant.checkoutId !== context.checkoutId || grant.sourceRef !== context.sourceRef) {
      this.revoke(context.sessionId, grant.view.grantId)
      return false
    }

    let current: GitPushSessionTrustProposal
    try {
      current = await this.prepare(context)
    } catch {
      this.revoke(context.sessionId, grant.view.grantId)
      return false
    }
    if (!this.sameBinding(current, grant)) {
      this.revoke(context.sessionId, grant.view.grantId)
      return false
    }
    return true
  }

  async execute(context: GitPushSessionTrustContext): Promise<GitPushSessionTrustExecutionResult> {
    if (!await this.reconcile(context)) {
      return { ok: false, message: '普通 Git push 会话授权不存在或已失效。' }
    }
    const grant = this.grants.get(context.sessionId)
    if (!grant) return { ok: false, message: '普通 Git push 会话授权不存在或已失效。' }

    const result = await this.pushRunner([
      'push',
      '--no-verify',
      '--no-follow-tags',
      '--no-push-option',
      grant.view.remoteName,
      `HEAD:${grant.targetRef}`,
    ], grant.repositoryRoot, { timeoutMs: 60_000 })
    return result.ok
      ? { ok: true, grant: grant.view }
      : { ok: false, message: `普通 Git push 失败（exit ${result.exitCode ?? 'unknown'}）` }
  }

  list(sessionId: string): GitPushSessionTrustView[] {
    const grant = this.grants.get(sessionId)
    return grant ? [{ ...grant.view }] : []
  }

  revoke(sessionId: string, grantId: string): boolean {
    const grant = this.grants.get(sessionId)
    if (!grant || grant.view.grantId !== grantId) return false
    this.grants.delete(sessionId)
    this.bumpGeneration(sessionId)
    this.emit(sessionId)
    return true
  }

  clear(sessionId: string): void {
    const changed = this.grants.delete(sessionId)
    this.bumpGeneration(sessionId)
    if (changed) this.emit(sessionId)
  }

  subscribe(listener: GitPushSessionTrustListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private generation(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0
  }

  private bumpGeneration(sessionId: string): void {
    this.generations.set(sessionId, this.generation(sessionId) + 1)
  }

  private sameBinding(left: GitPushSessionTrustProposal, right: GitPushSessionTrustProposal): boolean {
    return left.view.sessionId === right.view.sessionId
      && left.checkoutId === right.checkoutId
      && left.repositoryRoot === right.repositoryRoot
      && left.sourceRef === right.sourceRef
      && left.targetRef === right.targetRef
      && left.view.remoteName === right.view.remoteName
      && left.remoteUrlFingerprint === right.remoteUrlFingerprint
  }

  private emit(sessionId: string): void {
    const event = { sessionId, grants: this.list(sessionId) }
    for (const listener of this.listeners) listener(event)
  }
}

export const gitPushSessionTrustService = new GitPushSessionTrustService()
